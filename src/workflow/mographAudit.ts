import type { MotionVideoBlueprint } from "./motionBlueprint.js";

export interface MotionCoverageAudit {
  ok: boolean;
  score: number;
  checks: { name: string; ok: boolean; severity: "info" | "warning" | "error"; detail: string }[];
  motionBeats: number;
  sceneVariations: number;
}

export function auditMotionCoverage(blueprint: MotionVideoBlueprint): MotionCoverageAudit {
  const checks: MotionCoverageAudit["checks"] = [];
  const add = (name: string, ok: boolean, severity: MotionCoverageAudit["checks"][number]["severity"], detail: string) => checks.push({ name, ok, severity, detail });
  const beats = blueprint.scenes.reduce((sum, scene) => sum + scene.beats.length, 0);
  const templates = new Set(blueprint.scenes.map((scene) => scene.templateId));
  const transitions = new Set(blueprint.scenes.map((scene) => scene.transition));
  const intensities = new Set(blueprint.scenes.map((scene) => scene.motionIntensity));
  const sceneVariations = templates.size + transitions.size + intensities.size;
  add("Beat choreography", beats >= blueprint.scenes.length * 3, "error", `${beats} beat events across ${blueprint.scenes.length} scenes`);
  add("Object motion required", blueprint.visualStyle !== "minimal" && blueprint.energy >= 0.55, "error", blueprint.visualStyle === "minimal" ? "Minimal style does not request choreographed object motion" : `Energy target ${(blueprint.energy * 100).toFixed(0)}% requires object choreography`);
  add("Scene variation", sceneVariations >= 8, "warning", `${sceneVariations} independent template/transition/intensity variations`);
  add("Impact cadence", blueprint.scenes.every((scene) => scene.beats.some((beat) => beat.kind === "impact")), "error", "Every scene has an impact beat");
  add("Settle moments", blueprint.scenes.every((scene) => scene.beats.some((beat) => beat.kind === "settle")), "warning", "Every scene has a readable settle beat");
  add("Style recipe", blueprint.visualStyle === "japanese-pop", "info", `Selected visual style: ${blueprint.visualStyle}`);
  const errors = checks.filter((check) => !check.ok && check.severity === "error").length;
  const warnings = checks.filter((check) => !check.ok && check.severity === "warning").length;
  return { ok: errors === 0, score: Math.max(0, Number((1 - errors * 0.22 - warnings * 0.08).toFixed(3))), checks, motionBeats: beats, sceneVariations };
}
