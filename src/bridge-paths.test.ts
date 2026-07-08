import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acksDir, bridgeHome, deliveredDir, outboundDir, spawnRequestsDir } from "./bridge-paths";

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
});
