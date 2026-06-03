import fs from "node:fs";
import path from "node:path";
import express, { type Request, type Response } from "express";
import type { AgentManager } from "../agents";
import type { MessageBus } from "../messages";
import { getContextDir, validateContextPath } from "../utils/context";
import { queryString } from "../utils/express";

const STARTUP_CONTEXT_FILES = ["about-you.md", "backlog.md", "repository.md", "guides/locks.md"];

function scanContextIndex(contextDir: string): Array<{ name: string; size: number; modified: string }> {
  const result: Array<{ name: string; size: number; modified: string }> = [];

  const scan = (dir: string, prefix: string) => {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name.startsWith(".")) continue;
          scan(fullPath, `${prefix}${entry.name}/`);
        } else if (entry.name.endsWith(".md")) {
          const stat = fs.statSync(fullPath);
          result.push({
            name: `${prefix}${entry.name}`,
            size: stat.size,
            modified: stat.mtime.toISOString(),
          });
        }
      }
    } catch {
      // Directory not readable - skip
    }
  };

  scan(contextDir, "");
  return result;
}

export function createStartupRouter(agentManager: AgentManager, messageBus: MessageBus) {
  const router = express.Router();

  // Startup bundle - reduces agent startup to a single HTTP round-trip
  router.get("/api/startup", (req: Request, res: Response) => {
    const agentId = queryString(req.query.agentId);

    if (!agentId) {
      res.status(400).json({ error: "agentId query param required" });
      return;
    }

    const contextDir = getContextDir();

    // Agent registry
    const registry = agentManager.list().map((a) => ({
      id: a.id,
      name: a.name,
      status: a.status,
      role: a.role,
      capabilities: a.capabilities,
      currentTask: a.currentTask,
      parentId: a.parentId,
      depth: a.depth,
      model: a.model,
      lastActivity: a.lastActivity,
      unreadMessages: messageBus.unreadCount(a.id, a.role),
    }));

    // Unread count for the requesting agent
    const requestingAgent = agentManager.get(agentId);
    const unreadCount = messageBus.unreadCount(agentId, requestingAgent?.role);

    // Load the standard startup context files (skip if missing)
    const contextFiles: Record<string, string> = {};
    try {
      fs.mkdirSync(contextDir, { recursive: true });
    } catch {
      // ignore
    }
    for (const name of STARTUP_CONTEXT_FILES) {
      const filepath = validateContextPath(contextDir, name);
      if (filepath && fs.existsSync(filepath)) {
        try {
          contextFiles[name] = fs.readFileSync(filepath, "utf-8");
        } catch {
          // skip unreadable files
        }
      }
    }

    // Context index (all .md files with metadata)
    const contextIndex = scanContextIndex(contextDir);

    res.json({ registry, unreadCount, contextFiles, contextIndex });
  });

  return router;
}
