import path from "node:path";
import { sharedContextDir } from "../bridge-paths";
/**
 * Return the absolute path of the shared context directory.
 *
 * Reads `SHARED_CONTEXT_DIR` from the environment, falling back to
 * `<bridgeHome()>/shared-context` (guildmaster#14; the container-era
 * default `/shared-context` does not exist on a local install).
 *
 * @returns Absolute path to the shared context directory.
 */
export function getContextDir(): string {
  return process.env.SHARED_CONTEXT_DIR || sharedContextDir();
}

/**
 * Validate that a context file name is safe to read/write.
 * Rejects path traversal attempts and names that resolve outside contextDir.
 *
 * @returns The resolved absolute path, or null if the name is invalid.
 */
export function validateContextPath(contextDir: string, name: string): string | null {
  if (name.includes("..")) return null;
  const filepath = path.resolve(path.join(contextDir, name));
  if (!filepath.startsWith(path.resolve(contextDir) + path.sep) && filepath !== path.resolve(contextDir)) {
    return null;
  }
  return filepath;
}
