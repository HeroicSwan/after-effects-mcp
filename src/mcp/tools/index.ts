import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { broker } from "../../broker/broker.js";
import { HostMethods } from "../../bridge/protocol.js";
import { BridgeError } from "../../bridge/client.js";
import { toolError, jsonText } from "../../util/format.js";
import fs from "node:fs";
import { getPreviewsRoot } from "../../util/paths.js";
import { ensureBridgeConnected, isAfterEffectsRunning } from "../../cli/ensure-ae.js";
import { analyzeSmartCuts } from "../../media/smartCuts.js";
import {
  blenderExportScript,
  createBlenderJob,
  listFrameSequence,
  listJobs,
  resolveJob,
  verifyBlenderJob,
} from "../../media/blenderBridge.js";
import { transcribeVideo, ensureWhisperHint } from "../../media/transcribe.js";
import {
  planCutsFromTranscript,
  toVtt,
  type TranscriptDoc,
} from "../../media/transcriptEdit.js";
import path from "node:path";
import { getDataRoot, ensureDataDirs } from "../../util/paths.js";
import { buildEditorialPlan } from "../../media/editorialPlan.js";
import { auditEditorialPlan } from "../../media/qualityAudit.js";
import { MOTION_TEMPLATES } from "../../motion/templates.js";
import { createReview, decideReview, listReviews } from "../../workflow/review.js";
import {
  getWorkflowPreferences,
  saveWorkflowPreferences,
  type EditMode,
  type WorkflowMode,
} from "../../workflow/preferences.js";
import {
  createMotionBlueprint,
  type MotionSceneInput,
  type MotionVideoBlueprint,
} from "../../workflow/motionBlueprint.js";
import { auditMotionBlueprint } from "../../workflow/coherenceAudit.js";
import { repairMotionVideoBlueprint } from "../../workflow/repairPass.js";

function textResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: jsonText(data) }],
  };
}

function errorResult(err: unknown) {
  return {
    content: [{ type: "text" as const, text: toolError(err) }],
    isError: true as const,
  };
}

async function waitForFileReady(filePath: string, timeoutMs = 5_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let previousSize = -1;
  while (Date.now() < deadline) {
    const size = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
    if (size > 0 && size === previousSize) return size;
    previousSize = size;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
}

async function call(method: string, args: Record<string, unknown> = {}, undoName?: string) {
  return broker.invoke({ method, args, undoName });
}

const ResponseFormat = z.enum(["concise", "detailed"]).optional().default("concise");

const CompRef = {
  comp_name: z.string().optional().describe("Composition name. Prefer this over index."),
  comp_index: z.number().int().positive().optional().describe("1-based project item index if name is ambiguous."),
};

const LayerRef = {
  ...CompRef,
  layer_name: z.string().optional().describe("Layer name (preferred)."),
  layer_index: z.number().int().positive().optional().describe("1-based layer index in the comp."),
};

export function registerTools(server: McpServer): void {
  server.tool(
    "ae_health",
    "Check After Effects bridge status only. Never runs scripts in AE (no 'Executing script…' popup). If disconnected, restart AE once or call ae_reconnect once.",
    {},
    async () => {
      try {
        const ensured = await ensureBridgeConnected({ neverKick: true, waitMs: 500 });
        const instances = broker.listInstances();
        if (!ensured.ok || instances.length === 0) {
          return textResult({
            connected: false,
            ae_running: isAfterEffectsRunning(),
            ensured,
            instances: [],
            hint:
              "No silent bridge. Fully quit After Effects and reopen (Startup/ae-mcp-bootstrap.jsx loads with no popup). Avoid ae_reconnect unless necessary — it shows one Executing script dialog.",
          });
        }
        const result = await call(HostMethods.HEALTH);
        return textResult({
          connected: true,
          ae_running: true,
          ensured,
          instances,
          health: result.data,
          note: "Bridge live via Startup poller — no script popups.",
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "ae_reconnect",
    "USER-INITIATED ONLY. Runs AfterFX -r once (shows a brief 'Executing script…' dialog). Prefer restarting AE instead for a silent Startup load. 30s cooldown.",
    {},
    async () => {
      try {
        const ensured = await ensureBridgeConnected({ forceKick: true, waitMs: 14_000 });
        return textResult(ensured);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "ae_list_instances",
    "List live After Effects instances reporting heartbeats to the file bridge.",
    {},
    async () => {
      return textResult({ instances: broker.listInstances() });
    },
  );

  server.tool(
    "ae_get_project_info",
    "Get the open AE project summary: name, path, bits, and composition index. Prefer this over dumping the full project tree.",
    {
      response_format: ResponseFormat,
    },
    async ({ response_format }) => {
      try {
        const result = await call(HostMethods.PROJECT_INFO, { response_format });
        return textResult(result.data);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "ae_list_compositions",
    "List compositions in the open project (name, size, fps, duration, layer count).",
    {},
    async () => {
      try {
        const result = await call(HostMethods.PROJECT_LIST_COMPS);
        return textResult(result.data);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "ae_get_composition",
    "Get composition settings and layer index. Use response_format=detailed for layer list.",
    {
      ...CompRef,
      response_format: ResponseFormat,
    },
    async (args) => {
      try {
        const result = await call(HostMethods.COMP_GET, args);
        return textResult(result.data);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "ae_create_composition",
    "Create a new composition. Defaults: 1920x1080, 30fps, 5 seconds. bgColor is RGB 0–1 floats, e.g. [0,0,0].",
    {
      name: z.string().describe("Composition name"),
      width: z.number().int().positive().optional().default(1920),
      height: z.number().int().positive().optional().default(1080),
      duration: z.number().positive().optional().default(5).describe("Duration in seconds"),
      frameRate: z.number().positive().optional().default(30),
      pixelAspect: z.number().positive().optional().default(1),
      bgColor: z.array(z.number()).length(3).optional().describe("RGB 0-1"),
    },
    async (args) => {
      try {
        const result = await call(HostMethods.COMP_CREATE, args, `MCP: Create Comp ${args.name}`);
        return textResult(result.data);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "ae_get_layer",
    "Get layer details (transforms, timing, effects). Prefer layer_name; use layer_index if names collide.",
    {
      ...LayerRef,
      response_format: ResponseFormat,
    },
    async (args) => {
      try {
        const result = await call(HostMethods.LAYER_GET, args);
        return textResult(result.data);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "ae_create_layer",
    "Create a layer in a composition. type: text|solid|shape|null|camera|light|adjustment. For text pass text/fontSize/fillColor. Colors are RGB 0–1. Position is [x,y] or [x,y,z].",
    {
      ...CompRef,
      type: z.enum(["text", "solid", "shape", "null", "camera", "light", "adjustment"]),
      name: z.string().optional(),
      text: z.string().optional().describe("Source text for type=text"),
      font: z.string().optional(),
      fontSize: z.number().optional(),
      fillColor: z.array(z.number()).length(3).optional(),
      color: z.array(z.number()).length(3).optional().describe("Solid color RGB 0-1"),
      width: z.number().optional(),
      height: z.number().optional(),
      shape: z.enum(["rect", "ellipse"]).optional(),
      sizeX: z.number().optional(),
      sizeY: z.number().optional(),
      position: z.array(z.number()).min(2).max(3).optional(),
      scale: z.array(z.number()).min(2).max(3).optional(),
      rotation: z.number().optional(),
      opacity: z.number().min(0).max(100).optional(),
    },
    async (args) => {
      try {
        const result = await call(HostMethods.LAYER_CREATE, args, `MCP: Create ${args.type} layer`);
        return textResult(result.data);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "ae_set_layer_properties",
    "Set transform/timing/name/parent on a layer. position [x,y], scale [x,y] percent, rotation degrees, opacity 0-100.",
    {
      ...LayerRef,
      position: z.array(z.number()).min(2).max(3).optional(),
      scale: z.array(z.number()).min(2).max(3).optional(),
      rotation: z.number().optional(),
      opacity: z.number().min(0).max(100).optional(),
      inPoint: z.number().optional(),
      outPoint: z.number().optional(),
      startTime: z.number().optional(),
      enabled: z.boolean().optional(),
      threeDLayer: z.boolean().optional(),
      name: z.string().optional(),
      parent_name: z.string().optional(),
    },
    async (args) => {
      try {
        const result = await call(HostMethods.LAYER_SET_PROPS, args, "MCP: Set layer properties");
        return textResult(result.data);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "ae_delete_layer",
    "Delete a layer. DESTRUCTIVE — requires confirm=true.",
    {
      ...LayerRef,
      confirm: z.boolean().describe("Must be true to delete"),
    },
    async (args) => {
      try {
        const result = await call(HostMethods.LAYER_DELETE, args, "MCP: Delete layer");
        return textResult(result.data);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "ae_duplicate_layer",
    "Duplicate a layer; optionally rename the copy.",
    {
      ...LayerRef,
      new_name: z.string().optional(),
    },
    async (args) => {
      try {
        const result = await call(HostMethods.LAYER_DUPLICATE, args, "MCP: Duplicate layer");
        return textResult(result.data);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "ae_set_keyframes",
    "Set keyframes on a layer property. property uses path aliases: Transform/Position, Transform/Scale, Transform/Rotation, Transform/Opacity (or matchNames). keyframes: [{time: seconds, value: number|array}].",
    {
      ...LayerRef,
      property: z
        .string()
        .describe('e.g. "Transform/Position" or "Transform/Opacity"'),
      keyframes: z
        .array(
          z.object({
            time: z.number(),
            value: z.union([z.number(), z.array(z.number())]),
          }),
        )
        .min(1),
    },
    async (args) => {
      try {
        const result = await call(HostMethods.ANIM_SET_KEYFRAMES, args, "MCP: Set keyframes");
        return textResult(result.data);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "ae_set_expression",
    "Set or clear an expression on a layer property. Pass expression string, or empty string/null to clear. Example: wiggle(2, 30).",
    {
      ...LayerRef,
      property: z.string().describe('e.g. "Transform/Position"'),
      expression: z.string().nullable().describe("Expression code, or null/empty to clear"),
    },
    async (args) => {
      try {
        const result = await call(HostMethods.ANIM_SET_EXPRESSION, args, "MCP: Set expression");
        return textResult(result.data);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "ae_apply_effect",
    "Apply an effect by display name or matchName (e.g. \"Gaussian Blur\" or \"ADBE Gaussian Blur 2\").",
    {
      ...LayerRef,
      effect: z.string().describe("Effect name or matchName"),
    },
    async (args) => {
      try {
        const result = await call(HostMethods.FX_APPLY, args, "MCP: Apply effect");
        return textResult(result.data);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "ae_set_effect_property",
    "Set a property on an effect instance. Identify effect by effect_name or effect_index (1-based).",
    {
      ...LayerRef,
      effect_name: z.string().optional(),
      effect_index: z.number().int().positive().optional(),
      property: z.string().describe('Effect property name, e.g. "Blurriness"'),
      value: z.union([z.number(), z.string(), z.boolean(), z.array(z.number())]),
    },
    async (args) => {
      try {
        const result = await call(HostMethods.FX_SET_PROPERTY, args, "MCP: Set effect property");
        return textResult(result.data);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "ae_list_effects",
    "List effects on a layer (name, matchName, index).",
    {
      ...LayerRef,
    },
    async (args) => {
      try {
        const result = await call(HostMethods.FX_LIST, args);
        return textResult(result.data);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "ae_remove_effect",
    "Remove an effect from a layer by effect_name or effect_index.",
    {
      ...LayerRef,
      effect_name: z.string().optional(),
      effect_index: z.number().int().positive().optional(),
    },
    async (args) => {
      try {
        const result = await call(HostMethods.FX_REMOVE, args, "MCP: Remove effect");
        return textResult(result.data);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "ae_search",
    "Search project items and layers by name substring. Prefer this over listing everything in large projects.",
    {
      query: z.string().describe("Case-insensitive substring"),
      include_layers: z.boolean().optional().default(true),
      limit: z.number().int().positive().optional().default(50),
    },
    async (args) => {
      try {
        const result = await call(HostMethods.SEARCH, args);
        return textResult(result.data);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "ae_capture_frame",
    "Render a still PNG of a composition at a given time (seconds) and return it as an image when possible. Use after visual changes so you can verify the result. Defaults to current CTI time.",
    {
      ...CompRef,
      time: z.number().optional().describe("Time in seconds; default current time"),
      max_size: z.number().int().positive().optional().default(1280).describe("Max dimension for returned image (path still full-res)"),
    },
    async (args) => {
      try {
        const result = await call(HostMethods.VIEW_CAPTURE_FRAME, args, "MCP: Capture frame");
        const data = result.data as { path?: string; comp?: string; time?: number };
        const filePath = data?.path;
        if (filePath && (await waitForFileReady(filePath)) > 0) {
          const buf = fs.readFileSync(filePath);
          const b64 = buf.toString("base64");
          // MCP image content
          return {
            content: [
              {
                type: "text" as const,
                text: jsonText({
                  path: filePath,
                  comp: data.comp,
                  time: data.time,
                  note: "Frame captured. Image attached below.",
                  previews_dir: getPreviewsRoot(),
                }),
              },
              {
                type: "image" as const,
                data: b64,
                mimeType: "image/png",
              },
            ],
          };
        }
        return textResult(result.data);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "ae_run_jsx",
    "Escape hatch: run a Function-body of ExtendScript. Receives `args` parameter. Always undo-grouped. Use mode=unsafe for arbitrary code. Prefer high-level tools when possible. Return a JSON-serializable value.",
    {
      code: z
        .string()
        .describe("Function body, e.g. 'return app.project.activeItem.name;'"),
      args: z.record(z.string(), z.unknown()).optional().default({}),
      mode: z.enum(["restricted", "unsafe"]).optional().default("unsafe"),
      description: z.string().optional().describe("Short reason for audit"),
    },
    async ({ code, args, mode, description }) => {
      try {
        if (mode !== "unsafe") {
          return errorResult(
            new BridgeError(
              "restricted mode not yet allowlisting scripts; use mode=unsafe with a short description",
              "MODE_RESTRICTED",
              "Pass mode: \"unsafe\" and description explaining the intent.",
            ),
          );
        }
        const result = await broker.invoke({
          method: HostMethods.RUN_JSX,
          args: { args, description, mode },
          code,
          undoName: `MCP: JSX ${description ?? "run"}`,
        });
        return textResult(result.data);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ---- Subtitles (default: NO black bar) ----
  server.tool(
    "ae_create_subtitle",
    "Add a subtitle/caption text layer. DEFAULT: white text + black stroke for readability — NEVER adds a black bar/plate behind text unless background_bar=true (only when the user explicitly asks). Prefer this over solids for captions.",
    {
      ...CompRef,
      text: z.string().describe("Subtitle / caption text"),
      inPoint: z.number().describe("Start time in seconds"),
      outPoint: z.number().describe("End time in seconds"),
      name: z.string().optional(),
      fontSize: z.number().optional(),
      font: z.string().optional(),
      fillColor: z.array(z.number()).length(3).optional().describe("RGB 0-1, default white"),
      y: z.number().optional().describe("Vertical position; default ~88% of height"),
      fade: z.boolean().optional().default(true),
      background_bar: z
        .boolean()
        .optional()
        .default(false)
        .describe("ONLY true if user explicitly wants a bar/plate behind text. Default false."),
      barOpacity: z.number().min(0).max(100).optional(),
    },
    async (args) => {
      try {
        // Force-safe default even if model passes undefined weirdly
        const payload = { ...args, background_bar: args.background_bar === true };
        const result = await call(HostMethods.SUBTITLE_CREATE, payload, "MCP: Subtitle");
        return textResult(result.data);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "ae_import_footage",
    "Import a video/image/audio file into the AE project from an absolute path.",
    {
      path: z.string().describe("Absolute path to media file"),
    },
    async (args) => {
      try {
        const result = await call(HostMethods.FOOTAGE_IMPORT, args, "MCP: Import footage");
        return textResult(result.data);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "ae_analyze_cuts",
    "Analyze a video with ffmpeg silencedetect and return KEEP segments (content) vs silence to remove. Use this BEFORE cutting — never guess random cut points. Requires ffmpeg on PATH. Prefer ae_transcribe_video + ae_transcript_to_cuts when you need to remove stutters/fillers (speech-aware).",
    {
      path: z.string().describe("Absolute path to video file"),
      noise_db: z.number().optional().default(-35).describe("Silence threshold dB"),
      min_silence: z.number().optional().default(0.45).describe("Min silence length to cut (seconds)"),
      min_keep: z.number().optional().default(0.4).describe("Min keep segment length"),
      max_duration: z.number().optional().describe("Optional cap on total kept duration"),
    },
    async (args) => {
      try {
        if (!fs.existsSync(args.path)) {
          return errorResult(new BridgeError(`File not found: ${args.path}`, "FILE_NOT_FOUND"));
        }
        const analysis = analyzeSmartCuts(args.path, {
          noiseDb: args.noise_db,
          minSilence: args.min_silence,
          minKeep: args.min_keep,
          maxDuration: args.max_duration,
        });
        return textResult({
          ...analysis,
          guidance:
            "Pass analysis.keep as segments to ae_build_smart_edit. For fillers/stutters use ae_transcribe_video then ae_transcript_to_cuts instead.",
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "ae_transcribe_video",
    "Transcribe a video/audio file with timestamps (segments + word-level when available). Saves JSON under ~/.ae-mcp/transcripts/. Requires Python + faster-whisper (or openai-whisper) and ffmpeg. Use result with ae_transcript_to_cuts for filler/stutter removal edits.",
    {
      path: z.string().describe("Absolute path to video or audio"),
      model: z
        .string()
        .optional()
        .default("base")
        .describe("Whisper model: tiny|base|small|medium|large-v3"),
      language: z
        .string()
        .optional()
        .describe("Optional language code e.g. en, ja. Auto-detect if omitted."),
    },
    async (args) => {
      try {
        if (!fs.existsSync(args.path)) {
          return errorResult(new BridgeError(`File not found: ${args.path}`, "FILE_NOT_FOUND"));
        }
        const doc = transcribeVideo(args.path, {
          model: args.model,
          language: args.language,
        });
        ensureDataDirs();
        const base = path
          .basename(args.path, path.extname(args.path))
          .replace(/[^\w\-]+/g, "_");
        const srtPath = path.join(getDataRoot(), "transcripts", `${base}.srt`);
        // simple SRT from segments
        const segs = doc.segments || [];
        const srt = segs
          .map((s, i) => {
            const fmt = (sec: number) => {
              const h = Math.floor(sec / 3600);
              const m = Math.floor((sec % 3600) / 60);
              const ss = Math.floor(sec % 60);
              const ms = Math.round((sec - Math.floor(sec)) * 1000);
              const p = (n: number, w = 2) => String(n).padStart(w, "0");
              return `${p(h)}:${p(m)}:${p(ss)},${p(ms, 3)}`;
            };
            return `${i + 1}\n${fmt(s.start)} --> ${fmt(s.end)}\n${s.text}\n`;
          })
          .join("\n");
        fs.writeFileSync(srtPath, srt, "utf8");
        const vttPath = path.join(getDataRoot(), "transcripts", `${base}.vtt`);
        fs.writeFileSync(vttPath, toVtt(doc), "utf8");

        return textResult({
          source: doc.source || args.path,
          engine: doc.engine,
          model: doc.model,
          language: doc.language,
          duration: doc.duration,
          text: doc.text,
          segmentCount: (doc.segments || []).length,
          wordCount: (doc.words || []).length,
          segments: doc.segments,
          words: doc.words?.slice(0, 80),
          words_truncated: (doc.words?.length || 0) > 80,
          transcript_json_hint: "Also written under ~/.ae-mcp/transcripts/",
          srt_path: srtPath,
          vtt_path: vttPath,
          next: "Call ae_transcript_to_cuts with this transcript (or path to the JSON) to get KEEP segments with padding for AE.",
          full_transcript: doc,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(
          new BridgeError(msg, "TRANSCRIBE_FAILED", ensureWhisperHint()),
        );
      }
    },
  );

  server.tool(
    "ae_transcript_to_cuts",
    "From a timed transcript, remove fillers (um/uh/like/you know/…) and stutters (repeated words), then build KEEP timeline segments with pad_before/pad_after so cuts have a little breathing room. Pass segments to ae_build_smart_edit. Also returns cleaned text + SRT for subtitles (use ae_create_subtitle — no black bars).",
    {
      transcript: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Full transcript object from ae_transcribe_video (full_transcript field)"),
      transcript_path: z
        .string()
        .optional()
        .describe("Path to transcript JSON file instead of inline object"),
      pad_before: z
        .number()
        .optional()
        .default(0.12)
        .describe("Seconds of handle before each speech run (default 0.12)"),
      pad_after: z
        .number()
        .optional()
        .default(0.18)
        .describe("Seconds of handle after each speech run (default 0.18)"),
      merge_gap: z
        .number()
        .optional()
        .default(0.28)
        .describe("Merge words into one run if gap under this (seconds)"),
      remove_fillers: z.boolean().optional().default(true),
      remove_stutters: z.boolean().optional().default(true),
      aggressive_fillers: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Also strip discourse fillers: like/basically/actually/well/yeah (default false — keeps natural speech words)",
        ),
      extra_fillers: z
        .array(z.string())
        .optional()
        .describe("Additional filler words to strip"),
    },
    async (args) => {
      try {
        let doc: TranscriptDoc | null = null;
        if (args.transcript_path) {
          if (!fs.existsSync(args.transcript_path)) {
            return errorResult(
              new BridgeError(`Transcript not found: ${args.transcript_path}`, "FILE_NOT_FOUND"),
            );
          }
          doc = JSON.parse(fs.readFileSync(args.transcript_path, "utf8")) as TranscriptDoc;
        } else if (args.transcript) {
          doc = args.transcript as unknown as TranscriptDoc;
        }
        if (!doc) {
          return errorResult(
            new BridgeError(
              "Pass transcript or transcript_path",
              "ARGS",
              "Use output of ae_transcribe_video",
            ),
          );
        }

        const plan = planCutsFromTranscript(doc, {
          padBefore: args.pad_before,
          padAfter: args.pad_after,
          mergeGap: args.merge_gap,
          includeFillers: args.remove_fillers,
          aggressiveFillers: args.aggressive_fillers,
          removeStutters: args.remove_stutters,
          extraFillers: args.extra_fillers,
        });

        ensureDataDirs();
        const outDir = path.join(getDataRoot(), "transcripts");
        fs.mkdirSync(outDir, { recursive: true });
        const stamp = Date.now().toString(36);
        const planPath = path.join(outDir, `edit_plan_${stamp}.json`);
        const srtClean = path.join(outDir, `cleaned_${stamp}.srt`);
        fs.writeFileSync(
          planPath,
          JSON.stringify(
            {
              source: doc.source,
              keep: plan.keep,
              removed: plan.removed,
              cleanedText: plan.cleanedText,
              options: plan.optionsUsed,
            },
            null,
            2,
          ),
          "utf8",
        );
        fs.writeFileSync(srtClean, plan.srt, "utf8");

        return textResult({
          keep: plan.keep,
          keepCount: plan.keep.length,
          keptSeconds: plan.keptSeconds,
          removedSeconds: plan.removedSeconds,
          removedCount: plan.removed.length,
          removedSample: plan.removed.slice(0, 40),
          cleanedText: plan.cleanedText,
          options: plan.optionsUsed,
          plan_path: planPath,
          cleaned_srt_path: srtClean,
          next: [
            "Pass keep[] to ae_build_smart_edit({ path: video, segments: keep })",
            "For captions: ae_create_subtitle per keep item (text/inPoint/outPoint) — never black bars",
          ],
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "ae_create_editorial_plan",
    "Create an explainable YouTube edit plan from a timed transcript. Scores natural cut points, identifies a hook, suggests chapters and visuals, and returns a reviewable plan before any AE mutation.",
    {
      transcript: z.record(z.string(), z.unknown()).optional(),
      transcript_path: z.string().optional(),
      mode: z.enum(["clean", "retention", "story"]).optional().default("clean"),
    },
    async (args) => {
      try {
        let doc: TranscriptDoc | null = null;
        if (args.transcript_path) {
          if (!fs.existsSync(args.transcript_path)) return errorResult(new BridgeError(`Transcript not found: ${args.transcript_path}`, "FILE_NOT_FOUND"));
          doc = JSON.parse(fs.readFileSync(args.transcript_path, "utf8")) as TranscriptDoc;
        } else if (args.transcript) {
          doc = args.transcript as unknown as TranscriptDoc;
        }
        if (!doc) return errorResult(new BridgeError("Pass transcript or transcript_path", "ARGS"));
        const plan = buildEditorialPlan(doc, args.mode as EditMode);
        ensureDataDirs();
        const planPath = path.join(getDataRoot(), "transcripts", `editorial_${Date.now().toString(36)}.json`);
        fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf8");
        return textResult({ ...plan, plan_path: planPath, next: "Review this plan, then pass keep to ae_build_smart_edit or use ae_build_youtube_edit." });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "ae_audit_editorial_plan",
    "Run a pre-build quality audit on a YouTube editorial plan. Reports hook, pacing, coverage, chapter, and unsafe short-cut issues without mutating After Effects.",
    {
      plan: z.record(z.string(), z.unknown()).describe("Output of ae_create_editorial_plan"),
    },
    async (args) => textResult(auditEditorialPlan(args.plan as never)),
  );

  server.tool(
    "ae_list_motion_templates",
    "List the reusable motion-graphics templates the agent can use when planning a YouTube video.",
    {
      aspect_ratio: z.enum(["16:9", "9:16", "1:1"]).optional(),
    },
    async (args) => textResult(MOTION_TEMPLATES.filter((t) => !args.aspect_ratio || t.supports.includes(args.aspect_ratio))),
  );

  const MotionSceneInputSchema = z.object({
    purpose: z.enum(["hook", "setup", "explanation", "payoff", "cta"]),
    title: z.string(),
    subtitle: z.string().optional(),
    visualGoal: z.string().optional(),
    templateId: z.string().optional(),
    start: z.number().nonnegative().optional(),
    end: z.number().positive().optional(),
    motionIntensity: z.enum(["low", "medium", "high"]).optional(),
    transition: z.enum(["cut", "fade", "slide", "scale"]).optional(),
  });

  server.tool(
    "ae_create_motion_blueprint",
    "Create a canonical, explainable motion-graphics video blueprint without mutating After Effects. The blueprint is the shared source of truth for scenes, brand, timing, templates, QA, and rendering.",
    {
      brief: z.string().min(1),
      comp_name: z.string().optional().default("Motion Graphics Video"),
      duration: z.number().positive().optional().default(30),
      frame_rate: z.number().positive().optional().default(30),
      aspect_ratio: z.enum(["16:9", "9:16", "1:1"]).optional(),
      scenes: z.array(MotionSceneInputSchema).optional(),
      render_format: z.enum(["mp4", "mov", "png"]).optional().default("mp4"),
      render_preset: z.string().optional(),
    },
    async (args) => {
      try {
        const prefs = getWorkflowPreferences();
        const blueprint = createMotionBlueprint({
          brief: args.brief,
          compName: args.comp_name,
          duration: args.duration,
          frameRate: args.frame_rate,
          aspectRatio: args.aspect_ratio || prefs.brand.aspectRatio,
          brand: prefs.brand,
          scenes: args.scenes as MotionSceneInput[] | undefined,
          renderFormat: args.render_format,
          renderPreset: args.render_preset,
        });
        const repaired = repairMotionVideoBlueprint(blueprint);
        ensureDataDirs();
        const dir = path.join(getDataRoot(), "motion");
        fs.mkdirSync(dir, { recursive: true });
        const blueprintPath = path.join(dir, `${repaired.blueprint.id}.json`);
        fs.writeFileSync(blueprintPath, JSON.stringify(repaired.blueprint, null, 2), "utf8");
        return textResult({ status: repaired.after.ok ? "ready" : "needs_revision", blueprint: repaired.blueprint, blueprint_path: blueprintPath, audit: repaired.after, repairs: repaired.repairs });
      } catch (err) { return errorResult(err); }
    },
  );

  server.tool(
    "ae_validate_motion_blueprint",
    "Run explainable coherence checks on a motion blueprint without mutating After Effects.",
    { blueprint: z.record(z.string(), z.unknown()) },
    async (args) => {
      try { return textResult(auditMotionBlueprint(args.blueprint as unknown as MotionVideoBlueprint)); } catch (err) { return errorResult(err); }
    },
  );

  server.tool(
    "ae_repair_motion_blueprint",
    "Apply deterministic safe repairs to scene timing, template ids, and graphic text limits, then return the before/after coherence audit.",
    { blueprint: z.record(z.string(), z.unknown()) },
    async (args) => {
      try { return textResult(repairMotionVideoBlueprint(args.blueprint as unknown as MotionVideoBlueprint)); } catch (err) { return errorResult(err); }
    },
  );

  server.tool(
    "ae_build_motion_video",
    "One-shot motion-graphics workflow: validate and repair a blueprint, build deterministic named scenes in After Effects, capture QA frames, render a preview or final output, and create an approval review.",
    {
      blueprint: z.record(z.string(), z.unknown()).optional(),
      blueprint_path: z.string().optional(),
      brief: z.string().optional(),
      comp_name: z.string().optional().default("Motion Graphics Video"),
      duration: z.number().positive().optional().default(30),
      frame_rate: z.number().positive().optional().default(30),
      aspect_ratio: z.enum(["16:9", "9:16", "1:1"]).optional(),
      scenes: z.array(MotionSceneInputSchema).optional(),
      approved: z.boolean().optional().default(false),
      review_id: z.string().optional(),
      output_path: z.string().optional(),
      render: z.boolean().optional().default(true).describe("Render a preview/final file after building. Set false to leave only the editable AE composition."),
    },
    async (args) => {
      try {
        let blueprint: MotionVideoBlueprint;
        if (args.blueprint_path) {
          if (!fs.existsSync(args.blueprint_path)) return errorResult(new BridgeError(`Blueprint not found: ${args.blueprint_path}`, "FILE_NOT_FOUND"));
          blueprint = JSON.parse(fs.readFileSync(args.blueprint_path, "utf8")) as MotionVideoBlueprint;
        } else if (args.blueprint) {
          blueprint = args.blueprint as unknown as MotionVideoBlueprint;
        } else {
          const prefs = getWorkflowPreferences();
          if (!args.brief) return errorResult(new BridgeError("Pass blueprint, blueprint_path, or brief", "ARGS"));
          blueprint = createMotionBlueprint({
            brief: args.brief,
            compName: args.comp_name,
            duration: args.duration,
            frameRate: args.frame_rate,
            aspectRatio: args.aspect_ratio || prefs.brand.aspectRatio,
            brand: prefs.brand,
            scenes: args.scenes as MotionSceneInput[] | undefined,
          });
        }
        const repaired = repairMotionVideoBlueprint(blueprint);
        const finalBlueprint = repaired.blueprint;
        if (!repaired.after.ok) return textResult({ status: "blueprint_invalid", blueprint: finalBlueprint, audit: repaired.after, repairs: repaired.repairs });
        const prefs = getWorkflowPreferences();
        const approvedReview = args.review_id ? listReviews().some((review) => review.id === args.review_id && review.decision === "approved") : false;
        if (prefs.workflowMode === "approval" && !args.approved && !approvedReview) {
          return textResult({ status: "approval_required", workflow_mode: prefs.workflowMode, blueprint: finalBlueprint, audit: repaired.after, repairs: repaired.repairs, next: "Review the blueprint, then call ae_build_motion_video again with approved=true." });
        }
        const created = await call(HostMethods.COMP_CREATE, {
          name: finalBlueprint.compName,
          width: finalBlueprint.width,
          height: finalBlueprint.height,
          duration: finalBlueprint.duration,
          frameRate: finalBlueprint.frameRate,
          pixelAspect: 1,
          bgColor: finalBlueprint.brand.primaryColor,
        }, `MCP: Build ${finalBlueprint.compName}`);
        const layers = [];
        for (const scene of finalBlueprint.scenes) {
          const result = await call(HostMethods.MOTION_CREATE_TEMPLATE, {
            comp_name: finalBlueprint.compName,
            scene_id: scene.id,
            scene_purpose: scene.purpose,
            visual_style: "japanese-pop",
            template_id: scene.templateId,
            text: scene.title,
            title: scene.title,
            subtitle: scene.subtitle,
            start: scene.start,
            end: scene.end,
            primary_color: finalBlueprint.brand.primaryColor,
            accent_color: finalBlueprint.brand.accentColor,
            text_color: finalBlueprint.brand.secondaryColor,
            font_family: finalBlueprint.brand.fontFamily,
            font_size: Math.round(96 * finalBlueprint.visualGrammar.titleScale),
            fade_duration: scene.transition === "cut" ? 0 : 0.25,
            hold_end: scene.id === finalBlueprint.scenes[finalBlueprint.scenes.length - 1]?.id,
            transition: scene.transition,
          }, `MCP: Build ${scene.id}`);
          layers.push({ scene: scene.id, purpose: scene.purpose, result: result.data });
        }
        const times = Array.from(new Set([0, ...finalBlueprint.scenes.map((scene) => Number(((scene.start + scene.end) / 2).toFixed(3))), ...finalBlueprint.scenes.map((scene) => Number(Math.max(0, scene.end - 0.05).toFixed(3)))]))
          .filter((time) => time >= 0 && time <= finalBlueprint.duration)
          .slice(0, Math.max(finalBlueprint.qa.requiredFrameCount, 5));
        const frameResult = await call(HostMethods.VIEW_CAPTURE_FRAMES, { comp_name: finalBlueprint.compName, times });
        const frameData = frameResult.data as { comp: string; frames: { time: number; path: string; bytes: number }[] };
        for (const frame of frameData.frames) frame.bytes = await waitForFileReady(frame.path);
        const frameSizes = frameData.frames.map((frame) => frame.bytes).filter((bytes) => bytes > 0);
        const qa = { all_frames_written: frameSizes.length === frameData.frames.length, frames_differ: new Set(frameSizes).size > 1, frame_count: frameData.frames.length, note: "Inspect the returned preview frames before final delivery." };
        const previewPath = args.output_path || path.join(getPreviewsRoot(), `${finalBlueprint.compName.replace(/[^\w\-]+/g, "_")}_${finalBlueprint.id}_preview.${finalBlueprint.render.format}`);
        const renderResult = args.render ? await call(HostMethods.COMP_RENDER, { comp_name: finalBlueprint.compName, output_path: previewPath, format: finalBlueprint.render.format, output_preset: finalBlueprint.render.preset || (finalBlueprint.render.format === "png" ? "PNG Sequence with Alpha" : finalBlueprint.render.format === "mov" ? "Lossless with Alpha" : "H.264 - Match Render Settings - 15 Mbps") }, `MCP: Render ${finalBlueprint.compName}`) : null;
        const review = createReview({ comp: finalBlueprint.compName, frames: frameData.frames, render: renderResult ? renderResult.data as { path: string; format: string; bytes?: number } : undefined });
        if (prefs.workflowMode === "autonomous") decideReview(review.id, "approved", "Automatically approved by autonomous motion-graphics workflow after structural QA.");
        return textResult({ status: prefs.workflowMode === "autonomous" ? "built_and_approved" : args.render ? "preview_ready" : "built_no_render", workflow_mode: prefs.workflowMode, blueprint: finalBlueprint, audit: repaired.after, repairs: repaired.repairs, ae: created.data, layers, qa, render: renderResult?.data || null, review });
      } catch (err) { return errorResult(err); }
    },
  );

  server.tool(
    "ae_create_motion_template",
    "Create a reusable, brand-aware motion graphic directly in an After Effects composition.",
    {
      ...CompRef,
      template_id: z.string().describe("Template id from ae_list_motion_templates"),
      text: z.string().optional(),
      title: z.string().optional(),
      subtitle: z.string().optional(),
      start: z.number().optional().default(0),
      end: z.number().optional(),
      font_size: z.number().optional(),
    },
    async (args) => {
      try {
        const brand = getWorkflowPreferences().brand;
        const result = await call(HostMethods.MOTION_CREATE_TEMPLATE, {
          ...args,
          primary_color: brand.primaryColor,
          accent_color: brand.accentColor,
          font_family: brand.fontFamily,
        }, "MCP: Create motion template");
        return textResult(result.data);
      } catch (err) { return errorResult(err); }
    },
  );

  server.tool(
    "ae_capture_frames",
    "Capture multiple composition frames for visual QA and return a frame manifest.",
    { ...CompRef, times: z.array(z.number()).min(2).describe("Composition times in seconds") },
    async (args) => {
      try {
        const result = await call(HostMethods.VIEW_CAPTURE_FRAMES, args);
        const data = result.data as { comp: string; frames: { time: number; path: string; bytes: number }[] };
        for (const frame of data.frames) frame.bytes = await waitForFileReady(frame.path);
        const sizes = data.frames.map((frame) => frame.bytes).filter((bytes) => bytes > 0);
        return textResult({ ...data, qa: { all_frames_written: sizes.length === data.frames.length, frames_differ: new Set(sizes).size > 1, note: "Different file sizes are a heuristic; inspect the attached frames before declaring visual QA complete." } });
      } catch (err) { return errorResult(err); }
    },
  );

  server.tool(
    "ae_render_composition",
    "Render a composition with an automatic export preset. The render must still be visually reviewed before delivery.",
    { ...CompRef, output_path: z.string().optional(), format: z.enum(["mp4", "mov", "png"]).optional().default("mp4"), output_preset: z.string().optional() },
    async (args) => {
      try {
        const preset = args.output_preset || (args.format === "png" ? "PNG Sequence with Alpha" : args.format === "mov" ? "Lossless with Alpha" : "H.264 - Match Render Settings - 15 Mbps");
        const result = await call(HostMethods.COMP_RENDER, { ...args, output_preset: preset }, "MCP: Render composition");
        return textResult(result.data);
      } catch (err) { return errorResult(err); }
    },
  );

  server.tool(
    "ae_create_review",
    "Create a saved review item with preview frames and optional render metadata. Approval mode should use this before final delivery.",
    { comp: z.string().describe("Composition name"), plan_path: z.string().optional(), frames: z.array(z.object({ time: z.number(), path: z.string(), bytes: z.number().optional() })), render: z.object({ path: z.string(), format: z.string(), bytes: z.number().optional() }).optional() },
    async (args) => textResult(createReview({ comp: args.comp, planPath: args.plan_path, frames: args.frames, render: args.render })),
  );

  server.tool(
    "ae_list_reviews",
    "List pending, approved, and rejected AE MCP review items.",
    {},
    async () => textResult(listReviews()),
  );

  server.tool(
    "ae_decide_review",
    "Approve or reject a saved preview review item with notes.",
    { review_id: z.string(), decision: z.enum(["approved", "rejected"]), notes: z.string().optional() },
    async (args) => {
      try { return textResult(decideReview(args.review_id, args.decision, args.notes)); } catch (err) { return errorResult(err); }
    },
  );

  server.tool(
    "ae_get_workflow_preferences",
    "Read the AE MCP workflow mode, edit mode, and brand defaults. Approval mode is the safe default; autonomous mode lets high-level workflows proceed without an extra approval gate.",
    {},
    async () => textResult(getWorkflowPreferences()),
  );

  server.tool(
    "ae_set_workflow_preferences",
    "Set autonomous or approval workflow behavior and project brand defaults used by high-level editing workflows.",
    {
      workflow_mode: z.enum(["autonomous", "approval"]).optional(),
      edit_mode: z.enum(["clean", "retention", "story"]).optional(),
      font_family: z.string().optional(),
      caption_font_size: z.number().positive().optional(),
      safe_margin: z.number().nonnegative().optional(),
      aspect_ratio: z.enum(["16:9", "9:16", "1:1"]).optional(),
      primary_color: z.array(z.number().min(0).max(1)).length(3).optional(),
      secondary_color: z.array(z.number().min(0).max(1)).length(3).optional(),
      accent_color: z.array(z.number().min(0).max(1)).length(3).optional(),
    },
    async (args) => {
      const current = getWorkflowPreferences();
      return textResult(saveWorkflowPreferences({
        workflowMode: args.workflow_mode as WorkflowMode | undefined,
        editMode: args.edit_mode as EditMode | undefined,
        brand: {
          ...current.brand,
          fontFamily: args.font_family || current.brand.fontFamily,
          captionFontSize: args.caption_font_size || current.brand.captionFontSize,
          safeMargin: args.safe_margin ?? current.brand.safeMargin,
          aspectRatio: args.aspect_ratio || current.brand.aspectRatio,
          primaryColor: (args.primary_color || current.brand.primaryColor) as [number, number, number],
          secondaryColor: (args.secondary_color || current.brand.secondaryColor) as [number, number, number],
          accentColor: (args.accent_color || current.brand.accentColor) as [number, number, number],
        },
      }));
    },
  );

  server.tool(
    "ae_build_smart_edit",
    "Import footage (optional if already in project) and build a sequential edit comp from KEEP segments (from ae_analyze_cuts). Cuts on silence/dead air — not random. Does not add subtitle bars.",
    {
      path: z.string().optional().describe("Absolute media path to import"),
      footage_name: z.string().optional().describe("Existing project footage name"),
      comp_name: z.string().optional().default("Smart Edit"),
      segments: z
        .array(
          z.object({
            start: z.number(),
            end: z.number(),
          }),
        )
        .min(1)
        .describe("Keep segments in SOURCE seconds from ae_analyze_cuts.keep"),
      frameRate: z.number().optional().default(30),
    },
    async (args) => {
      try {
        if (!args.path && !args.footage_name) {
          return errorResult(
            new BridgeError("Pass path or footage_name", "ARGS", "Provide media path or footage name"),
          );
        }
        const result = await call(
          HostMethods.EDIT_FROM_CUTS,
          {
            path: args.path,
            footage_name: args.footage_name,
            comp_name: args.comp_name,
            segments: args.segments,
            frameRate: args.frameRate,
          },
          "MCP: Smart edit",
        );
        return textResult(result.data);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "ae_build_youtube_edit",
    "Analyze a transcript and optionally build a YouTube edit in After Effects. In approval mode it returns a full editorial plan until approved=true; in autonomous mode it builds immediately. Use clean, retention, or story mode.",
    {
      path: z.string().optional().describe("Absolute media path to import"),
      footage_name: z.string().optional(),
      transcript: z.record(z.string(), z.unknown()).optional(),
      transcript_path: z.string().optional(),
      comp_name: z.string().optional().default("YouTube Edit"),
      mode: z.enum(["clean", "retention", "story"]).optional(),
      approved: z.boolean().optional().default(false).describe("Required in approval mode to mutate AE"),
      review_id: z.string().optional().describe("Approved review item id; alternative to approved=true"),
      frameRate: z.number().positive().optional().default(30),
    },
    async (args) => {
      try {
        if (!args.path && !args.footage_name) return errorResult(new BridgeError("Pass path or footage_name", "ARGS"));
        let doc: TranscriptDoc | null = null;
        if (args.transcript_path) {
          if (!fs.existsSync(args.transcript_path)) return errorResult(new BridgeError(`Transcript not found: ${args.transcript_path}`, "FILE_NOT_FOUND"));
          doc = JSON.parse(fs.readFileSync(args.transcript_path, "utf8")) as TranscriptDoc;
        } else if (args.transcript) {
          doc = args.transcript as unknown as TranscriptDoc;
        }
        if (!doc) return errorResult(new BridgeError("Pass transcript or transcript_path", "ARGS", "Transcribe first with ae_transcribe_video"));
        const prefs = getWorkflowPreferences();
        const plan = buildEditorialPlan(doc, (args.mode || prefs.editMode) as EditMode);
        const reviewApproved = args.review_id ? listReviews().some((review) => review.id === args.review_id && review.decision === "approved") : false;
        if (prefs.workflowMode === "approval" && !args.approved && !reviewApproved) {
          return textResult({ status: "approval_required", workflow_mode: prefs.workflowMode, plan, next: "Review the plan and call ae_build_youtube_edit again with approved=true." });
        }
        const result = await call(HostMethods.EDIT_FROM_CUTS, {
          path: args.path,
          footage_name: args.footage_name,
          comp_name: args.comp_name,
          segments: plan.keep.map((s) => ({ start: s.start, end: s.end })),
          frameRate: args.frameRate,
        }, "MCP: YouTube edit");
        return textResult({ status: "built", workflow_mode: prefs.workflowMode, plan, ae: result.data });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ---- Blender → AE 3D pipeline ----
  server.tool(
    "ae_prepare_blender_3d_job",
    "MANDATORY first step when user asks for REAL 3D models in AE. Creates an exchange folder and returns (1) paths + (2) Blender Python to run via blender MCP execute_blender_code. AE cannot load .blend meshes natively — Blender must render a transparent PNG sequence (and optional GLB/OBJ). After Blender finishes, call ae_import_3d_from_blender.",
    {
      job_name: z.string().optional().describe("Short name e.g. earth, logo, character"),
      frames: z.number().int().positive().optional().default(90),
      fps: z.number().optional().default(30),
      resolution: z.number().int().positive().optional().default(1080),
      object_name: z
        .string()
        .optional()
        .describe("Existing Blender object name to animate; empty = use active/create sphere"),
    },
    async (args) => {
      try {
        const job = createBlenderJob(args.job_name);
        const script = blenderExportScript(job, {
          frames: args.frames,
          fps: args.fps,
          resolution: args.resolution,
          objectName: args.object_name,
        });
        return textResult({
          jobId: job.jobId,
          paths: job,
          blender_python: script,
          agent_instructions: [
            "1. Ensure Blender is open with blender MCP connected.",
            "2. Call blender execute_blender_code with blender_python (may need 2-3 chunks if long; or run as one).",
            "3. Optionally create/model the object in Blender first, pass object_name.",
            "4. Wait until render finishes (frames appear in framesDir).",
            "5. Call ae_import_3d_from_blender({ jobId }) to place the sequence in After Effects.",
            "6. Style with AE mograph around the imported 3D render layer.",
            "NEVER fake 3D with only CC Sphere when user asked for Blender/real 3D — use this pipeline.",
          ],
          recent_jobs: listJobs().slice(0, 8),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "ae_verify_blender_job",
    "VERIFY GATE before AE import. Checks frame count, that frames actually differ (animation rendered), and mesh exports. MUST pass before ae_import_3d_from_blender. Do not claim 3D is done if this fails.",
    {
      jobId: z.string(),
      min_frames: z.number().int().positive().optional().default(2),
    },
    async (args) => {
      try {
        const v = verifyBlenderJob(args.jobId, { minFrames: args.min_frames });
        return textResult({
          ...v,
          next: v.ok
            ? "Call ae_import_3d_from_blender with this jobId"
            : "Fix Blender render (re-run export script) until ok:true",
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "ae_import_3d_from_blender",
    "Import a finished Blender exchange job into After Effects as a transparent PNG sequence (real 3D render). Runs verify first. Creates a dedicated comp and layer. After import you MUST ae_capture_frame to prove the layer is visible.",
    {
      jobId: z.string().describe("Job id from ae_prepare_blender_3d_job"),
      comp_name: z.string().optional().default("Blender 3D"),
      layer_name: z.string().optional().default("Blender 3D"),
      threeD: z.boolean().optional().default(true),
      frameRate: z.number().optional().default(30),
      skip_verify: z.boolean().optional().default(false),
      first_frame: z
        .string()
        .optional()
        .describe("Override: absolute path to first PNG if not using job frames folder"),
    },
    async (args) => {
      try {
        if (!args.skip_verify) {
          const v = verifyBlenderJob(args.jobId, { minFrames: 2 });
          if (!v.ok) {
            return errorResult(
              new BridgeError(
                `Blender job failed verification: ${v.errors.join("; ")}`,
                "VERIFY_FAILED",
                "Re-render in Blender. Do not improvise with CC Sphere unless user accepts fallback.",
              ),
            );
          }
        }

        let first = args.first_frame;
        const job = resolveJob(args.jobId);
        if (!first) {
          if (!job) {
            return errorResult(
              new BridgeError(`Unknown jobId: ${args.jobId}`, "JOB_NOT_FOUND", "Call ae_prepare_blender_3d_job first"),
            );
          }
          const seq = listFrameSequence(job.framesDir);
          if (!seq.first || seq.count < 1) {
            return errorResult(
              new BridgeError(
                `No rendered frames in ${job.framesDir}`,
                "NO_FRAMES",
                "Render in Blender first.",
              ),
            );
          }
          first = seq.first;
        }

        const firstSlash = first.replace(/\\/g, "/");
        let result;
        try {
          result = await call(
            HostMethods.FOOTAGE_IMPORT_SEQUENCE,
            {
              path: firstSlash,
              comp_name: args.comp_name,
              layer_name: args.layer_name,
              threeD: args.threeD,
              frameRate: args.frameRate,
              create_comp: true,
              add_to_comp: true,
            },
            "MCP: Import Blender 3D",
          );
        } catch (err) {
          // Fallback: inline JSX import if methods pack was stale
          const code = `
var first = new File(${JSON.stringify(firstSlash)});
if (!first.exists) throw { message: 'missing ' + first.fsName };
var io = new ImportOptions(first);
io.importAs = ImportAsType.FOOTAGE;
try { io.sequence = true; } catch (e) {}
var ftg = app.project.importFile(io);
var w = ftg.width || 1080, h = ftg.height || 1080;
var dur = ftg.duration > 0.1 ? ftg.duration : 4;
var comp = app.project.items.addComp(${JSON.stringify(args.comp_name || "Blender 3D")}, 1920, 1080, 1, dur + 1, ${Number(args.frameRate || 30)});
comp.bgColor = [0.03,0.04,0.08];
var layer = comp.layers.add(ftg);
layer.name = ${JSON.stringify(args.layer_name || "Blender 3D")};
layer.threeDLayer = ${args.threeD !== false ? "true" : "false"};
var fit = Math.min((comp.height * 0.7) / h, (comp.width * 0.55) / w) * 100;
layer.property('ADBE Transform Group').property('ADBE Scale').setValue([fit, fit, fit]);
layer.property('ADBE Transform Group').property('ADBE Position').setValue([comp.width/2, comp.height/2, 0]);
try { comp.openInViewer(); } catch (e) {}
return { name: ftg.name, duration: ftg.duration, width: ftg.width, height: ftg.height, comp: comp.name, layer: layer.name, sequence: true, fallback: true };
`;
          result = await broker.invoke({
            method: HostMethods.RUN_JSX,
            args: { args: {} },
            code,
            undoName: "MCP: Import Blender 3D fallback",
          });
        }

        const meshNotes: string[] = [];
        if (job) {
          if (fs.existsSync(job.glbPath)) meshNotes.push(`GLB: ${job.glbPath}`);
          if (fs.existsSync(job.objPath)) meshNotes.push(`OBJ: ${job.objPath}`);
          if (fs.existsSync(job.fbxPath)) meshNotes.push(`FBX: ${job.fbxPath}`);
        }

        const data = (result.data as { result?: unknown })?.result ?? result.data;

        return textResult({
          import: data,
          jobId: args.jobId,
          first_frame: first,
          mesh_exports: meshNotes,
          required_next_step:
            "Call ae_capture_frame on the new comp at t=0.5 and t=mid. If Earth not visible, STOP and fix — do not call the job done.",
          note:
            "PNG sequence is the AE path for Blender 3D. GLB/OBJ are mesh sidecars for C4D/plugins.",
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "ae_list_blender_jobs",
    "List Blender→AE exchange jobs under ~/.ae-mcp/blender-exchange/",
    {},
    async () => {
      try {
        const jobs = listJobs().map((id) => {
          const j = resolveJob(id);
          const seq = j ? listFrameSequence(j.framesDir) : { count: 0, first: null };
          return {
            jobId: id,
            frames: seq.count,
            ready: seq.count > 0,
            dir: j?.jobDir,
          };
        });
        return textResult({ jobs, exchange_root: path.join(process.env.USERPROFILE || "", ".ae-mcp", "blender-exchange") });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
