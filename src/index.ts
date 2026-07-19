import { serveStdio } from "./mcp/server.js";
import { installBridge } from "./cli/install-bridge.js";
import { ensureBridgeConnected, kickAeBridge, isAfterEffectsRunning } from "./cli/ensure-ae.js";
import { setupClients, parseProviderList, PROVIDERS, writeInstallRecord } from "./cli/setup-clients.js";
import { broker } from "./broker/broker.js";
import { ensureDataDirs, getDataRoot, getHostScriptsDir } from "./util/paths.js";
import { HostMethods } from "./bridge/protocol.js";
import { log } from "./util/logging.js";
import { transcribeVideo } from "./media/transcribe.js";
import { planCutsFromTranscript } from "./media/transcriptEdit.js";
import fs from "node:fs";
import path from "node:path";

function printHelp(): void {
  const help = `
ae-mcp — After Effects Model Context Protocol server

Usage:
  ae-mcp serve              Start MCP server on stdio (default)
  ae-mcp health             Check bridge status (never injects scripts)
  ae-mcp ensure             Manual re-inject into AE (shows Executing script once)
  ae-mcp install-bridge     Install Startup bootstrap + Connect panel into AE
  ae-mcp setup-clients      One-click MCP configs for AI clients
  ae-mcp transcribe <file>  Whisper transcript with timestamps (JSON/SRT)
  ae-mcp help

setup-clients:
  ae-mcp setup-clients --providers all
  ae-mcp setup-clients --providers grok,cursor,claude-desktop,claude-code

Providers: ${PROVIDERS.map((p) => p.id).join(", ")}

In After Effects:
  Window → ae-mcp-status.jsx  →  Connect bridge  →  install client configs

Environment:
  AE_MCP_DATA_DIR           Override data dir (default: ~/.ae-mcp)
  AE_MCP_LOG_LEVEL          debug|info|warn|error
`.trim();
  console.log(help);
}

async function cmdHealth(): Promise<number> {
  ensureDataDirs();
  console.log("Data dir:", getDataRoot());
  console.log("Host scripts:", getHostScriptsDir());
  console.log("AE running:", isAfterEffectsRunning());

  const ensured = await ensureBridgeConnected({ neverKick: true, waitMs: 500 });
  console.log("Ensure:", JSON.stringify(ensured, null, 2));

  const instances = broker.listInstances();
  console.log("Live instances:", instances.length);
  console.log(JSON.stringify(instances, null, 2));

  if (!ensured.ok) {
    console.log("\n" + ensured.message);
    console.log("Silent fix: fully quit + reopen After Effects (Startup bootstrap).");
    console.log("In AE: Window → ae-mcp-status.jsx → Connect bridge");
    return 1;
  }

  try {
    const result = await broker.invoke({
      method: HostMethods.HEALTH,
      timeoutMs: 8_000,
    });
    console.log("\nHealth OK:");
    console.log(JSON.stringify(result.data, null, 2));
    return 0;
  } catch (err) {
    console.error("\nHealth failed:", err instanceof Error ? err.message : err);
    return 2;
  }
}

async function cmdEnsure(): Promise<number> {
  ensureDataDirs();
  console.log("NOTE: This runs AfterFX -r once and may show 'Executing script…'.");
  const result = await ensureBridgeConnected({ forceKick: true, waitMs: 14_000 });
  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}

function cmdInstallBridge(): number {
  const result = installBridge({ force: true });
  console.log("Source:", result.source);
  if (result.removed?.length) {
    console.log("Removed from Startup (these were causing modal errors):");
    for (const p of result.removed) console.log("  -", p);
  }
  console.log("Installed:");
  for (const p of result.installed) console.log("  +", p);
  if (result.failed.length) {
    console.log("Failed:");
    for (const f of result.failed) console.log("  ", f.path, f.error);
  }
  if (!result.installed.length) {
    console.log("\nNo install targets found.");
    return 1;
  }
  try {
    writeInstallRecord();
  } catch {
    /* ignore */
  }
  console.log(`
CRITICAL FIX APPLIED:
  Startup no longer runs the poller (that caused "modal dialog" errors).
  Only a tiny inert bootstrap remains in Startup.

How to connect:
  1. Fully quit After Effects
  2. Open AE, dismiss ALL popups until the main UI is idle
  3. Window → ae-mcp-status.jsx
  4. Click CONNECT BRIDGE  →  should show [ON] LISTENING
  5. Optional: install Grok/Cursor configs from the panel
  6. Restart the AI client
`);
  return 0;
}

function cmdSetupClients(argv: string[]): number {
  let providersRaw = "all";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--providers" && argv[i + 1]) {
      providersRaw = argv[i + 1]!;
      i++;
    }
  }
  const providers = parseProviderList(providersRaw);
  const results = setupClients(providers);
  console.log(JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log("\nRestart the AI client(s) you configured.");
  return failed.length ? 1 : 0;
}

function cmdTranscribe(argv: string[]): number {
  const file = argv[0];
  if (!file) {
    console.error("Usage: ae-mcp transcribe <video> [--model base] [--language en]");
    return 1;
  }
  let model = "base";
  let language: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--model" && argv[i + 1]) {
      model = argv[++i]!;
    } else if (argv[i] === "--language" && argv[i + 1]) {
      language = argv[++i];
    }
  }
  try {
    const doc = transcribeVideo(path.resolve(file), { model, language });
    const plan = planCutsFromTranscript(doc, {
      padBefore: 0.12,
      padAfter: 0.18,
    });
    const outDir = path.join(getDataRoot(), "transcripts");
    fs.mkdirSync(outDir, { recursive: true });
    console.log(
      JSON.stringify(
        {
          source: doc.source,
          language: doc.language,
          engine: doc.engine,
          text: doc.text,
          segments: doc.segments?.length,
          words: doc.words?.length,
          keep: plan.keep,
          keptSeconds: plan.keptSeconds,
          removedSeconds: plan.removedSeconds,
          removedSample: plan.removed.slice(0, 20),
          cleanedText: plan.cleanedText,
        },
        null,
        2,
      ),
    );
    console.error(`\nTranscripts dir: ${outDir}`);
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    return 1;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? "serve";

  switch (cmd) {
    case "serve":
    case "stdio":
      await serveStdio();
      break;
    case "health":
      process.exit(await cmdHealth());
      break;
    case "ensure":
    case "reconnect":
      process.exit(await cmdEnsure());
      break;
    case "kick":
      console.log(JSON.stringify(kickAeBridge({ force: true }), null, 2));
      process.exit(0);
      break;
    case "install-bridge":
    case "install":
      process.exit(cmdInstallBridge());
      break;
    case "setup-clients":
    case "setup":
      process.exit(cmdSetupClients(args.slice(1)));
      break;
    case "transcribe":
      process.exit(cmdTranscribe(args.slice(1)));
      break;
    case "help":
    case "-h":
    case "--help":
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  log.error("fatal", err);
  console.error(err);
  process.exit(1);
});
