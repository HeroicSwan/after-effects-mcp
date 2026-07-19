import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDataRoot, getPackageRoot, ensureDataDirs } from "../util/paths.js";
import { log } from "../util/logging.js";

export type ProviderId = "grok" | "codex" | "claude-desktop" | "cursor" | "claude-code" | "chatgpt";

export const PROVIDERS: {
  id: ProviderId;
  label: string;
  description: string;
}[] = [
  { id: "grok", label: "Grok", description: "~/.grok/config.toml" },
  { id: "codex", label: "Codex", description: "~/.codex/config.toml" },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    description: "claude_desktop_config.json",
  },
  { id: "cursor", label: "Cursor", description: "~/.cursor/mcp.json" },
  { id: "claude-code", label: "Claude Code", description: "~/.mcp.json or project .mcp.json" },
  { id: "chatgpt", label: "ChatGPT", description: "~/.ae-mcp/chatgpt-setup.json (remote MCP)" },
];

export interface SetupResult {
  provider: ProviderId;
  ok: boolean;
  path?: string;
  message: string;
}

function serverEntry(distIndex: string): { command: string; args: string[] } {
  return {
    command: process.execPath, // node
    args: [distIndex.replace(/\\/g, "/"), "serve"],
  };
}

function writeInstallMeta(distIndex: string): void {
  ensureDataDirs();
  const meta = {
    packageRoot: getPackageRoot(),
    distIndex,
    node: process.execPath,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(getDataRoot(), "install.json"),
    JSON.stringify(meta, null, 2),
    "utf8",
  );
}

/** Resolve path to dist/index.js for MCP configs. */
export function resolveDistIndex(): string {
  const pkg = getPackageRoot();
  const dist = path.join(pkg, "dist", "index.js");
  if (fs.existsSync(dist)) return dist;
  // fallback: same folder as this file when bundled
  const alt = path.join(pkg, "index.js");
  return fs.existsSync(alt) ? alt : dist;
}

function setupGrok(distIndex: string): SetupResult {
  const configPath = path.join(os.homedir(), ".grok", "config.toml");
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });

  const block = `
[mcp_servers.ae-mcp]
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(distIndex.replace(/\\/g, "/"))}, "serve"]
enabled = true
startup_timeout_sec = 30
tool_timeout_sec = 120
`.trim();

  let existing = "";
  if (fs.existsSync(configPath)) {
    existing = fs.readFileSync(configPath, "utf8");
  }

  if (/\[mcp_servers\.ae-mcp\]/.test(existing)) {
    // Replace existing ae-mcp section (until next [ section or EOF)
    const replaced = existing.replace(
      /\[mcp_servers\.ae-mcp\][\s\S]*?(?=\n\[|\s*$)/,
      block + "\n",
    );
    fs.writeFileSync(configPath, replaced.endsWith("\n") ? replaced : replaced + "\n", "utf8");
  } else {
    const sep = existing && !existing.endsWith("\n") ? "\n\n" : existing ? "\n" : "";
    fs.writeFileSync(configPath, existing + sep + block + "\n", "utf8");
  }

  return {
    provider: "grok",
    ok: true,
    path: configPath,
    message: "Grok MCP config written. Restart Grok to load ae-mcp.",
  };
}

function setupCodex(distIndex: string): SetupResult {
  const configPath = path.join(os.homedir(), ".codex", "config.toml");
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  const block = `
[mcp_servers.ae-mcp]
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(distIndex.replace(/\\/g, "/"))}, "serve"]
startup_timeout_sec = 30
tool_timeout_sec = 120
`.trim();
  const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  const replaced = /\[mcp_servers\.ae-mcp\]/.test(existing)
    ? existing.replace(/\[mcp_servers\.ae-mcp\][\s\S]*?(?=\n\[|\s*$)/, block + "\n")
    : (existing ? existing.replace(/\s*$/, "\n\n") : "") + block + "\n";
  fs.writeFileSync(configPath, replaced, "utf8");
  return { provider: "codex", ok: true, path: configPath, message: "Codex MCP config written. Restart Codex to load ae-mcp." };
}

function setupJsonMcpConfig(
  configPath: string,
  serverName: string,
  distIndex: string,
  provider: ProviderId,
): SetupResult {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  let root: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      root = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    } catch {
      root = {};
    }
  }

  // Claude Desktop uses mcpServers; Cursor often uses mcpServers too
  const key = root.mcpServers ? "mcpServers" : root.mcp ? "mcp" : "mcpServers";
  const servers =
    (root[key] as Record<string, unknown> | undefined) &&
    typeof root[key] === "object" &&
    root[key] !== null
      ? { ...(root[key] as Record<string, unknown>) }
      : {};

  const entry = serverEntry(distIndex);
  servers[serverName] = {
    command: entry.command,
    args: entry.args,
  };
  root[key] = servers;

  fs.writeFileSync(configPath, JSON.stringify(root, null, 2) + "\n", "utf8");
  return {
    provider,
    ok: true,
    path: configPath,
    message: `Wrote ${serverName} to ${configPath}. Restart the client.`,
  };
}

function setupClaudeDesktop(distIndex: string): SetupResult {
  const configPath =
    process.platform === "win32"
      ? path.join(process.env.APPDATA || "", "Claude", "claude_desktop_config.json")
      : path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  return setupJsonMcpConfig(configPath, "ae-mcp", distIndex, "claude-desktop");
}

function setupCursor(distIndex: string): SetupResult {
  // User-level Cursor MCP config
  const configPath = path.join(os.homedir(), ".cursor", "mcp.json");
  return setupJsonMcpConfig(configPath, "ae-mcp", distIndex, "cursor");
}

function setupClaudeCode(distIndex: string): SetupResult {
  // User home .mcp.json (common for Claude Code)
  const configPath = path.join(os.homedir(), ".mcp.json");
  return setupJsonMcpConfig(configPath, "ae-mcp", distIndex, "claude-code");
}

function setupChatGPT(distIndex: string): SetupResult {
  const setupPath = path.join(getDataRoot(), "chatgpt-setup.json");
  const guidePath = path.join(getDataRoot(), "chatgpt-setup.md");
  const publicUrl = process.env.AE_MCP_CHATGPT_MCP_URL || "";
  const setup = {
    name: "ae-mcp",
    transport: "streamable-http",
    url: publicUrl || "REPLACE_WITH_PUBLIC_HTTPS_MCP_URL",
    localServer: { command: process.execPath, args: [distIndex.replace(/\\/g, "/"), "serve"] },
    note: "ChatGPT needs a publicly reachable HTTPS MCP endpoint; the local stdio command is included for a relay/deployment setup.",
  };
  fs.writeFileSync(setupPath, JSON.stringify(setup, null, 2) + "\n", "utf8");
  fs.writeFileSync(guidePath, [
    "# Connect ae-mcp to ChatGPT",
    "",
    "ChatGPT cannot directly launch this Windows-local stdio server. It needs a remotely reachable HTTPS MCP endpoint.",
    "",
    "1. Deploy or tunnel ae-mcp behind an authenticated HTTPS MCP relay.",
    `2. Set AE_MCP_CHATGPT_MCP_URL to that URL and run this setup again, or edit ${setupPath}.`,
    "3. In ChatGPT, add the remote MCP app/connector using the URL in chatgpt-setup.json.",
    "4. Keep After Effects and the local bridge running on the machine that hosts the relay.",
    "",
    "Security: do not expose the unauthenticated local bridge directly to the public internet.",
  ].join("\n"), "utf8");
  return {
    provider: "chatgpt",
    ok: true,
    path: guidePath,
    message: publicUrl
      ? "ChatGPT remote MCP setup written. Add the HTTPS URL in ChatGPT and authorize it."
      : "ChatGPT setup guide written. Add a public HTTPS MCP URL before connecting ChatGPT.",
  };
}

/** Write install.json for the AE panel (node path + dist). */
export function writeInstallRecord(): string {
  const distIndex = resolveDistIndex();
  writeInstallMeta(distIndex);
  return distIndex;
}

export function setupClients(providers: ProviderId[] | "all" | []): SetupResult[] {
  const distIndex = writeInstallRecord();

  const list: ProviderId[] =
    providers === "all"
      ? PROVIDERS.map((p) => p.id)
      : Array.isArray(providers)
        ? providers
        : [];

  if (list.length === 0) {
    return [];
  }

  const results: SetupResult[] = [];
  for (const id of list) {
    try {
      switch (id) {
        case "grok":
          results.push(setupGrok(distIndex));
          break;
        case "codex":
          results.push(setupCodex(distIndex));
          break;
        case "claude-desktop":
          results.push(setupClaudeDesktop(distIndex));
          break;
        case "cursor":
          results.push(setupCursor(distIndex));
          break;
        case "claude-code":
          results.push(setupClaudeCode(distIndex));
          break;
        case "chatgpt":
          results.push(setupChatGPT(distIndex));
          break;
        default:
          results.push({
            provider: id,
            ok: false,
            message: `Unknown provider: ${id}`,
          });
      }
    } catch (err) {
      results.push({
        provider: id,
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Write panel-friendly summary
  ensureDataDirs();
  fs.writeFileSync(
    path.join(getDataRoot(), "client-setup.json"),
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        distIndex,
        results,
      },
      null,
      2,
    ),
    "utf8",
  );

  for (const r of results) {
    if (r.ok) log.info(`setup ${r.provider}: ${r.path}`);
    else log.warn(`setup ${r.provider} failed: ${r.message}`);
  }

  return results;
}

export function parseProviderList(raw: string | undefined): ProviderId[] | "all" {
  if (!raw || raw === "all") return "all";
  const parts = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const valid = new Set(PROVIDERS.map((p) => p.id));
  const out: ProviderId[] = [];
  for (const p of parts) {
    if (valid.has(p as ProviderId)) out.push(p as ProviderId);
  }
  return out.length ? out : "all";
}
