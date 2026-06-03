import fs from "node:fs";

const CGROUP_MEMORY_PATH = "/sys/fs/cgroup/memory.current";
const CGROUP_MEMORY_LIMIT_PATH = "/sys/fs/cgroup/memory.max";

/**
 * Read container-level memory usage from cgroup v2. This captures the server
 * process AND all child `claude` CLI processes, unlike process.memoryUsage().rss
 * which only measures the Node.js server itself.
 * Falls back to process RSS when cgroup files aren't available (local dev).
 */
export function getContainerMemoryUsage(): number {
  try {
    const raw = fs.readFileSync(CGROUP_MEMORY_PATH, "utf-8").trim();
    const bytes = Number(raw);
    if (Number.isNaN(bytes)) return process.memoryUsage().rss;
    return bytes;
  } catch {
    return process.memoryUsage().rss;
  }
}

/**
 * Read container-level memory limit from cgroup v2.
 * Returns the cgroup memory.max value if available, otherwise falls back to
 * a large sentinel (16 GB) so ratio checks remain valid on unconstrained hosts.
 */
export function getContainerMemoryLimit(): number {
  const FALLBACK = 16 * 1024 * 1024 * 1024; // 16 GB
  try {
    const raw = fs.readFileSync(CGROUP_MEMORY_LIMIT_PATH, "utf-8").trim();
    if (raw === "max") return FALLBACK;
    const bytes = Number(raw);
    if (Number.isNaN(bytes) || bytes <= 0) return FALLBACK;
    return bytes;
  } catch {
    return FALLBACK;
  }
}
