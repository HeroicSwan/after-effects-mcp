import type { EditorialPlan } from "./editorialPlan.js";

export interface QualityAudit {
  ok: boolean;
  score: number;
  checks: { name: string; ok: boolean; severity: "info" | "warning" | "error"; detail: string }[];
}

export function auditEditorialPlan(plan: EditorialPlan): QualityAudit {
  const checks: QualityAudit["checks"] = [];
  const add = (name: string, ok: boolean, severity: "info" | "warning" | "error", detail: string) => checks.push({ name, ok, severity, detail });
  add("Hook", !!plan.hook, "error", plan.hook ? `Hook candidate at ${plan.hook.start.toFixed(2)}s` : "No usable early hook was found");
  add("Pacing", plan.pacing.score >= 0.55, "warning", `Average shot ${plan.pacing.averageShotSeconds}s; ${plan.pacing.cutsPerMinute} cuts/minute`);
  add("Coverage", plan.visualSuggestions.length > 0, "warning", plan.visualSuggestions.length ? `${plan.visualSuggestions.length} visual emphasis suggestions` : "No visual suggestions were detected");
  add("Chapters", plan.chapters.length >= 2 || plan.duration < 90, "info", `${plan.chapters.length} chapter suggestions`);
  add("Short segments", !plan.keep.some((s) => s.duration < 0.2), "warning", plan.keep.some((s) => s.duration < 0.2) ? "Some cuts are shorter than 200ms and need review" : "No ultra-short cuts detected");
  add("Transcript coverage", plan.keep.length > 0, "error", plan.keep.length ? `${plan.keep.length} usable speech segments` : "No speech segments available");
  const errors = checks.filter((c) => !c.ok && c.severity === "error").length;
  const warnings = checks.filter((c) => !c.ok && c.severity === "warning").length;
  return { ok: errors === 0, score: Math.max(0, Number((1 - errors * 0.25 - warnings * 0.08).toFixed(3))), checks };
}
