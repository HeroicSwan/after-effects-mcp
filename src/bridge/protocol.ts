import { z } from "zod";

export const BRIDGE_PROTOCOL_VERSION = 1;

export const CommandMetaSchema = z.object({
  undoName: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export const BridgeCommandSchema = z.object({
  protocolVersion: z.number().int().default(BRIDGE_PROTOCOL_VERSION),
  requestId: z.string().min(1),
  op: z.enum(["invoke", "ping"]),
  method: z.string().min(1).optional(),
  args: z.record(z.string(), z.unknown()).default({}),
  /** Raw ExtendScript body for run_jsx */
  code: z.string().optional(),
  meta: CommandMetaSchema.default({}),
  createdAt: z.string().optional(),
});

export type BridgeCommand = z.infer<typeof BridgeCommandSchema>;

export const BridgeErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  hint: z.string().optional(),
});

export const BridgeResultSchema = z.object({
  protocolVersion: z.number().int().optional(),
  requestId: z.string(),
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: BridgeErrorSchema.nullable().optional(),
  timingMs: z.number().optional(),
  aeVersion: z.string().optional(),
  instanceId: z.string().optional(),
});

export type BridgeResult = z.infer<typeof BridgeResultSchema>;

export const InstanceHeartbeatSchema = z.object({
  instanceId: z.string(),
  aeVersion: z.string().optional(),
  projectName: z.string().nullable().optional(),
  projectPath: z.string().nullable().optional(),
  lastSeen: z.string(),
  pollMs: z.number().optional(),
  protocolVersion: z.number().int().optional(),
  platform: z.string().optional(),
});

export type InstanceHeartbeat = z.infer<typeof InstanceHeartbeatSchema>;

/** Well-known host method names. */
export const HostMethods = {
  PING: "system.ping",
  HEALTH: "system.health",
  PROJECT_INFO: "project.info",
  PROJECT_LIST_COMPS: "project.listComps",
  COMP_GET: "comp.get",
  COMP_CREATE: "comp.create",
  LAYER_GET: "layer.get",
  LAYER_CREATE: "layer.create",
  LAYER_SET_PROPS: "layer.setProperties",
  LAYER_DELETE: "layer.delete",
  LAYER_DUPLICATE: "layer.duplicate",
  ANIM_SET_KEYFRAMES: "anim.setKeyframes",
  ANIM_SET_EXPRESSION: "anim.setExpression",
  FX_APPLY: "fx.apply",
  FX_SET_PROPERTY: "fx.setProperty",
  FX_REMOVE: "fx.remove",
  FX_LIST: "fx.list",
  VIEW_CAPTURE_FRAME: "view.captureFrame",
  VIEW_CAPTURE_FRAMES: "view.captureFrames",
  SEARCH: "project.search",
  RUN_JSX: "system.runJsx",
  /** Import footage file into project */
  FOOTAGE_IMPORT: "footage.import",
  /** Create subtitle text (NO background bar by default) */
  SUBTITLE_CREATE: "subtitle.create",
  /** Build edit from footage using keep segments */
  EDIT_FROM_CUTS: "edit.fromCuts",
  COMP_RENDER: "comp.render",
  MOTION_CREATE_TEMPLATE: "motion.createTemplate",
  /** Import image sequence (Blender 3D render) as footage */
  FOOTAGE_IMPORT_SEQUENCE: "footage.importSequence",
} as const;

export type HostMethod = (typeof HostMethods)[keyof typeof HostMethods];
