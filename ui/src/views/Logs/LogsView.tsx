"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import type { StreamEvent } from "../../api";
import { Header } from "../../components/Header";
import { MessageFeed } from "../../components/MessageFeed";
import { Sidebar } from "../../components/Sidebar";
import { useAgentPolling } from "../../hooks/useAgentPolling";
import { type AgentLogEntry, useAllAgentLogs } from "../../hooks/useAllAgentLogs";
import { useApi } from "../../hooks/useApi";
import { useKillSwitchContext } from "../../killSwitch";

// ─── Agent color palette ─────────────────────────────────────────────────────

const AGENT_COLORS = [
  { text: "text-emerald-400", bg: "bg-emerald-400/10", border: "border-emerald-400/20" },
  { text: "text-sky-400", bg: "bg-sky-400/10", border: "border-sky-400/20" },
  { text: "text-violet-400", bg: "bg-violet-400/10", border: "border-violet-400/20" },
  { text: "text-amber-400", bg: "bg-amber-400/10", border: "border-amber-400/20" },
  { text: "text-rose-400", bg: "bg-rose-400/10", border: "border-rose-400/20" },
  { text: "text-cyan-400", bg: "bg-cyan-400/10", border: "border-cyan-400/20" },
  { text: "text-orange-400", bg: "bg-orange-400/10", border: "border-orange-400/20" },
  { text: "text-pink-400", bg: "bg-pink-400/10", border: "border-pink-400/20" },
  { text: "text-lime-400", bg: "bg-lime-400/10", border: "border-lime-400/20" },
  { text: "text-teal-400", bg: "bg-teal-400/10", border: "border-teal-400/20" },
] as const;

function agentColorIndex(agentId: string): number {
  let h = 0;
  for (let i = 0; i < agentId.length; i++) {
    h = (h * 31 + agentId.charCodeAt(i)) & 0xffff;
  }
  return h % AGENT_COLORS.length;
}

function agentColor(agentId: string) {
  return AGENT_COLORS[agentColorIndex(agentId)];
}

// ─── Event parsing ────────────────────────────────────────────────────────────

type EntryKind = "output" | "error" | "system" | "tool" | "result" | "user";

interface ParsedEntry {
  kind: EntryKind;
  text: string;
  toolName?: string;
}

function summarizeToolInput(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Bash":
      return String(input.command ?? "").slice(0, 100);
    case "Read":
      return String(input.file_path ?? "");
    case "Write":
      return String(input.file_path ?? "");
    case "Edit":
      return String(input.file_path ?? "");
    case "Glob":
      return String(input.pattern ?? "");
    case "Grep":
      return String(input.pattern ?? "");
    case "WebFetch":
      return String(input.url ?? "").slice(0, 80);
    case "WebSearch":
      return String(input.query ?? "");
    case "Task":
      return String(input.description ?? "").slice(0, 80);
    case "TodoWrite": {
      const todos = Array.isArray(input.todos) ? input.todos : [];
      if (todos.length === 0) return "";
      const done = todos.filter((t: Record<string, unknown>) => t.status === "completed").length;
      const active = todos.filter((t: Record<string, unknown>) => t.status === "in_progress").length;
      const parts: string[] = [`${done}/${todos.length} done`];
      if (active > 0) parts.push(`${active} active`);
      return parts.join(", ");
    }
    default: {
      const keys = Object.keys(input);
      if (!keys.length) return "";
      const v = input[keys[0]];
      return typeof v === "string" ? v.slice(0, 80) : keys.join(", ");
    }
  }
}

function parseEntry(event: StreamEvent): ParsedEntry | ParsedEntry[] | null {
  switch (event.type) {
    case "assistant": {
      const msg = event.message as
        | { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> }
        | undefined;
      if (!msg?.content) return null;
      const results: ParsedEntry[] = [];
      for (const block of msg.content) {
        if (block.type === "thinking" && block.text) {
          const preview = block.text.slice(0, 100) + (block.text.length > 100 ? "…" : "");
          results.push({ kind: "system", text: `Thinking: ${preview}` });
        } else if (block.type === "text" && block.text) {
          results.push({ kind: "output", text: block.text });
        } else if (block.type === "tool_use" && block.name) {
          const summary = summarizeToolInput(block.name, (block.input as Record<string, unknown>) ?? {});
          results.push({
            kind: "tool",
            text: summary ? `${block.name} — ${summary}` : block.name,
            toolName: block.name,
          });
        }
      }
      return results.length ? results : null;
    }
    case "stderr": {
      const txt = String(event.text ?? "").trim();
      return txt ? { kind: "error", text: txt } : null;
    }
    case "result": {
      const txt = String(event.result ?? "").trim();
      return txt ? { kind: "result", text: txt } : null;
    }
    case "system": {
      if (event.subtype === "init") {
        const model = String(event.model ?? "");
        return { kind: "system", text: `Session started${model ? ` · ${model}` : ""}` };
      }
      if (event.subtype === "watchdog") {
        return { kind: "system", text: String(event.message ?? "") };
      }
      if (event.subtype === "paused" || event.subtype === "resumed") {
        return { kind: "system", text: String(event.message ?? event.subtype) };
      }
      return null;
    }
    case "user_prompt": {
      const txt = String(event.text ?? "").trim();
      return txt ? { kind: "user", text: txt } : null;
    }
    default:
      return null;
  }
}

function flattenEntry(entry: AgentLogEntry): Array<AgentLogEntry & { parsed: ParsedEntry }> {
  const result = parseEntry(entry.event);
  if (!result) return [];
  const parsed = Array.isArray(result) ? result : [result];
  return parsed.map((p, i) => ({
    ...entry,
    id: `${entry.id}-${i}`,
    parsed: p,
  }));
}

const KIND_STYLES: Record<EntryKind, { rowHover: string; prefix: string; prefixColor: string; textColor: string }> = {
  output: {
    rowHover: "hover:bg-zinc-900/50",
    prefix: "▸",
    prefixColor: "text-emerald-500",
    textColor: "text-zinc-200",
  },
  error: {
    rowHover: "hover:bg-red-950/20",
    prefix: "✕",
    prefixColor: "text-red-400",
    textColor: "text-red-300",
  },
  system: {
    rowHover: "hover:bg-zinc-900/50",
    prefix: "·",
    prefixColor: "text-zinc-600",
    textColor: "text-zinc-500",
  },
  tool: {
    rowHover: "hover:bg-zinc-900/50",
    prefix: "⬡",
    prefixColor: "text-cyan-500",
    textColor: "text-cyan-300/80",
  },
  result: {
    rowHover: "hover:bg-emerald-950/20",
    prefix: "✓",
    prefixColor: "text-emerald-400",
    textColor: "text-emerald-300",
  },
  user: {
    rowHover: "hover:bg-blue-950/20",
    prefix: "→",
    prefixColor: "text-blue-400",
    textColor: "text-blue-200",
  },
};

// ─── Log row ──────────────────────────────────────────────────────────────────

interface FlatEntry extends AgentLogEntry {
  parsed: ParsedEntry;
}

interface LogRowProps {
  entry: FlatEntry;
}

const LogRow = memo(function LogRow({ entry }: LogRowProps) {
  const color = agentColor(entry.agentId);
  const style = KIND_STYLES[entry.parsed.kind];
  const ts = entry.timestamp.toTimeString().slice(0, 8);

  return (
    <div
      className={`flex items-baseline gap-0 px-4 py-[2px] min-h-[22px] font-mono text-xs leading-relaxed group transition-colors ${style.rowHover}`}
    >
      <time
        dateTime={entry.timestamp.toISOString()}
        className="shrink-0 w-[58px] text-zinc-600 tabular-nums select-none"
      >
        {ts}
      </time>

      <span
        className={`shrink-0 inline-block mr-2 px-1.5 py-[1px] rounded text-[10px] font-medium border ${color.text} ${color.bg} ${color.border} max-w-[120px] truncate`}
        title={entry.agentName}
      >
        {entry.agentName}
      </span>

      <span className={`shrink-0 mr-2 w-3 text-center select-none ${style.prefixColor}`}>{style.prefix}</span>

      <span className={`${style.textColor} break-all whitespace-pre-wrap leading-snug`}>{entry.parsed.text}</span>
    </div>
  );
});

// ─── Filter types ─────────────────────────────────────────────────────────────

const FILTER_KINDS: { label: string; kinds: EntryKind[] }[] = [
  { label: "All", kinds: ["output", "error", "system", "tool", "result", "user"] },
  { label: "Output", kinds: ["output", "result"] },
  { label: "Errors", kinds: ["error"] },
  { label: "Tools", kinds: ["tool"] },
  { label: "System", kinds: ["system", "user"] },
];

// ─── Stable Virtuoso spacer ───────────────────────────────────────────────────
const VirtuosoFooter = () => <div className="h-2" />;
const virtuosoComponents = { Footer: VirtuosoFooter };

// ─── Main view ────────────────────────────────────────────────────────────────

type LogTab = "logs" | "messages";

export function LogsView() {
  const { agents } = useAgentPolling();
  const killSwitch = useKillSwitchContext();
  const api = useApi();
  const { entries, connected, error, clearEntries, reconnect } = useAllAgentLogs(100);

  const [activeTab, setActiveTab] = useState<LogTab>("logs");
  const [filterKindIdx, setFilterKindIdx] = useState(0);
  const [filterAgentId, setFilterAgentId] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [newCount, setNewCount] = useState(0);
  const prevCountRef = useRef(0);
  const userScrolledUpRef = useRef(false);
  const isAtBottomRef = useRef(true);

  const virtuosoRef = useRef<VirtuosoHandle>(null);

  useEffect(() => {
    document.title = "Logs - AgentManager";
  }, []);

  const flatEntries = useMemo(() => entries.flatMap(flattenEntry), [entries]);

  const { kinds: activeKinds } = FILTER_KINDS[filterKindIdx];

  const filtered = useMemo(() => {
    return flatEntries.filter((e) => {
      if (filterAgentId && e.agentId !== filterAgentId) return false;
      if (!activeKinds.includes(e.parsed.kind)) return false;
      return true;
    });
  }, [flatEntries, filterAgentId, activeKinds]);

  const seenAgents = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of entries) map.set(e.agentId, e.agentName);
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [entries]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on filter change only
  useEffect(() => {
    prevCountRef.current = filtered.length;
    setNewCount(0);
  }, [filterKindIdx, filterAgentId]);

  useEffect(() => {
    const count = filtered.length;
    if (prevCountRef.current > 0 && count > prevCountRef.current && !isAtBottomRef.current) {
      setNewCount((c) => c + (count - prevCountRef.current));
    }
    prevCountRef.current = count;
  }, [filtered.length]);

  useEffect(() => {
    if (isAtBottom) {
      setNewCount(0);
      userScrolledUpRef.current = false;
    }
  }, [isAtBottom]);

  const scrollToBottom = useCallback(() => {
    userScrolledUpRef.current = false;
    setNewCount(0);
    virtuosoRef.current?.scrollToIndex({ index: "LAST", behavior: "smooth" });
  }, []);

  const handleAtBottom = useCallback((atBottom: boolean) => {
    setIsAtBottom(atBottom);
    isAtBottomRef.current = atBottom;
  }, []);

  const wrapperRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0 && !isAtBottomRef.current) {
        userScrolledUpRef.current = true;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const followOutput = autoScroll ? ("smooth" as const) : (false as const);

  const handleClear = useCallback(() => {
    clearEntries();
    prevCountRef.current = 0;
    setNewCount(0);
  }, [clearEntries]);

  const handleReconnect = useCallback(() => {
    setFilterAgentId(null);
    reconnect();
  }, [reconnect]);

  return (
    <div className="h-screen flex flex-col">
      <Header agentCount={agents.length} killSwitch={killSwitch} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar agents={agents} activeId={null} />
        <main id="main-content" className="flex-1 flex flex-col overflow-hidden bg-zinc-950">
          {/* Tab bar */}
          <div className="shrink-0 flex items-center flex-wrap gap-0 px-2 sm:px-4 border-b border-zinc-800 bg-zinc-900/40">
            <button
              type="button"
              onClick={() => setActiveTab("logs")}
              className={`px-4 py-2.5 text-xs font-medium border-b-2 transition-colors ${
                activeTab === "logs"
                  ? "border-blue-500 text-blue-400"
                  : "border-transparent text-zinc-500 hover:text-zinc-300"
              }`}
            >
              Logs
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("messages")}
              className={`px-4 py-2.5 text-xs font-medium border-b-2 transition-colors ${
                activeTab === "messages"
                  ? "border-blue-500 text-blue-400"
                  : "border-transparent text-zinc-500 hover:text-zinc-300"
              }`}
            >
              Messages
            </button>

            {/* Logs toolbar — only shown on logs tab */}
            {activeTab === "logs" && (
              <>
                <div className="w-px h-4 bg-zinc-700 mx-3" />

                {/* Connection status */}
                <span
                  className={`inline-flex items-center gap-1.5 text-[10px] font-medium px-2 py-0.5 rounded-full mr-3 ${
                    connected
                      ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                      : "bg-zinc-800 text-zinc-500 border border-zinc-700"
                  }`}
                >
                  <span
                    className={`inline-block w-1.5 h-1.5 rounded-full ${
                      connected ? "bg-emerald-400 animate-pulse" : "bg-zinc-500"
                    }`}
                  />
                  {connected ? "Live" : "Connecting…"}
                </span>
                {error && <span className="text-[10px] text-amber-400 mr-2">{error}</span>}

                {/* Kind filter pills */}
                <div className="flex items-center gap-1">
                  {FILTER_KINDS.map((f, i) => (
                    <button
                      key={f.label}
                      type="button"
                      onClick={() => setFilterKindIdx(i)}
                      className={`px-2.5 py-1 rounded text-xs transition-colors ${
                        filterKindIdx === i
                          ? "bg-zinc-700 text-zinc-100"
                          : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"
                      }`}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>

                {/* Agent filter */}
                <div className="relative ml-2">
                  <select
                    value={filterAgentId ?? ""}
                    onChange={(e) => setFilterAgentId(e.target.value || null)}
                    className="appearance-none bg-zinc-900 border border-zinc-700 text-zinc-300 text-xs rounded px-2.5 py-1 pr-6 focus:outline-none focus:border-zinc-600 cursor-pointer max-w-[180px] truncate"
                    aria-label="Filter by agent"
                  >
                    <option value="">All agents</option>
                    {seenAgents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                  <svg
                    className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-zinc-500"
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    fill="none"
                    aria-hidden="true"
                  >
                    <path d="M2.5 4.5l3.5 3 3.5-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </div>

                <div className="flex-1" />

                {/* Auto-scroll toggle */}
                <button
                  type="button"
                  onClick={() => setAutoScroll((v) => !v)}
                  title={autoScroll ? "Disable auto-scroll" : "Enable auto-scroll"}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs transition-colors ${
                    autoScroll
                      ? "bg-blue-600/10 text-blue-400 border border-blue-600/20"
                      : "text-zinc-500 hover:text-zinc-300 bg-zinc-900 border border-zinc-700"
                  }`}
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <path
                      d="M6 2v8M3 7l3 3 3-3"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  Tail
                </button>

                {/* Clear */}
                <button
                  type="button"
                  onClick={handleClear}
                  className="px-2.5 py-1 rounded text-xs text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors border border-transparent hover:border-zinc-700"
                >
                  Clear
                </button>

                {/* Reconnect */}
                <button
                  type="button"
                  onClick={handleReconnect}
                  title="Reconnect to log stream"
                  className="px-2.5 py-1 rounded text-xs text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors border border-transparent hover:border-zinc-700"
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <path
                      d="M10 6a4 4 0 1 1-1.17-2.83M10 2v3H7"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              </>
            )}
          </div>

          {/* Messages tab */}
          {activeTab === "messages" && (
            <div className="flex-1 overflow-hidden p-6">
              <MessageFeed api={api} agents={agents} />
            </div>
          )}

          {/* Logs tab */}
          {activeTab === "logs" && (
            <>
              <div ref={wrapperRef} className="flex-1 overflow-hidden relative">
                {filtered.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full gap-3">
                    <svg
                      width="40"
                      height="40"
                      viewBox="0 0 40 40"
                      fill="none"
                      className="text-zinc-700"
                      aria-hidden="true"
                    >
                      <rect x="6" y="8" width="28" height="4" rx="2" fill="currentColor" opacity="0.5" />
                      <rect x="6" y="16" width="20" height="4" rx="2" fill="currentColor" opacity="0.3" />
                      <rect x="6" y="24" width="24" height="4" rx="2" fill="currentColor" opacity="0.2" />
                      <rect x="6" y="32" width="14" height="4" rx="2" fill="currentColor" opacity="0.1" />
                    </svg>
                    <p className="text-zinc-600 text-sm">
                      {connected ? "Waiting for log entries…" : "Connecting to log stream…"}
                    </p>
                  </div>
                ) : (
                  <Virtuoso
                    ref={virtuosoRef}
                    data={filtered}
                    followOutput={followOutput}
                    overscan={200}
                    initialTopMostItemIndex={Math.max(0, filtered.length - 1)}
                    atBottomThreshold={40}
                    atBottomStateChange={handleAtBottom}
                    className="h-full"
                    itemContent={(_index, entry) => <LogRow entry={entry} />}
                    components={virtuosoComponents}
                  />
                )}

                {/* New entries badge */}
                {!isAtBottom && newCount > 0 && (
                  <button
                    type="button"
                    onClick={scrollToBottom}
                    className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-zinc-700/90 hover:bg-zinc-600/90 border border-zinc-600 text-zinc-200 text-xs shadow-lg backdrop-blur-sm transition-all"
                    aria-label={`${newCount} new entries, scroll to bottom`}
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 12 12"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <polyline points="2 4 6 8 10 4" />
                    </svg>
                    {newCount} new
                  </button>
                )}
              </div>

              {/* Status bar */}
              <div className="shrink-0 flex items-center justify-between px-4 py-1.5 border-t border-zinc-800/60 bg-zinc-900/30 text-[10px] text-zinc-600 font-mono">
                <span>
                  {filtered.length.toLocaleString()} entries
                  {filterAgentId && " (filtered)"}
                </span>
                <span className="flex items-center gap-3">
                  {seenAgents.length > 0 && (
                    <span>
                      {seenAgents.length} agent{seenAgents.length !== 1 ? "s" : ""}
                    </span>
                  )}
                  <span>{autoScroll ? "auto-scroll on" : "auto-scroll off"}</span>
                </span>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
