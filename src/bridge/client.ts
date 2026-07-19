import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  BridgeCommand,
  BridgeCommandSchema,
  BridgeResult,
  BridgeResultSchema,
  BRIDGE_PROTOCOL_VERSION,
  InstanceHeartbeat,
  InstanceHeartbeatSchema,
} from "./protocol.js";
import { ensureDataDirs, getInstancesRoot, instanceDir } from "../util/paths.js";
import { log } from "../util/logging.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_MS = 50;
/** Heartbeats older than this are "stale". Keep generous so brief poller pauses don't trigger AE -r injects. */
const STALE_INSTANCE_MS = 45_000;

export class BridgeError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

export interface InvokeOptions {
  method: string;
  args?: Record<string, unknown>;
  code?: string;
  undoName?: string;
  timeoutMs?: number;
  instanceId?: string;
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

function readJsonIfExists(filePath: string): unknown | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function listLiveInstances(staleMs = STALE_INSTANCE_MS): InstanceHeartbeat[] {
  ensureDataDirs();
  const root = getInstancesRoot();
  if (!fs.existsSync(root)) return [];

  const now = Date.now();
  const out: InstanceHeartbeat[] = [];

  for (const name of fs.readdirSync(root)) {
    const hbPath = path.join(root, name, "instance.json");
    const raw = readJsonIfExists(hbPath);
    if (!raw) continue;
    const parsed = InstanceHeartbeatSchema.safeParse(raw);
    if (!parsed.success) continue;
    const last = Date.parse(parsed.data.lastSeen);
    if (Number.isNaN(last) || now - last > staleMs) continue;
    out.push(parsed.data);
  }

  return out.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

export function pickDefaultInstance(preferred?: string): InstanceHeartbeat | null {
  const live = listLiveInstances();
  if (preferred) {
    const match = live.find((i) => i.instanceId === preferred);
    if (match) return match;
  }
  // Prefer stable "default" instance from the headless bootstrap
  const def = live.find((i) => i.instanceId === "default");
  if (def) return def;
  return live[0] ?? null;
}

export async function invokeBridge(options: InvokeOptions): Promise<BridgeResult> {
  ensureDataDirs();

  const instance = pickDefaultInstance(options.instanceId);
  if (!instance) {
    throw new BridgeError(
      "No live After Effects instance found",
      "AE_NOT_CONNECTED",
      "Open After Effects with Scripts allowed to write files/network. Run `ae-mcp install-bridge` and restart AE so the Startup bootstrap loads. Then call ae_health again.",
    );
  }

  const dir = instanceDir(instance.instanceId);
  fs.mkdirSync(dir, { recursive: true });

  const requestId = randomUUID();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const command: BridgeCommand = BridgeCommandSchema.parse({
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    requestId,
    op: options.method === "system.ping" ? "ping" : "invoke",
    method: options.method,
    args: options.args ?? {},
    code: options.code,
    meta: {
      undoName: options.undoName,
      timeoutMs,
    },
    createdAt: new Date().toISOString(),
  });

  const commandPath = path.join(dir, "command.json");
  const resultPath = path.join(dir, "result.json");

  // Clear stale result for this wait
  try {
    if (fs.existsSync(resultPath)) fs.unlinkSync(resultPath);
  } catch {
    /* ignore */
  }

  atomicWriteJson(commandPath, command);
  log.debug("command written", { requestId, method: options.method, instanceId: instance.instanceId });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const raw = readJsonIfExists(resultPath);
    if (raw) {
      const parsed = BridgeResultSchema.safeParse(raw);
      if (parsed.success && parsed.data.requestId === requestId) {
        // Consume result
        try {
          fs.unlinkSync(resultPath);
        } catch {
          /* ignore */
        }
        if (!parsed.data.ok) {
          const err = parsed.data.error;
          throw new BridgeError(
            err?.message ?? "After Effects command failed",
            err?.code ?? "AE_ERROR",
            err?.hint,
          );
        }
        return parsed.data;
      }
    }
    await sleep(POLL_MS);
  }

  throw new BridgeError(
    `Timed out after ${timeoutMs}ms waiting for After Effects (method: ${options.method})`,
    "AE_TIMEOUT",
    "AE may be busy, modal dialog open, or the Startup bridge stopped. Check AE is foreground-responsive and scripting permissions are enabled.",
  );
}

export async function pingInstance(instanceId?: string): Promise<BridgeResult> {
  return invokeBridge({ method: "system.ping", instanceId, timeoutMs: 5_000 });
}
