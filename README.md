# After Effects MCP

**A production-minded Model Context Protocol server for Adobe After Effects.**

Headless Startup bridge · sync tool calls · hybrid high-level tools + JSX escape hatch · composition frame capture as images · resources & prompts for agents.

Build motion graphics, review cuts, and render YouTube-ready projects from an MCP client while keeping After Effects as the execution environment.

## Documentation

- [Installation guide](docs/INSTALLATION.md)
- [Usage guide](docs/USAGE.md)
- [Changelog](CHANGELOG.md)
- [Join the Discord](https://discord.gg/KAPMFcApuG)

## Features

- **Headless by default** — no “open panel + Auto-run” required
- **Sync-feeling RPC** — tools wait for AE (request IDs, timeouts, clear errors)
- **Motion tools** — comps, layers (text/shape/solid/null/camera…), keyframes, expressions, effects
- **Vision** — `ae_capture_frame` returns a PNG still so agents can verify work
- **Resources** — `ae://project`, `ae://docs/*`
- **Prompts** — lower-third, kinetic type, debug comp
- **Companion skill** — `skills/after-effects-mcp/SKILL.md`
- **Editorial planning** — sentence-aware cut scoring, explainable EDLs, clean/retention/story modes, YouTube structure, chapters, and b-roll/graphic suggestions
- **Quality workflow** — multi-frame QA, saved preview reviews, approve/reject decisions, and autonomous or approval-gated builds
- **Motion system** — reusable brand-aware hook, lower-third, chapter, statistic, quote, subscribe, and end-screen templates
- **Export presets** — automatic MP4, MOV, and PNG render presets with explicit output paths

## Requirements

- Adobe After Effects **2022+**
- Node.js **20+**
- AE preference: **Edit → Preferences → Scripting & Expressions → Allow Scripts to Write Files and Access Network**

## Connection model (important)

| When | What you do |
|------|-------------|
| **One-time setup** | `install-bridge`, enable scripting file/network access, open AE once |
| **Day-to-day** | Leave **After Effects open**. Only restart the **AI client** (Grok / Claude / Cursor) |
| **If tools go quiet** | AI client restart is enough — MCP auto-kicks the bridge into running AE. Or run `ae-mcp ensure` |

You should **not** need to restart After Effects every time you reconnect the AI.

How it works: when the MCP server starts (AI client launch), it runs `AfterFX.exe -r ae-mcp-ensure.jsx` against the **already open** AE session, restarts the headless poller, and a watchdog re-kicks if heartbeats die.

## Install

```bash
git clone https://github.com/HeroicSwan/after-effects-mcp.git ae-mcp
cd ae-mcp
npm install
npm run build
npm run install-bridge
```

If AE was already open during install, restart AE **once** so Startup bootstrap loads. After that, only restart the AI client.

```bash
npm run health
# or force reconnect without touching AE:
node dist/index.js ensure
```

## MCP client config

### Claude / Cursor / generic

```json
{
  "mcpServers": {
    "ae-mcp": {
      "command": "node",
      "args": ["C:/Users/YOU/Projects/ae-mcp/dist/index.js", "serve"]
    }
  }
}
```

### Grok / Codex / Claude Code

Point the MCP server command at `node` + absolute path to `dist/index.js` with arg `serve`.

The After Effects panel can write the Codex entry directly into `C:\Users\YOU\.codex\config.toml`. Restart Codex after installing it.

### ChatGPT

ChatGPT uses a remotely reachable HTTPS MCP endpoint rather than launching this local Windows stdio command directly. Select **ChatGPT (remote MCP)** in the After Effects panel to create `~/.ae-mcp/chatgpt-setup.json` and a setup guide. Set `AE_MCP_CHATGPT_MCP_URL` before setup if you already have an authenticated HTTPS relay. Never expose the local bridge without authentication.

## CLI

| Command | Description |
|---------|-------------|
| `ae-mcp serve` | MCP stdio server (default) |
| `ae-mcp health` | Check live bridge / AE |
| `ae-mcp install-bridge` | Copy Startup bootstrap into AE script folders |

## Typical agent workflow

1. `ae_health`
2. `ae_create_composition` / `ae_get_composition`
3. `ae_create_layer` → `ae_set_keyframes` / `ae_set_expression` / `ae_apply_effect`
4. `ae_capture_frame` — **look at the still**
5. Iterate

## Tool catalog (v0.1)

| Tool | Purpose |
|------|---------|
| `ae_health` | Connection + project snapshot |
| `ae_list_instances` | Live AE instances |
| `ae_get_project_info` | Project summary |
| `ae_list_compositions` | Comp index |
| `ae_get_composition` | Comp + layers |
| `ae_create_composition` | New comp |
| `ae_get_layer` / `ae_create_layer` / `ae_set_layer_properties` | Layers |
| `ae_duplicate_layer` / `ae_delete_layer` | Layer ops (`confirm` for delete) |
| `ae_set_keyframes` / `ae_set_expression` | Animation |
| `ae_apply_effect` / `ae_set_effect_property` / `ae_list_effects` / `ae_remove_effect` | Effects |
| `ae_search` | Find items/layers by name |
| `ae_capture_frame` | PNG still (+ image content) |
| `ae_capture_frames` | Multi-frame visual QA manifest |
| `ae_create_editorial_plan` | Sentence-aware YouTube edit decision list |
| `ae_audit_editorial_plan` | Pacing, hook, coverage, and cut-quality audit |
| `ae_build_youtube_edit` | Approval-aware YouTube edit builder |
| `ae_create_motion_template` | Brand-aware reusable AE motion graphic |
| `ae_render_composition` | Automatic AE render/export preset |
| `ae_create_review` / `ae_decide_review` | Preview approval workflow |
| `ae_run_jsx` | Escape hatch |

## Architecture

```
MCP client → ae-mcp (stdio) → in-process broker → ~/.ae-mcp/instances/<id>/
                                                     command.json → result.json
                                              ← AE Startup bootstrap.jsx
```

## Development

```bash
npm run build
npm test
npm run typecheck
```

Before publishing changes, run the full local release check described in [the installation guide](docs/INSTALLATION.md).

## License

MIT
