import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path, { basename } from "node:path";
import { fileURLToPath } from "node:url";

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import { discoverAgents } from "./agents.mjs";

const ScopeParam = StringEnum(["project", "user", "both"] as const);

const ListAgentsParams = Type.Object({
  scope: Type.Optional(
    ScopeParam,
  ),
});

const SpawnAgentParams = Type.Object({
  agent: Type.String({
    description: "Name of the subagent to spawn. Use list_agents first if needed.",
  }),
  task: Type.String({
    description: "Delegated task for the subagent.",
  }),
  scope: Type.Optional(
    ScopeParam,
  ),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory for the child terminal. Defaults to the current project cwd.",
    }),
  ),
  label: Type.Optional(
    Type.String({
      description: "Optional terminal label override.",
    }),
  ),
});

const WaitAgentParams = Type.Object({
  terminalId: Type.String({
    description: "Terminal ID returned from spawn_agent.",
  }),
  timeoutSeconds: Type.Optional(
    Type.Number({
      description: "How long to wait before timing out. Defaults to 300 seconds.",
      minimum: 1,
      maximum: 600,
    }),
  ),
});

const ReadAgentOutputParams = Type.Object({
  terminalId: Type.String({
    description: "Terminal ID returned from spawn_agent.",
  }),
});

const GetAgentResultParams = Type.Object({
  terminalId: Type.String({
    description: "Terminal ID returned from spawn_agent.",
  }),
});

function toTextResult(text: string, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function formatAgentDescriptions(
  agents: Array<{
    name: string;
    description: string;
    source: string;
    tools?: string[];
  }>,
): string {
  if (agents.length === 0) {
    return "No subagents discovered.";
  }

  return agents
    .map((agent) => {
      const tools =
        agent.tools && agent.tools.length > 0
          ? ` tools=${agent.tools.join(",")}`
          : "";
      return `- ${agent.name} (${agent.source}): ${agent.description}${tools}`;
    })
    .join("\n");
}

function getScope(scope?: "project" | "user" | "both") {
  return scope ?? "both";
}

function getSpawnHeaders() {
  const spawnUrl = process.env.TERMINAL_CANVAS_SPAWN_URL;
  const token = process.env.TERMINAL_CANVAS_ATTENTION_TOKEN;
  const sessionId = process.env.TERMINAL_CANVAS_SESSION_ID;

  if (!spawnUrl || !token) {
    throw new Error(
      "This extension must run inside a terminal-sheet terminal with TERMINAL_CANVAS_SPAWN_URL and TERMINAL_CANVAS_ATTENTION_TOKEN set.",
    );
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-terminal-canvas-token": token,
  };

  if (sessionId) {
    headers["x-terminal-canvas-session-id"] = sessionId;
  }

  return { spawnUrl, headers };
}

async function fetchSpawnJson(
  url: string,
  options: {
    method?: string;
    headers: Record<string, string>;
    body?: Record<string, unknown>;
  },
) {
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: options.headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status}: ${text}`);
  }

  return response.json();
}

function truncate(text: string, maxLength = 12000): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 18)}\n...[truncated]`;
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function quoteShellArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function encodePayload(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function getPiInvocationBase() {
  const currentScript = process.argv[1];

  if (currentScript && existsSync(currentScript)) {
    return {
      command: process.execPath,
      args: [currentScript],
    };
  }

  const execName = basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);

  if (!isGenericRuntime) {
    return {
      command: process.execPath,
      args: [] as string[],
    };
  }

  return {
    command: "pi",
    args: [] as string[],
  };
}

function getNodeCommand() {
  const execName = basename(process.execPath).toLowerCase();
  return /^(node|bun)(\.exe)?$/.test(execName) ? process.execPath : "node";
}

export default function (pi: ExtensionAPI) {
  const extensionDir = path.dirname(fileURLToPath(import.meta.url));
  const runnerPath = path.join(extensionDir, "run-subagent.mjs");

  pi.registerTool({
    name: "list_agents",
    label: "List Agents",
    description:
      "List discovered pi subagents from project-local .pi/agents and user-level ~/.pi/agent/agents.",
    promptSnippet: "List available subagents before delegating if agent names are unclear.",
    parameters: ListAgentsParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const scope = getScope(params.scope);
      const { agents, projectAgentsDir } = discoverAgents(ctx.cwd, scope);

      const text =
        agents.length > 0
          ? formatAgentDescriptions(agents)
          : "No subagents found. Add markdown files to .pi/agents or ~/.pi/agent/agents.";

      return toTextResult(text, {
        scope,
        projectAgentsDir,
        agents,
      });
    },

    renderCall(args, theme) {
      const text =
        theme.fg("toolTitle", theme.bold("list_agents ")) +
        theme.fg("muted", args.scope ?? "both");
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, _theme) {
      const text = result.content[0];
      return new Text(text?.type === "text" ? text.text : "", 0, 0);
    },
  });

  pi.registerTool({
    name: "spawn_agent",
    label: "Spawn Agent",
    description:
      "Spawn a named pi subagent in a visible terminal-sheet terminal. Use this for parallel, visible delegation instead of hidden subprocesses.",
    promptSnippet:
      "Spawn a named subagent in a visible terminal-sheet terminal.",
    promptGuidelines: [
      "Call list_agents first if you are unsure which subagent name to use.",
      "For parallel work, call spawn_agent multiple times before waiting on results.",
      "After spawning, use wait_agent and get_agent_result to synchronize and collect structured output.",
    ],
    parameters: SpawnAgentParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const scope = getScope(params.scope);
      const cwd = params.cwd?.trim() || ctx.cwd;
      const { agents } = discoverAgents(cwd, scope);
      const agent = agents.find((candidate) => candidate.name === params.agent);

      if (!agent) {
        const available =
          agents.length > 0 ? agents.map((candidate) => candidate.name).join(", ") : "none";
        return toTextResult(
          `Unknown subagent "${params.agent}". Available agents: ${available}.`,
          {
            error: "unknown_agent",
            availableAgents: agents,
          },
        );
      }

      const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-tsheet-subagent-"));

      try {
        const taskFilePath = path.join(tempDir, "task.txt");
        await writeFile(taskFilePath, params.task, { encoding: "utf8", mode: 0o600 });

        const payload = encodePayload({
          agentName: params.agent,
          scope,
          cwd,
          taskFilePath,
          invocation: getPiInvocationBase(),
        });

        const command = [
          quoteShellArg(getNodeCommand()),
          quoteShellArg(runnerPath),
          "--payload",
          quoteShellArg(payload),
        ].join(" ");

        const { spawnUrl, headers } = getSpawnHeaders();
        const response = (await fetchSpawnJson(spawnUrl, {
          method: "POST",
          headers,
          body: {
            command,
            label: params.label?.trim() || `pi:${params.agent}`,
            cwd,
            agentType: "shell",
            tags: ["pi-subagent", params.agent],
          },
        })) as { terminalId: string; sessionId: string };

        return toTextResult(
          `Spawned ${params.agent} in terminal ${response.terminalId}.`,
          {
            terminalId: response.terminalId,
            sessionId: response.sessionId,
            agent: params.agent,
            scope,
            cwd,
            label: params.label?.trim() || `pi:${params.agent}`,
          },
        );
      } catch (error) {
        await rm(tempDir, { recursive: true, force: true });
        const message = error instanceof Error ? error.message : String(error);
        return toTextResult(`Failed to spawn ${params.agent}: ${message}`, {
          error: message,
        });
      }
    },

    renderCall(args, theme) {
      let text =
        theme.fg("toolTitle", theme.bold("spawn_agent ")) +
        theme.fg("accent", args.agent);

      if (args.cwd) {
        text += theme.fg("dim", ` @ ${args.cwd}`);
      }

      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const details = (result.details ?? {}) as Record<string, unknown>;
      const message =
        result.content[0]?.type === "text" ? result.content[0].text : "";

      if (typeof details.error === "string") {
        return new Text(theme.fg("error", message), 0, 0);
      }

      return new Text(theme.fg("success", message), 0, 0);
    },
  });

  pi.registerTool({
    name: "wait_agent",
    label: "Wait Agent",
    description:
      "Wait for a terminal-sheet spawned subagent to exit, using the terminal ID returned from spawn_agent.",
    parameters: WaitAgentParams,

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const { spawnUrl, headers } = getSpawnHeaders();
        const timeoutSeconds = Math.max(
          1,
          Math.min(600, Math.trunc(params.timeoutSeconds ?? 300)),
        );
        const response = (await fetchSpawnJson(
          `${spawnUrl}/${encodeURIComponent(params.terminalId)}/wait?timeout=${timeoutSeconds}`,
          {
            headers: {
              "x-terminal-canvas-token": headers["x-terminal-canvas-token"],
            },
          },
        )) as {
          terminalId: string;
          exitCode: number | null;
          timedOut: boolean;
        };

        const text = response.timedOut
          ? `Terminal ${response.terminalId} is still running after ${timeoutSeconds}s.`
          : `Terminal ${response.terminalId} exited with code ${String(response.exitCode)}.`;

        return toTextResult(text, response);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return toTextResult(`Failed to wait for ${params.terminalId}: ${message}`, {
          error: message,
        });
      }
    },

    renderCall(args, theme) {
      const text =
        theme.fg("toolTitle", theme.bold("wait_agent ")) +
        theme.fg("muted", args.terminalId);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      const details = (result.details ?? {}) as Record<string, unknown>;
      const color =
        details.timedOut === true || typeof details.error === "string"
          ? "warning"
          : "success";
      return new Text(theme.fg(color, text), 0, 0);
    },
  });

  pi.registerTool({
    name: "read_agent_output",
    label: "Read Agent Output",
    description:
      "Read the raw terminal output from a spawned terminal-sheet subagent.",
    parameters: ReadAgentOutputParams,

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const { spawnUrl, headers } = getSpawnHeaders();
        const response = (await fetchSpawnJson(
          `${spawnUrl}/${encodeURIComponent(params.terminalId)}/read`,
          {
            headers: {
              "x-terminal-canvas-token": headers["x-terminal-canvas-token"],
            },
          },
        )) as {
          terminalId: string;
          scrollback: string;
          lastOutputLine: string | null;
          exitCode: number | null;
        };

        const text =
          response.lastOutputLine?.trim() ||
          truncate(response.scrollback || "(no output)");

        return toTextResult(text, response);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return toTextResult(`Failed to read ${params.terminalId}: ${message}`, {
          error: message,
        });
      }
    },

    renderCall(args, theme) {
      const text =
        theme.fg("toolTitle", theme.bold("read_agent_output ")) +
        theme.fg("muted", args.terminalId);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, _theme) {
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      return new Text(text, 0, 0);
    },
  });

  pi.registerTool({
    name: "get_agent_result",
    label: "Get Agent Result",
    description:
      "Read structured JSON results posted by a spawned terminal-sheet subagent.",
    parameters: GetAgentResultParams,

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const { spawnUrl, headers } = getSpawnHeaders();
        const response = (await fetchSpawnJson(
          `${spawnUrl}/${encodeURIComponent(params.terminalId)}/result`,
          {
            headers: {
              "x-terminal-canvas-token": headers["x-terminal-canvas-token"],
            },
          },
        )) as {
          terminalId: string;
          hasResult: boolean;
          data?: unknown;
        };

        const text = response.hasResult
          ? formatJson(response.data)
          : `Terminal ${response.terminalId} has not posted a structured result yet.`;

        return toTextResult(truncate(text, 16000), response);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return toTextResult(`Failed to get result for ${params.terminalId}: ${message}`, {
          error: message,
        });
      }
    },

    renderCall(args, theme) {
      const text =
        theme.fg("toolTitle", theme.bold("get_agent_result ")) +
        theme.fg("muted", args.terminalId);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, _theme) {
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      return new Text(text, 0, 0);
    },
  });
}
