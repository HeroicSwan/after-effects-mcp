import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getDataRoot, getHostScriptsDir, ensureDataDirs } from "../util/paths.js";
import { listLiveInstances } from "../bridge/client.js";
import { log } from "../util/logging.js";

export interface EnsureResult {
  ok: boolean;
  kicked: boolean;
  skipped?: boolean;
  aeRunning: boolean;
  afterFxPath: string | null;
  message: string;
  instances: number;
}

/** Hard floor between AfterFX -r injects even when user forces reconnect. */
const FORCE_KICK_FLOOR_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function lastKickPath(): string {
  return path.join(getDataRoot(), "last-kick.json");
}

export function getLastKickTime(): number {
  try {
    ensureDataDirs();
    const p = lastKickPath();
    if (!fs.existsSync(p)) return 0;
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as { at?: number };
    return typeof raw.at === "number" ? raw.at : 0;
  } catch {
    return 0;
  }
}

function recordKick(): void {
  try {
    ensureDataDirs();
    fs.writeFileSync(
      lastKickPath(),
      JSON.stringify({ at: Date.now(), iso: new Date().toISOString() }, null, 2),
      "utf8",
    );
  } catch {
    /* ignore */
  }
}

export function canKickNow(force = false): { ok: boolean; waitMs: number } {
  // Automatic kicks are NEVER ok — only force (user/CLI) may inject.
  if (!force) {
    return { ok: false, waitMs: Number.MAX_SAFE_INTEGER };
  }
  const last = getLastKickTime();
  if (!last) return { ok: true, waitMs: 0 };
  const elapsed = Date.now() - last;
  if (elapsed >= FORCE_KICK_FLOOR_MS) return { ok: true, waitMs: 0 };
  return { ok: false, waitMs: FORCE_KICK_FLOOR_MS - elapsed };
}

export function isAfterEffectsRunning(): boolean {
  if (process.platform === "win32") {
    try {
      const out = execFileSync(
        "tasklist",
        ["/FI", "IMAGENAME eq AfterFX.exe", "/NH"],
        { encoding: "utf8", windowsHide: true },
      );
      return /AfterFX\.exe/i.test(out);
    } catch {
      return false;
    }
  }
  try {
    const out = execFileSync("pgrep", ["-fil", "Adobe After Effects"], {
      encoding: "utf8",
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

export function findAfterEffectsExecutable(): string | null {
  if (process.platform === "win32") {
    try {
      const out = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          "(Get-Process AfterFX -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path)",
        ],
        { encoding: "utf8", windowsHide: true },
      ).trim();
      if (out && fs.existsSync(out)) return out;
    } catch {
      /* fall through */
    }

    const pf = [
      process.env["ProgramFiles"],
      process.env["ProgramFiles(x86)"],
    ].filter(Boolean) as string[];

    for (const base of pf) {
      const adobe = path.join(base, "Adobe");
      if (!fs.existsSync(adobe)) continue;
      let entries: string[] = [];
      try {
        entries = fs.readdirSync(adobe);
      } catch {
        continue;
      }
      const aeDirs = entries
        .filter((e) => /^Adobe After Effects/i.test(e))
        .sort()
        .reverse();
      for (const dir of aeDirs) {
        const exe = path.join(adobe, dir, "Support Files", "AfterFX.exe");
        if (fs.existsSync(exe)) return exe;
      }
    }
    return null;
  }

  if (process.platform === "darwin") {
    const apps = "/Applications";
    if (fs.existsSync(apps)) {
      const entries = fs
        .readdirSync(apps)
        .filter((e) => /^Adobe After Effects/i.test(e))
        .sort()
        .reverse();
      for (const e of entries) {
        const appPath = path.join(apps, e);
        if (fs.existsSync(appPath)) return appPath;
      }
    }
  }
  return null;
}

export function getEnsureScriptPath(): string {
  return path.join(getHostScriptsDir(), "ae-mcp-ensure.jsx");
}

/**
 * Inject ensure via AfterFX -r. ALWAYS shows AE "Executing script…" briefly.
 * Only for explicit user action (ae_reconnect / CLI ensure). Never automatic.
 */
export function kickAeBridge(options?: {
  force?: boolean;
}): { kicked: boolean; message: string; afterFxPath: string | null; skipped?: boolean } {
  const force = options?.force === true;
  if (!force) {
    return {
      kicked: false,
      skipped: true,
      message:
        "Automatic AE script inject is disabled (prevents 'Executing script…' popups). Use ae_reconnect or: node dist/index.js ensure",
      afterFxPath: findAfterEffectsExecutable(),
    };
  }

  const gate = canKickNow(true);
  if (!gate.ok) {
    const secs = Math.ceil(gate.waitMs / 1000);
    return {
      kicked: false,
      skipped: true,
      message: `Reconnect cooldown (${secs}s). Wait a moment to avoid popup spam.`,
      afterFxPath: findAfterEffectsExecutable(),
    };
  }

  const script = getEnsureScriptPath();
  if (!fs.existsSync(script)) {
    return {
      kicked: false,
      message: `Missing ensure script: ${script}`,
      afterFxPath: null,
    };
  }

  if (!isAfterEffectsRunning()) {
    return {
      kicked: false,
      message: "After Effects is not running.",
      afterFxPath: null,
    };
  }

  const afterFx = findAfterEffectsExecutable();
  if (!afterFx) {
    return {
      kicked: false,
      message: "Could not locate AfterFX.exe.",
      afterFxPath: null,
    };
  }

  try {
    recordKick();
    const child = spawn(afterFx, ["-r", script], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    log.info("manual AE bridge kick", { afterFx, script });
    return {
      kicked: true,
      message: `Injected ensure into AE (you may see one brief 'Executing script…').`,
      afterFxPath: afterFx,
    };
  } catch (err) {
    return {
      kicked: false,
      message: err instanceof Error ? err.message : String(err),
      afterFxPath: afterFx,
    };
  }
}

export async function waitForLiveInstance(timeoutMs = 12_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (listLiveInstances(60_000).length > 0) return true;
    await sleep(250);
  }
  return listLiveInstances(60_000).length > 0;
}

/**
 * Status / optional manual reconnect only.
 * neverKick (default for health): never AfterFX -r
 * forceKick: user-initiated reconnect only
 */
export async function ensureBridgeConnected(options?: {
  forceKick?: boolean;
  waitMs?: number;
  neverKick?: boolean;
}): Promise<EnsureResult> {
  const waitMs = options?.waitMs ?? 8_000;
  const aeRunning = isAfterEffectsRunning();
  let instances = listLiveInstances(60_000).length;

  if (instances > 0 && !options?.forceKick) {
    return {
      ok: true,
      kicked: false,
      aeRunning,
      afterFxPath: findAfterEffectsExecutable(),
      message: "Bridge already live",
      instances,
    };
  }

  if (!aeRunning) {
    return {
      ok: false,
      kicked: false,
      aeRunning: false,
      afterFxPath: findAfterEffectsExecutable(),
      message: "After Effects is not running.",
      instances: 0,
    };
  }

  // Default path: never auto-inject (this is what was causing recurring popups)
  if (!options?.forceKick || options?.neverKick) {
    return {
      ok: instances > 0,
      kicked: false,
      skipped: true,
      aeRunning: true,
      afterFxPath: findAfterEffectsExecutable(),
      message:
        instances > 0
          ? "Bridge live"
          : "No live bridge heartbeat. Restart After Effects once so Startup/ae-mcp-bootstrap.jsx loads (silent). Or run ae_reconnect once if AE is already up.",
      instances,
    };
  }

  const kick = kickAeBridge({ force: true });
  if (!kick.kicked) {
    return {
      ok: false,
      kicked: false,
      skipped: kick.skipped,
      aeRunning: true,
      afterFxPath: kick.afterFxPath,
      message: kick.message,
      instances: listLiveInstances(60_000).length,
    };
  }

  const live = await waitForLiveInstance(waitMs);
  instances = listLiveInstances(60_000).length;

  return {
    ok: live,
    kicked: true,
    aeRunning: true,
    afterFxPath: kick.afterFxPath,
    message: live
      ? "Bridge reconnected (one manual inject)."
      : "Injected ensure but no heartbeat yet. Fully quit and reopen AE so Startup bootstrap loads.",
    instances,
  };
}

/** Watchdog permanently disabled — it caused recurring "Executing script…" popups. */
export function startBridgeWatchdog(_intervalMs?: number): NodeJS.Timeout | null {
  log.info("bridge watchdog permanently disabled (prevents Executing script popups)");
  return null;
}
