/**
 * ProcessManager — handles child process lifecycle: spawn, termination,
 * stdin/stdout/stderr stream handling, CLI argument construction, and
 * settings.json generation for Claude CLI hooks.
 *
 * Extracted from src/agents.ts (Phase E PR27).
 * Receives a shared AgentRegistry, EventPipeline, and callbacks via constructor.
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { generateServiceToken } from "./auth";
import { CONFIG } from "./config";
import type { EventPipeline } from "./event-pipeline";
import { buildSettingsJson } from "./hook-config-store";
import { logger } from "./logger";
import { EVENTS_DIR, saveAgentState } from "./persistence";
import { debouncedSyncToGCS } from "./storage";
import type { AgentProcess, CreateAgentRequest, StreamEvent } from "./types";
import { errorMessage } from "./types";
import type { AgentRegistry } from "./usage-tracker";

/** Harmless stderr noise from Claude CLI startup that should not surface as errors. */
const STDERR_NOISE_RE = /apiKeyHelper did not return a valid value|Error getting API key from apiKeyHelper/;

/** Directory where full bytes of elided tool_result bodies are spilled so they
 *  remain retrievable by `ref` after the transcript copy is stubbed. */
const TOOL_OUTPUT_CACHE_DIR = path.join(EVENTS_DIR, "tool-output-cache");

function spillToolOutput(agentId: string, idx: number, slot: number, body: string): string {
  const safeId = agentId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const fileName = `${safeId}-${idx}-${slot}.txt`;
  const ref = path.join("tool-output-cache", fileName);
  try {
    mkdirSync(TOOL_OUTPUT_CACHE_DIR, { recursive: true });
    writeFileSync(path.join(TOOL_OUTPUT_CACHE_DIR, fileName), body);
    return ref;
  } catch {
    return "(spill-failed)";
  }
}

function elisionStub(byteLen: number, ref: string): string {
  return `[output ${byteLen} bytes elided — stored at ${ref}]`;
}

function toolResultBody(content: unknown): { text: string; bytes: number } | null {
  if (typeof content === "string") {
    return { text: content, bytes: Buffer.byteLength(content) };
  }
  if (Array.isArray(content)) {
    const text = content
      .map((part) =>
        part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .join("");
    if (text.length === 0) return null;
    return { text, bytes: Buffer.byteLength(text) };
  }
  return null;
}

/**
 * Replace any oversized tool_result body inside a StreamEvent with a short
 * stub, spilling the full bytes to disk. Mutates `event` in place and returns
 * it. Applied before the event reaches the pipeline so the bounded copy is what
 * gets persisted and pushed over SSE.
 */
export function capOversizedToolResults(
  agentId: string,
  event: { message?: unknown; [key: string]: unknown },
  maxBytes: number = CONFIG.MAX_TOOL_RESULT_BYTES,
): typeof event {
  const message = event.message;
  if (!message || typeof message !== "object") return event;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return event;

  const idx = typeof event._idx === "number" ? event._idx : 0;
  let slot = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if ((block as { type?: unknown }).type !== "tool_result") continue;
    const body = toolResultBody((block as { content?: unknown }).content);
    slot++;
    if (!body || body.bytes <= maxBytes) continue;
    const ref = spillToolOutput(agentId, idx, slot, body.text);
    (block as { content: unknown }).content = elisionStub(body.bytes, ref);
  }
  return event;
}

/** Kill a process group (SIGTERM), escalating to SIGKILL after a timeout. */
export function killProcessGroup(proc: ReturnType<typeof spawn>, timeoutMs = CONFIG.PROCESS_KILL_TIMEOUT_MS): void {
  if (proc.killed || proc.pid == null) return;
  try {
    process.kill(-proc.pid, "SIGTERM");
  } catch {
    return;
  }
  const escalation = setTimeout(() => {
    try {
      if (proc.pid) process.kill(-proc.pid, "SIGKILL");
    } catch {
      // Already dead
    }
  }, timeoutMs);
  escalation.unref();
}

/**
 * Kill ALL non-init, non-server processes.
 * Used by emergencyDestroyAll() to catch bash/node/curl/git spawned by agents
 * that aren't tracked in our process map. Only kills descendants of agentRootPids.
 */
export function cleanupAllProcesses(agentRootPids: number[]): void {
  if (agentRootPids.length === 0) return;
  try {
    const myPid = process.pid;
    const output = execFileSync("ps", ["-eo", "pid,ppid,comm"], {
      encoding: "utf-8",
      timeout: CONFIG.PROCESS_PS_TIMEOUT_MS,
    });
    const rootSet = new Set(agentRootPids.filter((p) => p > 0));
    const pidToPpid = new Map<number, number>();
    for (const line of output.split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) continue;
      const [, pidStr, ppidStr] = match;
      const pid = Number.parseInt(pidStr, 10);
      const ppid = Number.parseInt(ppidStr, 10);
      if (pid === 1 || pid === myPid) continue;
      pidToPpid.set(pid, ppid);
    }
    const toKill = new Set<number>(rootSet);
    let frontier = [...rootSet];
    while (frontier.length > 0) {
      const next: number[] = [];
      for (const pid of frontier) {
        for (const [cpid, ppid] of pidToPpid) {
          if (ppid === pid) next.push(cpid);
        }
      }
      for (const p of next) toKill.add(p);
      frontier = next;
    }
    let killed = 0;
    for (const pid of toKill) {
      try {
        process.kill(pid, "SIGKILL");
        killed++;
      } catch {
        // Already dead or no permission
      }
    }
    if (killed > 0) {
      logger.info(`[kill-switch] cleanupAllProcesses: killed ${killed} process(es)`);
    }
  } catch {
    // ps not available
  }
}

/** Callbacks that ProcessManager uses to communicate back to AgentManager without importing it. */
export interface ProcessManagerCallbacks {
  /** Notify SSE listeners of agent metadata changes. */
  onAgentUpdated: (id: string, agent: AgentProcess["agent"], immediate: boolean) => void;
  /** Notify idle listeners that an agent has gone idle. */
  onIdle: (id: string) => void;
  /** Schedule ephemeral agent auto-destroy after idle. */
  onEphemeralIdle: (id: string) => void;
}

export class ProcessManager {
  constructor(
    private registry: AgentRegistry,
    private eventPipeline: EventPipeline,
    private callbacks: ProcessManagerCallbacks,
  ) {}

  // ---------------------------------------------------------------------------
  // Process spawn
  // ---------------------------------------------------------------------------

  spawnProcess(
    id: string,
    agentProc: AgentProcess,
    args: string[],
    env: NodeJS.ProcessEnv,
    workspaceDir: string,
  ): ReturnType<typeof spawn> {
    const proc = spawn("claude", args, {
      env,
      cwd: workspaceDir,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    this.attachProcessHandlers(id, agentProc, proc);
    return proc;
  }

  // ---------------------------------------------------------------------------
  // Process kill
  // ---------------------------------------------------------------------------

  killAndWait(proc: ReturnType<typeof spawn>, agentProc: AgentProcess): Promise<void> {
    return new Promise<void>((resolve) => {
      proc.stdout?.removeAllListeners();
      proc.stderr?.removeAllListeners();
      proc.removeAllListeners("close");

      if (proc.killed || proc.exitCode !== null) {
        resolve();
        return;
      }

      agentProc.agent.status = "killing";

      proc.once("close", () => {
        resolve();
      });

      killProcessGroup(proc);

      const safety = setTimeout(() => resolve(), 6_000);
      safety.unref();
    });
  }

  // ---------------------------------------------------------------------------
  // CLI argument builder
  // ---------------------------------------------------------------------------

  buildClaudeArgs(opts: CreateAgentRequest, model: string, resumeSessionId?: string): string[] {
    const args: string[] = [];
    if (opts.permissionMode) {
      args.push("--permission-mode", opts.permissionMode);
    } else if (opts.dangerouslySkipPermissions !== false) {
      args.push("--dangerously-skip-permissions");
    }
    args.push(
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--max-turns",
      String(opts.maxTurns ?? 200),
      "--model",
      model,
    );
    if (opts.effort) {
      args.push("--effort", opts.effort);
    }
    if (opts.appendSystemPrompt) {
      args.push("--append-system-prompt", opts.appendSystemPrompt);
    }
    if (opts.allowedTools && opts.allowedTools.length > 0) {
      args.push("--allowedTools", ...opts.allowedTools);
    }
    if (opts.disallowedTools && opts.disallowedTools.length > 0) {
      args.push("--disallowedTools", ...opts.disallowedTools);
    }
    if (opts.fallbackModel) {
      args.push("--fallback-model", opts.fallbackModel);
    }
    if (opts.mcpConfigPath) {
      args.push("--mcp-config", opts.mcpConfigPath, "--strict-mcp-config");
    }
    if (opts.forkSessionId) {
      args.push("--resume", opts.forkSessionId, "--fork-session");
    } else if (resumeSessionId) {
      args.push("--resume", resumeSessionId);
    }
    if (opts.sessionId) {
      args.push("--session-id", opts.sessionId);
    }
    if (opts.noSessionPersistence) {
      args.push("--no-session-persistence");
    }
    if (opts.maxBudgetUsd != null) {
      args.push("--max-budget-usd", String(opts.maxBudgetUsd));
    }
    if (opts.jsonSchema) {
      args.push("--json-schema", JSON.stringify(opts.jsonSchema));
    }
    if (opts.agents && Object.keys(opts.agents).length > 0) {
      args.push("--agents", JSON.stringify(opts.agents));
    }
    args.push("--print", "--", opts.prompt);
    return args;
  }

  // ---------------------------------------------------------------------------
  // Hooks settings.json generation
  // ---------------------------------------------------------------------------

  generateHooksSettings(agentId: string, workspaceDir: string): void {
    try {
      const port = process.env.PORT ?? "8080";
      const token = generateServiceToken(agentId);
      const baseUrl = `http://localhost:${port}/api/hooks/${agentId}`;
      const authHeader = `Bearer ${token}`;

      const settings = {
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "http", url: `${baseUrl}/pre-tool-use`, headers: { Authorization: authHeader } }],
            },
          ],
          PostToolUse: [
            {
              matcher: ".*",
              hooks: [
                { type: "http", url: `${baseUrl}/post-tool-use`, headers: { Authorization: authHeader }, async: true },
              ],
            },
          ],
          Stop: [
            {
              hooks: [{ type: "http", url: `${baseUrl}/stop`, headers: { Authorization: authHeader }, async: true }],
            },
          ],
          SubagentStart: [
            {
              hooks: [
                {
                  type: "http",
                  url: `${baseUrl}/subagent-start`,
                  headers: { Authorization: authHeader },
                  async: true,
                },
              ],
            },
          ],
          SubagentStop: [
            {
              hooks: [
                {
                  type: "http",
                  url: `${baseUrl}/subagent-stop`,
                  headers: { Authorization: authHeader },
                  async: true,
                },
              ],
            },
          ],
        },
      };

      const operatorSettings = buildSettingsJson(agentId) as { hooks?: Record<string, unknown[]> };
      if (operatorSettings.hooks) {
        for (const [event, entries] of Object.entries(operatorSettings.hooks)) {
          const key = event as keyof typeof settings.hooks;
          if (settings.hooks[key]) {
            (settings.hooks[key] as unknown[]).push(...entries);
          } else {
            (settings.hooks as Record<string, unknown[]>)[event] = [...entries];
          }
        }
      }

      const claudeDir = path.join(workspaceDir, ".claude");
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify(settings, null, 2));
    } catch (err) {
      logger.warn("[hooks] Failed to write hooks settings", {
        agentId: agentId.slice(0, 8),
        error: errorMessage(err),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Private: stdio handling
  // ---------------------------------------------------------------------------

  private attachProcessHandlers(id: string, agentProc: AgentProcess, proc: ReturnType<typeof spawn>): void {
    proc.stdout?.on("data", (chunk: Buffer) => {
      agentProc.lineBuffer += chunk.toString();

      if (agentProc.lineBuffer.length > 1_048_576 && proc.stdout) {
        proc.stdout.pause();
      }

      if (!agentProc.processingScheduled) {
        agentProc.processingScheduled = true;
        setImmediate(() => this.processLineBuffer(id, agentProc, proc));
      }
    });

    proc.stderr?.on("data", (d: Buffer) => {
      const text = d.toString();
      if (STDERR_NOISE_RE.test(text)) return;
      this.eventPipeline.handleEvent(id, { type: "stderr", text });
    });

    proc.on("close", (code) => {
      if (agentProc.lineBuffer.trim()) {
        try {
          const event = JSON.parse(agentProc.lineBuffer) as StreamEvent;
          capOversizedToolResults(id, event);
          this.eventPipeline.handleEvent(id, event);
        } catch {
          this.eventPipeline.handleEvent(id, { type: "raw", text: agentProc.lineBuffer });
        }
        agentProc.lineBuffer = "";
      }

      this.eventPipeline.handleEvent(id, { type: "done", exitCode: code ?? undefined });
      this.eventPipeline.flushEventBatch(id, agentProc);

      const ap = this.registry.get(id);
      if (ap) {
        ap.agent.status = code === 0 ? "idle" : "error";
        ap.agent.lastActivity = new Date().toISOString();
        saveAgentState(ap.agent);
        this.callbacks.onAgentUpdated(id, ap.agent, true);
      }
      debouncedSyncToGCS().catch((err) => {
        logger.error("[agents] Failed to sync GCS after agent exit", { agentId: id, error: errorMessage(err) });
      });

      if (code === 0) {
        this.callbacks.onIdle(id);
        this.callbacks.onEphemeralIdle(id);
      }
    });
  }

  private processLineBuffer(id: string, agentProc: AgentProcess, proc: ReturnType<typeof spawn>): void {
    agentProc.processingScheduled = false;

    if (this.registry.get(id) == null) return;

    const lines = agentProc.lineBuffer.split("\n");
    agentProc.lineBuffer = lines.pop() || "";

    const BATCH_SIZE = 50;
    let offset = 0;

    const processBatch = () => {
      if (this.registry.get(id) == null) return;

      const end = Math.min(offset + BATCH_SIZE, lines.length);
      for (let i = offset; i < end; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as StreamEvent;
          capOversizedToolResults(id, event);
          this.eventPipeline.handleEvent(id, event);
        } catch {
          this.eventPipeline.handleEvent(id, { type: "raw", text: line });
        }
      }

      offset = end;

      if (offset < lines.length) {
        setImmediate(processBatch);
      } else {
        if (proc.stdout?.isPaused?.()) {
          proc.stdout.resume();
        }
      }
    };

    processBatch();
  }
}
