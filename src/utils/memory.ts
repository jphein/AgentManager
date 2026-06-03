import fs from "node:fs";
import os from "node:os";

const CGROUP_MEMORY_PATH = "/sys/fs/cgroup/memory.current";
const CGROUP_MEMORY_MAX_PATH = "/sys/fs/cgroup/memory.max";

/**
 * Read container-level memory usage from cgroup v2. This captures the server
 * process AND all child `claude` CLI processes, unlike process.memoryUsage().rss
 * which only measures the Node.js server itself.
 * Falls back to process RSS when cgroup files aren't available (local dev).
 */
/**
 * Read the container memory limit from cgroup v2. Returns the value of
 * /sys/fs/cgroup/memory.max when set (not "max"), otherwise falls back to
 * os.totalmem() for local dev or unconstrained environments.
 */
export function getContainerMemoryLimit(): number {
  try {
    const raw = fs.readFileSync(CGROUP_MEMORY_MAX_PATH, "utf-8").trim();
    if (raw === "max") return os.totalmem();
    const bytes = Number(raw);
    if (Number.isNaN(bytes) || bytes <= 0) return os.totalmem();
    return bytes;
  } catch {
    return os.totalmem();
  }
}

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
