import { describe, it, expect } from "vitest";
import {
  BridgeCommandSchema,
  BridgeResultSchema,
  InstanceHeartbeatSchema,
  BRIDGE_PROTOCOL_VERSION,
} from "../src/bridge/protocol.js";

describe("protocol schemas", () => {
  it("parses a valid command", () => {
    const cmd = BridgeCommandSchema.parse({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      requestId: "abc",
      op: "invoke",
      method: "system.health",
      args: {},
    });
    expect(cmd.method).toBe("system.health");
    expect(cmd.meta).toEqual({});
  });

  it("parses success result", () => {
    const result = BridgeResultSchema.parse({
      requestId: "abc",
      ok: true,
      data: { connected: true },
      timingMs: 12,
    });
    expect(result.ok).toBe(true);
  });

  it("parses heartbeat", () => {
    const hb = InstanceHeartbeatSchema.parse({
      instanceId: "ae-1",
      lastSeen: new Date().toISOString(),
      aeVersion: "25.0",
    });
    expect(hb.instanceId).toBe("ae-1");
  });
});
