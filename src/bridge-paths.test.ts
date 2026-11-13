import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acksDir,
  bridgeHome,
  deliveredDir,
  mcpTokenDir,
  outboundDir,
  sharedContextDir,
  spawnRequestsDir,
} from "./bridge-paths";
import { getContextDir } from "./utils/context";

describe("bridge-paths", () => {
  const OLD = process.env.BRIDGE_HOME;
  beforeEach(() => {
    process.env.BRIDGE_HOME = "/tmp/gm-bridge-test";
  });
  afterEach(() => {
    if (OLD === undefined) delete process.env.BRIDGE_HOME;
    else process.env.BRIDGE_HOME = OLD;
  });

  it("roots all dirs under BRIDGE_HOME", () => {
    expect(bridgeHome()).toBe("/tmp/gm-bridge-test");
    expect(outboundDir()).toBe(path.join("/tmp/gm-bridge-test", "outbound"));
    expect(acksDir()).toBe(path.join("/tmp/gm-bridge-test", "acks"));
    expect(deliveredDir()).toBe(path.join("/tmp/gm-bridge-test", "delivered"));
    expect(spawnRequestsDir()).toBe(path.join("/tmp/gm-bridge-test", "spawn-requests"));
  });

  it("defaults under HOME/.guildmaster/bridge when BRIDGE_HOME unset", () => {
    delete process.env.BRIDGE_HOME;
    expect(bridgeHome()).toBe(path.join(process.env.HOME || os.homedir(), ".guildmaster", "bridge"));
  });

  // guildmaster#14: the last two container-era paths (/shared-context,
  // /persistent/mcp-tokens) default under bridgeHome() too.
  it("roots shared-context and MCP tokens under BRIDGE_HOME", () => {
    expect(sharedContextDir()).toBe(path.join("/tmp/gm-bridge-test", "shared-context"));
    expect(mcpTokenDir()).toBe(path.join("/tmp/gm-bridge-test", "mcp-tokens"));
  });

  it("keeps the kill-switch and MCP tokens OUT of the shared-context tree agents get symlinked", () => {
    const inside = (child: string, parent: string) => {
      const rel = path.relative(parent, child);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    };
    const platform = path.join(bridgeHome(), "platform"); // kill-switch.ts PLATFORM_DIR
    expect(inside(platform, sharedContextDir())).toBe(false);
    expect(inside(mcpTokenDir(), sharedContextDir())).toBe(false);
    expect(inside(sharedContextDir(), mcpTokenDir())).toBe(false);
  });

  it("getContextDir defaults under bridgeHome(); SHARED_CONTEXT_DIR still overrides", () => {
    const OLD_CTX = process.env.SHARED_CONTEXT_DIR;
    try {
      delete process.env.SHARED_CONTEXT_DIR;
      expect(getContextDir()).toBe(path.join("/tmp/gm-bridge-test", "shared-context"));
      process.env.SHARED_CONTEXT_DIR = "/srv/elsewhere";
      expect(getContextDir()).toBe("/srv/elsewhere");
    } finally {
      if (OLD_CTX === undefined) delete process.env.SHARED_CONTEXT_DIR;
      else process.env.SHARED_CONTEXT_DIR = OLD_CTX;
    }
  });
});
