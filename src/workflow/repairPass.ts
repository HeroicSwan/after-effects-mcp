import { auditMotionBlueprint, type CoherenceAudit } from "./coherenceAudit.js";
import { repairMotionBlueprint, type MotionVideoBlueprint } from "./motionBlueprint.js";

export interface MotionRepairResult {
  blueprint: MotionVideoBlueprint;
  before: CoherenceAudit;
  after: CoherenceAudit;
  repairs: string[];
}

export function repairMotionVideoBlueprint(input: MotionVideoBlueprint): MotionRepairResult {
  const before = auditMotionBlueprint(input);
  const blueprint = repairMotionBlueprint(input);
  const after = auditMotionBlueprint(blueprint);
  const repairs: string[] = [];
  if (before.checks.find((check) => check.name === "Timeline coverage" && !check.ok)) repairs.push("Normalized scene timing to remove gaps");
  if (before.checks.find((check) => check.name === "No overlap" && !check.ok)) repairs.push("Normalized scene timing to remove overlaps");
  if (before.checks.find((check) => check.name === "Template compatibility" && !check.ok)) repairs.push("Replaced unknown templates with quote-card");
  if (before.checks.find((check) => check.name === "Graphic text density" && !check.ok)) repairs.push("Clamped graphic titles to the visual grammar limit");
  return { blueprint, before, after, repairs };
}
