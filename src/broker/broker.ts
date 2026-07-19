import { BridgeResult } from "../bridge/protocol.js";
import {
  BridgeError,
  invokeBridge,
  InvokeOptions,
  listLiveInstances,
  pickDefaultInstance,
} from "../bridge/client.js";
import { log } from "../util/logging.js";

/**
 * In-process broker: serializes AE commands (FIFO).
 * Does NOT auto-inject AfterFX -r (that causes "Executing script…" popups).
 */
export class Broker {
  private chains = new Map<string, Promise<unknown>>();

  async invoke(options: InvokeOptions): Promise<BridgeResult> {
    if (!pickDefaultInstance(options.instanceId)) {
      throw new BridgeError(
        "No live After Effects bridge heartbeat",
        "AE_NOT_CONNECTED",
        "Fully quit and reopen After Effects once so Scripts/Startup/ae-mcp-bootstrap.jsx loads silently. Or call ae_reconnect once (shows one brief Executing script dialog). Do not leave auto-kick enabled.",
      );
    }

    const instance = pickDefaultInstance(options.instanceId);
    const key = instance?.instanceId ?? "__none__";

    const prev = this.chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const next = prev.then(() => gate);
    this.chains.set(key, next);

    try {
      await prev.catch(() => undefined);
      log.debug("broker dispatch", { method: options.method, instance: key });
      return await invokeBridge(options);
    } finally {
      release();
      if (this.chains.get(key) === next) {
        this.chains.delete(key);
      }
    }
  }

  listInstances() {
    return listLiveInstances();
  }

  defaultInstance() {
    return pickDefaultInstance();
  }
}

export const broker = new Broker();
