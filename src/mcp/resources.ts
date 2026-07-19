import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { broker } from "../broker/broker.js";
import { HostMethods } from "../bridge/protocol.js";
import { jsonText } from "../util/format.js";
import { getWorkflowPreferences } from "../workflow/preferences.js";

const EXPRESSIONS_DOC = `# After Effects Expression Snippets

## Motion
- wiggle(freq, amp): wiggle(2, 30)
- loopOut: loopOut("cycle")
- smooth follow: delay = 5; thisComp.layer("Null 1").transform.position.valueAtTime(time - framesToTime(delay))

## Text / UI
- time-based fade: ease(time, 0, 1, 0, 100)  // opacity

## Linking
- parent-like position without parenting: thisComp.layer("Controller").toWorld([0,0,0])

## Random stable
- seedRandom(index, true); random(0, 100)

Prefer ae_set_expression tool with property path Transform/Position etc.
`;

const MATCHNAMES_DOC = `# Common matchNames

## Transform
- ADBE Transform Group
- ADBE Position / ADBE Scale / ADBE Rotate Z / ADBE Opacity / ADBE Anchor Point

## Effects (examples)
- Gaussian Blur: ADBE Gaussian Blur 2
- Fill: ADBE Fill
- Drop Shadow: ADBE Drop Shadow
- Curves: ADBE Easy Levels2
- Tint: ADBE Tint

## Text
- ADBE Text Properties
- ADBE Text Document

Use ae_apply_effect with display name or matchName.
`;

const GOTCHAS_DOC = `# AE Scripting Gotchas for Agents

1. Enable: Preferences > Scripting & Expressions > Allow Scripts to Write Files and Access Network
2. Connect via Window > ae-mcp-status.jsx > CONNECT BRIDGE (Startup is inert to avoid modal errors)
3. ExtendScript is ES3 — use var/function in ae_run_jsx
4. Layer indexes are 1-based
5. Colors are RGB floats 0–1, not 0–255
6. Opacity is 0–100, scale is percent [100,100]
7. Always undo-grouped via tools
8. After visual changes, call ae_capture_frame
9. Prefer layer_name over index
10. Large projects: use ae_search

## Subtitles (mandatory)

- NEVER add a black bar / solid / plate behind subtitles unless the user explicitly asks.
- Use ae_create_subtitle (stroke only by default).
- Do not invent Sub Bar solids for "readability".

## Cutting video (mandatory)

- NEVER use random or evenly spaced cuts.
- For professional YouTube edits, prefer ae_transcribe_video → ae_create_editorial_plan → ae_audit_editorial_plan → ae_build_youtube_edit.
- Use ae_analyze_cuts for silence-only cleanup when transcript-based editing is unavailable.
- Long silences are only one signal; never cut at fixed intervals.

## Real 3D (Blender)

- When user asks for 3D models: ae_prepare_blender_3d_job → blender execute_blender_code → ae_import_3d_from_blender
- Do not only use CC Sphere when Blender is available and user wants real 3D
- Exchange folder: ~/.ae-mcp/blender-exchange/<jobId>/
`;

export function registerResources(server: McpServer): void {
  server.resource(
    "ae-health",
    "ae://health",
    { description: "Bridge and AE connection status", mimeType: "application/json" },
    async () => {
      const instances = broker.listInstances();
      let health: unknown = null;
      try {
        if (instances.length) {
          const r = await broker.invoke({ method: HostMethods.HEALTH, timeoutMs: 5_000 });
          health = r.data;
        }
      } catch (e) {
        health = { error: String(e) };
      }
      return {
        contents: [
          {
            uri: "ae://health",
            mimeType: "application/json",
            text: jsonText({ instances, health }),
          },
        ],
      };
    },
  );

  server.resource(
    "ae-project",
    "ae://project",
    { description: "Active project summary", mimeType: "application/json" },
    async () => {
      try {
        const r = await broker.invoke({ method: HostMethods.PROJECT_INFO });
        return {
          contents: [{ uri: "ae://project", mimeType: "application/json", text: jsonText(r.data) }],
        };
      } catch (e) {
        return {
          contents: [
            {
              uri: "ae://project",
              mimeType: "application/json",
              text: jsonText({ error: String(e) }),
            },
          ],
        };
      }
    },
  );

  server.resource(
    "ae-compositions",
    "ae://compositions",
    { description: "Composition index", mimeType: "application/json" },
    async () => {
      try {
        const r = await broker.invoke({ method: HostMethods.PROJECT_LIST_COMPS });
        return {
          contents: [
            { uri: "ae://compositions", mimeType: "application/json", text: jsonText(r.data) },
          ],
        };
      } catch (e) {
        return {
          contents: [
            {
              uri: "ae://compositions",
              mimeType: "application/json",
              text: jsonText({ error: String(e) }),
            },
          ],
        };
      }
    },
  );

  server.resource(
    "ae-docs-expressions",
    "ae://docs/expressions",
    { description: "Expression snippets for agents", mimeType: "text/markdown" },
    async () => ({
      contents: [{ uri: "ae://docs/expressions", mimeType: "text/markdown", text: EXPRESSIONS_DOC }],
    }),
  );

  server.resource(
    "ae-docs-matchnames",
    "ae://docs/matchnames",
    { description: "Common property/effect matchNames", mimeType: "text/markdown" },
    async () => ({
      contents: [{ uri: "ae://docs/matchnames", mimeType: "text/markdown", text: MATCHNAMES_DOC }],
    }),
  );

  server.resource(
    "ae-docs-gotchas",
    "ae://docs/gotchas",
    { description: "Scripting gotchas and agent workflow rules", mimeType: "text/markdown" },
    async () => ({
      contents: [{ uri: "ae://docs/gotchas", mimeType: "text/markdown", text: GOTCHAS_DOC }],
    }),
  );

  server.resource(
    "ae-workflow",
    "ae://workflow",
    { description: "Autonomous/approval workflow and brand configuration", mimeType: "application/json" },
    async () => ({
      contents: [{ uri: "ae://workflow", mimeType: "application/json", text: jsonText(getWorkflowPreferences()) }],
    }),
  );
}
