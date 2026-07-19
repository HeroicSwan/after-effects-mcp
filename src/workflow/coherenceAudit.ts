import { MOTION_TEMPLATES } from "../motion/templates.js";
import type { MotionVideoBlueprint } from "./motionBlueprint.js";

export interface CoherenceCheck {
  name: string;
  ok: boolean;
  severity: "info" | "warning" | "error";
  detail: string;
}

export interface CoherenceAudit {
  ok: boolean;
  score: number;
  checks: CoherenceCheck[];
  errors: number;
  warnings: number;
}

export function auditMotionBlueprint(blueprint: MotionVideoBlueprint): CoherenceAudit {
  const checks: CoherenceCheck[] = [];
  const add = (name: string, ok: boolean, severity: CoherenceCheck["severity"], detail: string) => checks.push({ name, ok, severity, detail });
  const scenes = blueprint.scenes;
  const templateIds = new Set(MOTION_TEMPLATES.map((template) => template.id));
  const purposes = new Set(scenes.map((scene) => scene.purpose));
  const hasGaps = scenes.some((scene, index) => index > 0 && Math.abs(scene.start - scenes[index - 1]!.end) > 0.05);
  const hasOverlap = scenes.some((scene, index) => index > 0 && scene.start < scenes[index - 1]!.end - 0.001);
  const shortScenes = scenes.filter((scene) => scene.end - scene.start < 0.75);
  const unsupported = scenes.filter((scene) => !templateIds.has(scene.templateId));
  const longText = scenes.filter((scene) => scene.title.split(/\s+/).filter(Boolean).length > blueprint.visualGrammar.maxWordsPerGraphic);
  const invalidColors = [blueprint.brand.primaryColor, blueprint.brand.secondaryColor, blueprint.brand.accentColor].some((color) => color.some((value) => value < 0 || value > 1));

  add("Scenes exist", scenes.length > 0, "error", scenes.length ? `${scenes.length} scenes defined` : "No scenes defined");
  add("Hook", !blueprint.qa.requireHookAndCta || purposes.has("hook"), "error", purposes.has("hook") ? "Hook scene is present" : "A hook scene is required");
  add("CTA", !blueprint.qa.requireHookAndCta || purposes.has("cta"), "error", purposes.has("cta") ? "CTA scene is present" : "A CTA scene is required");
  add("Timeline coverage", !hasGaps, "error", hasGaps ? "Scene timing contains a visible gap" : "Scenes cover the timeline continuously");
  add("No overlap", !hasOverlap, "error", hasOverlap ? "Scene timing overlaps" : "Scene timing does not overlap");
  add("Minimum scene duration", !shortScenes.length, "warning", shortScenes.length ? `${shortScenes.length} scene(s) are shorter than 750ms` : "All scenes have usable duration");
  add("Template compatibility", !unsupported.length, "error", unsupported.length ? `Unknown templates: ${unsupported.map((scene) => scene.templateId).join(", ")}` : "All templates are registered");
  add("Graphic text density", !longText.length, "warning", longText.length ? `${longText.length} title(s) exceed the ${blueprint.visualGrammar.maxWordsPerGraphic}-word graphic limit` : "Graphic text stays within the visual grammar");
  add("Brand colors", !invalidColors, "error", invalidColors ? "Brand colors must use RGB values from 0 to 1" : "Brand colors are valid");
  add("Typography", !!blueprint.brand.fontFamily.trim(), "error", blueprint.brand.fontFamily.trim() ? `Using ${blueprint.brand.fontFamily}` : "A font family is required");
  add("Visual rhythm", scenes.length >= 3, "info", scenes.length >= 3 ? "The video has enough beats to establish progression" : "Add at least three visual beats for stronger progression");

  const errors = checks.filter((check) => !check.ok && check.severity === "error").length;
  const warnings = checks.filter((check) => !check.ok && check.severity === "warning").length;
  return { ok: errors === 0, score: Math.max(0, Number((1 - errors * 0.18 - warnings * 0.06).toFixed(3))), checks, errors, warnings };
}
