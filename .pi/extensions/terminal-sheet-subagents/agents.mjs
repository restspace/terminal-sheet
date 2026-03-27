import fs from "node:fs";
import path from "node:path";

import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";

function isDirectory(candidatePath) {
  try {
    return fs.statSync(candidatePath).isDirectory();
  } catch {
    return false;
  }
}

function findNearestProjectAgentsDir(cwd) {
  let currentDir = path.resolve(cwd);
  while (true) {
    const candidate = path.join(currentDir, ".pi", "agents");
    if (isDirectory(candidate)) {
      return candidate;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
}

function loadAgentsFromDir(dir, source) {
  if (!dir || !isDirectory(dir)) {
    return [];
  }

  const agents = [];
  let entries = [];

  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return agents;
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) {
      continue;
    }

    if (!entry.isFile() && !entry.isSymbolicLink()) {
      continue;
    }

    const filePath = path.join(dir, entry.name);
    let content = "";

    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter(content);
    const name =
      typeof frontmatter?.name === "string" ? frontmatter.name.trim() : "";
    const description =
      typeof frontmatter?.description === "string"
        ? frontmatter.description.trim()
        : "";

    if (!name || !description) {
      continue;
    }

    const tools =
      typeof frontmatter?.tools === "string"
        ? frontmatter.tools
            .split(",")
            .map((tool) => tool.trim())
            .filter(Boolean)
        : undefined;

    const model =
      typeof frontmatter?.model === "string" && frontmatter.model.trim()
        ? frontmatter.model.trim()
        : undefined;

    agents.push({
      name,
      description,
      tools: tools && tools.length > 0 ? tools : undefined,
      model,
      systemPrompt: body.trim(),
      source,
      filePath,
    });
  }

  return agents;
}

export function discoverAgents(cwd, scope = "both") {
  const userAgentsDir = path.join(getAgentDir(), "agents");
  const projectAgentsDir = findNearestProjectAgentsDir(cwd);

  const userAgents =
    scope === "project" ? [] : loadAgentsFromDir(userAgentsDir, "user");
  const projectAgents =
    scope === "user" || !projectAgentsDir
      ? []
      : loadAgentsFromDir(projectAgentsDir, "project");

  const merged = new Map();

  if (scope === "both") {
    for (const agent of userAgents) {
      merged.set(agent.name, agent);
    }

    for (const agent of projectAgents) {
      merged.set(agent.name, agent);
    }
  } else if (scope === "user") {
    for (const agent of userAgents) {
      merged.set(agent.name, agent);
    }
  } else {
    for (const agent of projectAgents) {
      merged.set(agent.name, agent);
    }
  }

  return {
    agents: Array.from(merged.values()).sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
    projectAgentsDir,
  };
}
