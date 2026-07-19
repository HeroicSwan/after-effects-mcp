import fs from "node:fs";
import path from "node:path";
import {
  discoverAeScriptStartupDirs,
  discoverAeScriptUiPanelDirs,
  getHostScriptsDir,
} from "../util/paths.js";
import { log } from "../util/logging.js";
import { writeInstallRecord } from "./setup-clients.js";

const BOOTSTRAP_NAME = "ae-mcp-bootstrap.jsx";
const ENGINE_NAME = "ae-mcp-engine.jsx";
const METHODS_NAME = "ae-mcp-methods.jsx";
const PANEL_NAME = "ae-mcp-status.jsx";

/** Files that must NOT sit in Startup (AE auto-runs every .jsx there). */
const STARTUP_FORBIDDEN = [
  "ae-mcp-ensure.jsx",
  "ae-mcp-methods.jsx",
  "ae-mcp-engine.jsx",
  "ae-mcp-probe.jsx",
  "ae-mcp-status.jsx",
];

export interface InstallResult {
  installed: string[];
  removed: string[];
  failed: { path: string; error: string }[];
  source: string;
}

function aeScriptsRootFromStartup(startupDir: string): string {
  // .../Scripts/Startup -> .../Scripts
  return path.dirname(startupDir);
}

export function installBridge(_options?: { force?: boolean }): InstallResult {
  const hostDir = getHostScriptsDir();
  const bootstrapSrc = path.join(hostDir, BOOTSTRAP_NAME);
  const engineSrc = path.join(hostDir, ENGINE_NAME);
  const methodsSrc = path.join(hostDir, METHODS_NAME);
  const panelSrc = path.join(hostDir, PANEL_NAME);

  if (!fs.existsSync(bootstrapSrc)) {
    throw new Error(`Missing ${bootstrapSrc}`);
  }
  if (!fs.existsSync(engineSrc)) {
    throw new Error(`Missing ${engineSrc}`);
  }

  const bootstrapContent = fs.readFileSync(bootstrapSrc, "utf8");
  const engineContent = fs.readFileSync(engineSrc, "utf8");
  const methodsContent = fs.existsSync(methodsSrc)
    ? fs.readFileSync(methodsSrc, "utf8")
    : null;
  const panelContent = fs.existsSync(panelSrc)
    ? fs.readFileSync(panelSrc, "utf8")
    : null;

  const installed: string[] = [];
  const removed: string[] = [];
  const failed: { path: string; error: string }[] = [];

  const startupDirs = discoverAeScriptStartupDirs();

  for (const startupDir of startupDirs) {
    try {
      fs.mkdirSync(startupDir, { recursive: true });

      // Remove forbidden auto-run scripts from Startup
      for (const bad of STARTUP_FORBIDDEN) {
        const badPath = path.join(startupDir, bad);
        if (fs.existsSync(badPath)) {
          fs.unlinkSync(badPath);
          removed.push(badPath);
          log.info(`Removed from Startup (was auto-running) → ${badPath}`);
        }
      }

      // ONLY inert bootstrap in Startup
      const bootDest = path.join(startupDir, BOOTSTRAP_NAME);
      fs.writeFileSync(bootDest, bootstrapContent, "utf8");
      installed.push(bootDest);
      log.info(`Installed inert Startup → ${bootDest}`);

      // Engine + methods in Scripts/ae-mcp/ (NOT auto-run)
      const scriptsRoot = aeScriptsRootFromStartup(startupDir);
      const libDir = path.join(scriptsRoot, "ae-mcp");
      fs.mkdirSync(libDir, { recursive: true });

      const engineDest = path.join(libDir, ENGINE_NAME);
      fs.writeFileSync(engineDest, engineContent, "utf8");
      installed.push(engineDest);
      log.info(`Installed engine → ${engineDest}`);

      if (methodsContent) {
        const methodsDest = path.join(libDir, METHODS_NAME);
        fs.writeFileSync(methodsDest, methodsContent, "utf8");
        installed.push(methodsDest);
        log.info(`Installed methods → ${methodsDest}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push({ path: startupDir, error: message });
      log.warn(`Failed install for ${startupDir}: ${message}`);
    }
  }

  // Connect panel
  for (const dir of discoverAeScriptUiPanelDirs()) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (panelContent) {
        const panelPath = path.join(dir, PANEL_NAME);
        fs.writeFileSync(panelPath, panelContent, "utf8");
        installed.push(panelPath);
        log.info(`Installed panel → ${panelPath}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push({ path: dir, error: message });
    }
  }

  try {
    writeInstallRecord();
  } catch {
    /* optional */
  }

  return { installed, removed, failed, source: bootstrapSrc };
}
