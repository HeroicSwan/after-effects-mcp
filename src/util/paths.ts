import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Root data directory for bridge traffic. */
export function getDataRoot(): string {
  const override = process.env.AE_MCP_DATA_DIR;
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".ae-mcp");
}

export function getInstancesRoot(): string {
  return path.join(getDataRoot(), "instances");
}

export function getPreviewsRoot(): string {
  return path.join(getDataRoot(), "previews");
}

export function getLogsRoot(): string {
  return path.join(getDataRoot(), "logs");
}

export function ensureDataDirs(): void {
  for (const dir of [getDataRoot(), getInstancesRoot(), getPreviewsRoot(), getLogsRoot()]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Package root (works in src via dist/ relative or when published). */
export function getPackageRoot(): string {
  // dist/index.js -> package root
  const fromDist = path.resolve(__dirname, "..");
  if (fs.existsSync(path.join(fromDist, "package.json"))) return fromDist;
  // src/util -> package root
  const fromSrc = path.resolve(__dirname, "../..");
  if (fs.existsSync(path.join(fromSrc, "package.json"))) return fromSrc;
  return fromDist;
}

export function getHostScriptsDir(): string {
  return path.join(getPackageRoot(), "host-scripts");
}

/**
 * Discover After Effects Scripts/Startup folders on this machine.
 * Windows: %APPDATA%/Adobe/After Effects/<version>/Scripts/Startup
 * Also Program Files install Scripts folders when writable.
 */
/** AE version folder names look like "25.0", "25.5", "22.6" — skip Logs/etc. */
function isAeVersionDir(name: string): boolean {
  return /^\d+\.\d+/.test(name);
}

export function discoverAeScriptStartupDirs(): string[] {
  const found = new Set<string>();

  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (appData) {
      const aeRoot = path.join(appData, "Adobe", "After Effects");
      if (fs.existsSync(aeRoot)) {
        for (const version of fs.readdirSync(aeRoot)) {
          if (!isAeVersionDir(version)) continue;
          // Prefer user AppData Startup (writable, standard for scripts)
          found.add(path.join(aeRoot, version, "Scripts", "Startup"));
        }
      }
    }
    // Program Files only if AE_MCP_INSTALL_SYSTEM=1 (usually needs admin)
    if (process.env.AE_MCP_INSTALL_SYSTEM === "1") {
      const programFiles = [
        process.env["ProgramFiles"],
        process.env["ProgramFiles(x86)"],
      ].filter(Boolean) as string[];

      for (const pf of programFiles) {
        const adobe = path.join(pf, "Adobe");
        if (!fs.existsSync(adobe)) continue;
        for (const entry of fs.readdirSync(adobe)) {
          if (!/^Adobe After Effects/i.test(entry)) continue;
          found.add(path.join(adobe, entry, "Support Files", "Scripts", "Startup"));
        }
      }
    }
  } else if (process.platform === "darwin") {
    const home = os.homedir();
    const userScriptRoot = path.join(
      home,
      "Documents",
      "Adobe",
      "After Effects",
    );
    if (fs.existsSync(userScriptRoot)) {
      for (const version of fs.readdirSync(userScriptRoot)) {
        if (!isAeVersionDir(version)) continue;
        found.add(path.join(userScriptRoot, version, "Scripts", "Startup"));
      }
    }
    const apps = "/Applications";
    if (fs.existsSync(apps)) {
      for (const entry of fs.readdirSync(apps)) {
        if (!/^Adobe After Effects/i.test(entry)) continue;
        found.add(path.join(apps, entry, "Scripts", "Startup"));
      }
    }
  }

  return [...found];
}

export function discoverAeScriptUiPanelDirs(): string[] {
  const found = new Set<string>();

  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (appData) {
      const aeRoot = path.join(appData, "Adobe", "After Effects");
      if (fs.existsSync(aeRoot)) {
        for (const version of fs.readdirSync(aeRoot)) {
          if (!isAeVersionDir(version)) continue;
          found.add(path.join(aeRoot, version, "Scripts", "ScriptUI Panels"));
        }
      }
    }
  } else if (process.platform === "darwin") {
    const home = os.homedir();
    const userScriptRoot = path.join(home, "Documents", "Adobe", "After Effects");
    if (fs.existsSync(userScriptRoot)) {
      for (const version of fs.readdirSync(userScriptRoot)) {
        if (!isAeVersionDir(version)) continue;
        found.add(path.join(userScriptRoot, version, "Scripts", "ScriptUI Panels"));
      }
    }
  }

  return [...found];
}

export function instanceDir(instanceId: string): string {
  // Prevent path traversal
  if (!/^[a-zA-Z0-9._-]+$/.test(instanceId)) {
    throw new Error(`Invalid instance id: ${instanceId}`);
  }
  return path.join(getInstancesRoot(), instanceId);
}
