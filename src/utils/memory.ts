import fs from "node:fs";

const CGROUP_MEMORY_PATH = "/sys/fs/cgroup/memory.current";
const CGROUP_MEMORY_MAX_PATH = "/sys/fs/cgroup/memory.max";

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

/** Read the container memory limit from cgroup v2. Falls back to 32 GiB. */
export function getContainerMemoryLimit(): number {
  const DEFAULT = 32 * 1024 * 1024 * 1024;
  try {
    const raw = fs.readFileSync(CGROUP_MEMORY_MAX_PATH, "utf-8").trim();
    if (raw === "max") return DEFAULT;
    const bytes = Number(raw);
    return Number.isNaN(bytes) ? DEFAULT : bytes;
  } catch {
    return DEFAULT;
  }
}
