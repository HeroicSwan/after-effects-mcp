/**
 * Live E2E against After Effects file bridge.
 * Usage: node scripts/e2e-live.mjs
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist", "index.js");
const dataRoot = path.join(os.homedir(), ".ae-mcp");
const instRoot = path.join(dataRoot, "instances");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
    child.on("error", reject);
  });
}

function listLive(staleMs = 15000) {
  if (!fs.existsSync(instRoot)) return [];
  const now = Date.now();
  const out = [];
  for (const name of fs.readdirSync(instRoot)) {
    const hbPath = path.join(instRoot, name, "instance.json");
    if (!fs.existsSync(hbPath)) continue;
    try {
      const hb = JSON.parse(fs.readFileSync(hbPath, "utf8"));
      const last = Date.parse(hb.lastSeen);
      if (Number.isNaN(last) || now - last > staleMs) continue;
      out.push(hb);
    } catch {
      /* skip */
    }
  }
  return out.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

async function invoke(method, args = {}, timeoutMs = 20000) {
  const live = listLive();
  if (!live.length) throw new Error("No live AE instance");
  const id = live[0].instanceId;
  const dir = path.join(instRoot, id);
  const requestId = randomUUID();
  const commandPath = path.join(dir, "command.json");
  const resultPath = path.join(dir, "result.json");
  try {
    if (fs.existsSync(resultPath)) fs.unlinkSync(resultPath);
  } catch {
    /* ignore */
  }

  const cmd = {
    protocolVersion: 1,
    requestId,
    op: method === "system.ping" ? "ping" : "invoke",
    method,
    args,
    meta: { undoName: `E2E: ${method}`, timeoutMs },
    createdAt: new Date().toISOString(),
  };
  const tmp = commandPath + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cmd, null, 2));
  fs.renameSync(tmp, commandPath);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(resultPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(resultPath, "utf8"));
        if (raw.requestId === requestId) {
          try {
            fs.unlinkSync(resultPath);
          } catch {
            /* ignore */
          }
          if (!raw.ok) {
            throw new Error(raw.error?.message || "AE error");
          }
          return raw.data;
        }
      } catch (e) {
        if (e.message !== "Unexpected end of JSON input") throw e;
      }
    }
    await sleep(50);
  }
  throw new Error(`Timeout waiting for ${method}`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  console.log("=== ae-mcp live E2E ===\n");

  const healthCli = await runNode([dist, "health"]);
  console.log(healthCli.out.trim());
  if (healthCli.err) console.log(healthCli.err.trim());

  let live = listLive();
  if (!live.length) {
    console.log(`
BRIDGE NOT CONNECTED (no live heartbeat under ${instRoot})

In After Effects do ALL of:
1. Edit → Preferences → Scripting & Expressions
   ✓ Allow Scripts to Write Files and Access Network
2. File → Scripts → Run Script File…
   → ${path.join(root, "host-scripts", "ae-mcp-probe.jsx")}
   OR Window → ae-mcp-status.jsx → Kick poller
3. Re-run: node scripts/e2e-live.mjs

Full quit + restart AE also reloads Startup bootstrap.
`);
    process.exit(1);
  }

  console.log("\nLive instance:", live[0].instanceId, live[0].aeVersion);

  const runId = Date.now().toString(36);
  const compName = `ae-mcp E2E ${runId}`;
  const layerName = `Headline ${runId}`;

  const steps = [];
  const pass = (name, data) => {
    steps.push({ name, ok: true, data });
    console.log(`✓ ${name}`);
  };
  const fail = (name, err) => {
    steps.push({ name, ok: false, err: String(err) });
    console.error(`✗ ${name}: ${err}`);
  };

  try {
    const h = await invoke("system.health");
    assert(h.connected === true, "health.connected");
    pass("system.health", h);
  } catch (e) {
    fail("system.health", e);
    process.exit(1);
  }

  try {
    const comp = await invoke("comp.create", {
      name: compName,
      width: 1920,
      height: 1080,
      duration: 5,
      frameRate: 30,
      bgColor: [0.05, 0.05, 0.08],
    });
    assert(comp.name === compName, "comp name");
    pass("comp.create", { name: comp.name, layers: comp.numLayers });
  } catch (e) {
    fail("comp.create", e);
  }

  try {
    const layer = await invoke("layer.create", {
      comp_name: compName,
      type: "text",
      name: layerName,
      text: "Hello ae-mcp",
      fontSize: 96,
      fillColor: [1, 1, 1],
      position: [960, 540],
    });
    assert(layer.name === layerName, "layer name");
    pass("layer.create text", layer);
  } catch (e) {
    fail("layer.create text", e);
  }

  try {
    const keys = await invoke("anim.setKeyframes", {
      comp_name: compName,
      layer_name: layerName,
      property: "Transform/Opacity",
      keyframes: [
        { time: 0, value: 0 },
        { time: 0.5, value: 100 },
      ],
    });
    assert(keys.keyCount >= 2, "keyCount");
    pass("anim.setKeyframes", keys);
  } catch (e) {
    fail("anim.setKeyframes", e);
  }

  try {
    const expr = await invoke("anim.setExpression", {
      comp_name: compName,
      layer_name: layerName,
      property: "Transform/Position",
      expression: "wiggle(2, 20)",
    });
    assert(expr.expressionEnabled === true, "expression on");
    pass("anim.setExpression", { enabled: expr.expressionEnabled });
  } catch (e) {
    fail("anim.setExpression", e);
  }

  try {
    const fx = await invoke("fx.apply", {
      comp_name: compName,
      layer_name: layerName,
      effect: "Gaussian Blur",
    });
    pass("fx.apply Gaussian Blur", fx);
    await invoke("fx.setProperty", {
      comp_name: compName,
      layer_name: layerName,
      effect_name: fx.name,
      property: "Blurriness",
      value: 12,
    });
    pass("fx.setProperty Blurriness", { value: 12 });
  } catch (e) {
    fail("fx.apply/set", e);
  }

  try {
    const frame = await invoke(
      "view.captureFrame",
      {
        comp_name: compName,
        time: 1,
      },
      60000,
    );
    assert(frame.path, "frame.path missing");
    // AE may create a 0-byte file before finishing the PNG write
    let size = 0;
    for (let i = 0; i < 50; i++) {
      if (fs.existsSync(frame.path)) {
        size = fs.statSync(frame.path).size;
        if (size > 1000) break;
      }
      await sleep(100);
    }
    assert(size > 1000, `png missing/too small at ${frame.path} (${size} bytes)`);
    pass("view.captureFrame", { path: frame.path, bytes: size });
  } catch (e) {
    fail("view.captureFrame", e);
  }

  const failed = steps.filter((s) => !s.ok);
  console.log(`\n=== ${steps.length - failed.length}/${steps.length} passed ===`);
  if (failed.length) {
    process.exit(1);
  }
  console.log("\nLive E2E OK — AE is responding to ae-mcp.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
