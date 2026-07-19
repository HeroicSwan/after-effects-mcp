import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { invokeBridge, listLiveInstances } from "../src/bridge/client.js";

/**
 * Mock AE: write heartbeat, then a background poller that answers commands.
 */
describe("bridge client with mock AE", () => {
  const prev = process.env.AE_MCP_DATA_DIR;
  let tmp: string;
  let timer: ReturnType<typeof setInterval> | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ae-mcp-bridge-"));
    process.env.AE_MCP_DATA_DIR = tmp;
    const inst = path.join(tmp, "instances", "mock-ae");
    fs.mkdirSync(inst, { recursive: true });

    const writeHb = () => {
      fs.writeFileSync(
        path.join(inst, "instance.json"),
        JSON.stringify({
          instanceId: "mock-ae",
          aeVersion: "25.0-mock",
          projectName: "Test",
          projectPath: null,
          lastSeen: new Date().toISOString(),
          protocolVersion: 1,
        }),
        "utf8",
      );
    };
    writeHb();

    timer = setInterval(() => {
      writeHb();
      const cmdPath = path.join(inst, "command.json");
      if (!fs.existsSync(cmdPath)) return;
      try {
        const cmd = JSON.parse(fs.readFileSync(cmdPath, "utf8"));
        fs.unlinkSync(cmdPath);
        const result = {
          requestId: cmd.requestId,
          ok: true,
          data:
            cmd.method === "system.health"
              ? { connected: true, aeVersion: "25.0-mock", bridge: "mock" }
              : { pong: true },
          timingMs: 1,
          instanceId: "mock-ae",
          aeVersion: "25.0-mock",
        };
        fs.writeFileSync(path.join(inst, "result.json"), JSON.stringify(result), "utf8");
      } catch {
        /* ignore race */
      }
    }, 30);
  });

  afterEach(() => {
    if (timer) clearInterval(timer);
    if (prev === undefined) delete process.env.AE_MCP_DATA_DIR;
    else process.env.AE_MCP_DATA_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("lists live instances", () => {
    const list = listLiveInstances();
    expect(list.some((i) => i.instanceId === "mock-ae")).toBe(true);
  });

  it("invokes health and waits for result", async () => {
    const result = await invokeBridge({ method: "system.health", timeoutMs: 3000 });
    expect(result.ok).toBe(true);
    expect((result.data as { connected: boolean }).connected).toBe(true);
  });
});
