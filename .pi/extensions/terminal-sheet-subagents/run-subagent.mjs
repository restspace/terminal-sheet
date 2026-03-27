import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { discoverAgents } from "./agents.mjs";

const DEFAULT_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  turns: 0,
};

function decodePayload(encodedPayload) {
  return JSON.parse(
    Buffer.from(encodedPayload, "base64url").toString("utf8"),
  );
}

function extractAssistantText(message) {
  if (!message || !Array.isArray(message.content)) {
    return "";
  }

  return message.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function applyUsage(usage, nextUsage) {
  if (!nextUsage || typeof nextUsage !== "object") {
    return;
  }

  usage.input += Number(nextUsage.input ?? 0);
  usage.output += Number(nextUsage.output ?? 0);
  usage.cacheRead += Number(nextUsage.cacheRead ?? 0);
  usage.cacheWrite += Number(nextUsage.cacheWrite ?? 0);
  usage.cost += Number(nextUsage.cost ?? 0);
}

async function postStructuredResult(data) {
  const resultUrl = process.env.TERMINAL_CANVAS_RESULT_URL;
  const token = process.env.TERMINAL_CANVAS_ATTENTION_TOKEN;

  if (!resultUrl || !token) {
    return;
  }

  try {
    const response = await fetch(resultUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-terminal-canvas-token": token,
      },
      body: JSON.stringify({ data }),
    });

    if (!response.ok) {
      const text = await response.text();
      process.stderr.write(
        `[subagent] failed to post result (${response.status}): ${text}\n`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[subagent] failed to post result: ${message}\n`);
  }
}

function flushBufferedJsonLines(buffer, onLine, flushRemainder = false) {
  let remainder = buffer;

  while (true) {
    const newlineIndex = remainder.indexOf("\n");
    if (newlineIndex === -1) {
      break;
    }

    const line = remainder.slice(0, newlineIndex).replace(/\r$/, "");
    remainder = remainder.slice(newlineIndex + 1);
    onLine(line);
  }

  if (flushRemainder && remainder.trim()) {
    onLine(remainder.replace(/\r$/, ""));
    return "";
  }

  return remainder;
}

async function main() {
  const { values } = parseArgs({
    allowPositionals: false,
    options: {
      payload: {
        type: "string",
      },
    },
  });

  if (!values.payload) {
    throw new Error("Missing --payload");
  }

  const payload = decodePayload(values.payload);
  const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
  const scope =
    payload.scope === "project" || payload.scope === "user"
      ? payload.scope
      : "both";

  const cleanupPaths = [];
  const cleanupDirs = [];
  let promptDir = null;
  let exitCode = 0;

  try {
    const task = await readFile(payload.taskFilePath, "utf8");
    cleanupPaths.push(payload.taskFilePath);
    cleanupDirs.push(path.dirname(payload.taskFilePath));

    const { agents } = discoverAgents(cwd, scope);
    const agent = agents.find((candidate) => candidate.name === payload.agentName);

    if (!agent) {
      const availableAgents =
        agents.length > 0 ? agents.map((candidate) => candidate.name).join(", ") : "none";
      const data = {
        agent: payload.agentName,
        task: task.trim(),
        exitCode: 1,
        finalText: "",
        stderr: `Unknown agent "${payload.agentName}". Available agents: ${availableAgents}.`,
        usage: DEFAULT_USAGE,
      };
      await postStructuredResult(data);
      process.stderr.write(`${data.stderr}\n`);
      exitCode = 1;
      return;
    }

    process.stdout.write(
      `[subagent] ${agent.name} (${agent.source}) starting in ${cwd}\n`,
    );

    const invocation = payload.invocation;
    const args = [...(Array.isArray(invocation?.args) ? invocation.args : [])];

    if (agent.systemPrompt) {
      promptDir = await mkdtemp(path.join(os.tmpdir(), "pi-tsheet-subagent-"));
      const promptPath = path.join(promptDir, `${agent.name}-system-prompt.md`);
      await writeFile(promptPath, agent.systemPrompt, { encoding: "utf8", mode: 0o600 });
      args.push("--append-system-prompt", promptPath);
      cleanupPaths.push(promptPath);
    }

    args.push("--mode", "json", "-p", "--no-session");

    if (agent.model) {
      args.push("--model", agent.model);
    }

    if (agent.tools && agent.tools.length > 0) {
      args.push("--tools", agent.tools.join(","));
    }

    args.push(`Task: ${task.trim()}`);

    const result = {
      agent: agent.name,
      agentSource: agent.source,
      task: task.trim(),
      exitCode: 1,
      finalText: "",
      stderr: "",
      messages: [],
      model: agent.model,
      stopReason: undefined,
      usage: { ...DEFAULT_USAGE },
    };

    let stdoutBuffer = "";
    let assistantStreamOpen = false;

    const proc = spawn(invocation?.command ?? "pi", args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const closeAssistantStream = () => {
      if (assistantStreamOpen) {
        process.stdout.write("\n");
        assistantStreamOpen = false;
      }
    };

    const handleJsonLine = (line) => {
      if (!line.trim()) {
        return;
      }

      let event;

      try {
        event = JSON.parse(line);
      } catch {
        process.stdout.write(`${line}\n`);
        return;
      }

      if (event.type === "message_update") {
        const delta =
          event.assistantMessageEvent?.type === "text_delta" &&
          typeof event.assistantMessageEvent.delta === "string"
            ? event.assistantMessageEvent.delta
            : "";

        if (delta) {
          process.stdout.write(delta);
          assistantStreamOpen = true;
          result.finalText += delta;
        }
        return;
      }

      if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
        closeAssistantStream();
        process.stdout.write(`[tool] ${event.toolName}\n`);
        return;
      }

      if (event.type === "message_end" && event.message?.role === "assistant") {
        const message = event.message;
        result.messages.push(message);
        applyUsage(result.usage, message.usage ?? event.usage);
        result.usage.turns += 1;

        if (event.provider && event.model) {
          result.model = `${event.provider}/${event.model}`;
        }

        const finalText = extractAssistantText(message);

        if (!result.finalText.trim() && finalText) {
          process.stdout.write(`${finalText}\n`);
          result.finalText = finalText;
        } else {
          closeAssistantStream();
        }

        if (!result.stopReason && typeof message.stopReason === "string") {
          result.stopReason = message.stopReason;
        }

        return;
      }

      if (event.type === "agent_end") {
        closeAssistantStream();

        if (typeof event.stopReason === "string") {
          result.stopReason = event.stopReason;
        }

        if (event.provider && event.model) {
          result.model = `${event.provider}/${event.model}`;
        }

        return;
      }

      if (event.type === "error") {
        closeAssistantStream();
        const errorText = typeof event.error === "string" ? event.error : JSON.stringify(event);
        process.stderr.write(`[error] ${errorText}\n`);
      }
    };

    proc.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      stdoutBuffer = flushBufferedJsonLines(stdoutBuffer, handleJsonLine);
    });

    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      result.stderr += text;
      process.stderr.write(text);
    });

    const childExitCode = await new Promise((resolve, reject) => {
      proc.on("close", resolve);
      proc.on("error", reject);
    });

    flushBufferedJsonLines(stdoutBuffer, handleJsonLine, true);
    closeAssistantStream();

    result.exitCode = typeof childExitCode === "number" ? childExitCode : 1;
    await postStructuredResult(result);
    exitCode = result.exitCode;
  } finally {
    for (const cleanupPath of cleanupPaths.reverse()) {
      try {
        await unlink(cleanupPath);
      } catch {
        // Ignore cleanup failures.
      }
    }
    for (const cleanupDir of cleanupDirs.reverse()) {
      try {
        await rm(cleanupDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup failures.
      }
    }

    if (promptDir) {
      try {
        await rm(promptDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup failures.
      }
    }
  }

  process.exitCode = exitCode;
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[subagent] ${message}\n`);
  await postStructuredResult({
    exitCode: 1,
    finalText: "",
    stderr: message,
    usage: DEFAULT_USAGE,
  });
  process.exit(1);
});
