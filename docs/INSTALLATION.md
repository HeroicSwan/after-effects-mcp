# After Effects MCP installation

## Requirements

- Windows 10 or 11
- Adobe After Effects 2022 or newer
- Node.js 20 or newer
- Permission to run scripts and access files/network in After Effects

In After Effects, enable **Edit → Preferences → Scripting & Expressions → Allow Scripts to Write Files and Access Network**.

## Install

```powershell
git clone https://github.com/HeroicSwan/after-effects-mcp.git ae-mcp
cd ae-mcp
npm install
npm run build
npm run install-bridge
```

If After Effects was already open, restart it once after installing the bridge. Open **Window → ae-mcp-status.jsx**, then click **CONNECT BRIDGE**. A healthy panel shows the bridge listening.

Check the connection from PowerShell:

```powershell
npm run health
```

## Connect an MCP client

For a generic stdio client, use `node` with an absolute path to `dist/index.js` and the argument `serve`:

```json
{
  "mcpServers": {
    "after-effects-mcp": {
      "command": "node",
      "args": ["C:/Users/YOU/Projects/ae-mcp/dist/index.js", "serve"]
    }
  }
}
```

The After Effects connector panel can write setup entries for Grok, Claude, Codex, Claude Code, Cursor, and ChatGPT remote MCP. After changing a client configuration, restart that client; After Effects normally stays open.

ChatGPT requires an authenticated HTTPS MCP relay. It cannot safely launch the local Windows stdio command directly. Never expose the local bridge or its port to the public internet without authentication.

## Smoke test

With After Effects open and a project loaded, call these tools from the connected client:

1. `ae_health`
2. `ae_list_compositions`
3. `ae_capture_frame`

If the bridge is quiet, run `node dist/index.js ensure` and retry. For connector setup and scrolling issues, open the status panel at a larger height or use the panel’s client setup actions; the connector list is intentionally scrollable.

## Release check

```powershell
npm run build
npm run typecheck
npm test
npm audit --omit=dev --audit-level=high
npm pack --dry-run
```

The release check must pass before publishing a build.
