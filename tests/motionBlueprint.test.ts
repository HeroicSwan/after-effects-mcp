import { describe, expect, it } from "vitest";
import { auditMotionBlueprint } from "../src/workflow/coherenceAudit.js";
import { createMotionBlueprint } from "../src/workflow/motionBlueprint.js";
import { repairMotionVideoBlueprint } from "../src/workflow/repairPass.js";
import { auditMotionCoverage } from "../src/workflow/mographAudit.js";

const brand = {
  primaryColor: [0.08, 0.08, 0.1] as [number, number, number],
  secondaryColor: [1, 1, 1] as [number, number, number],
  accentColor: [0.2, 0.65, 1] as [number, number, number],
  fontFamily: "Arial",
  captionFontSize: 54,
  safeMargin: 100,
  aspectRatio: "16:9" as const,
};

describe("motion video blueprint", () => {
  it("creates a complete coherent default scene progression", () => {
    const blueprint = createMotionBlueprint({ brief: "A better way to explain complex ideas", compName: "Demo", duration: 30, frameRate: 30, aspectRatio: "16:9", brand });
    const audit = auditMotionBlueprint(blueprint);
    expect(blueprint.scenes.map((scene) => scene.purpose)).toEqual(["hook", "setup", "explanation", "payoff", "cta"]);
    expect(blueprint.scenes[0]?.start).toBe(0);
    expect(blueprint.scenes.at(-1)?.end).toBe(30);
    expect(blueprint.visualStyle).toBe("japanese-pop");
    expect(blueprint.scenes.every((scene) => scene.beats.length >= 4)).toBe(true);
    expect(audit.ok).toBe(true);
    expect(auditMotionCoverage(blueprint).ok).toBe(true);
  });

  it("repairs timing, unsupported templates, and oversized titles", () => {
    const blueprint = createMotionBlueprint({
      brief: "Demo",
      compName: "Demo",
      duration: 10,
      frameRate: 30,
      aspectRatio: "16:9",
      brand,
      scenes: [
        { purpose: "hook", title: "One two three four five six seven eight nine ten", start: 1, end: 2, templateId: "missing" },
        { purpose: "cta", title: "Done", start: 4, end: 10, templateId: "end-screen" },
      ],
    });
    const result = repairMotionVideoBlueprint(blueprint);
    expect(result.repairs.length).toBeGreaterThan(0);
    expect(result.blueprint.scenes[0]?.start).toBe(0);
    expect(result.blueprint.scenes[0]?.templateId).toBe("quote-card");
    expect(result.after.checks.find((check) => check.name === "Timeline coverage")?.ok).toBe(true);
  });

  it("reports missing story anchors as errors", () => {
    const blueprint = createMotionBlueprint({
      brief: "Only one beat",
      compName: "Demo",
      duration: 4,
      frameRate: 30,
      aspectRatio: "16:9",
      brand,
      scenes: [{ purpose: "explanation", title: "Only beat", start: 0, end: 4 }],
    });
    const audit = auditMotionBlueprint(blueprint);
    expect(audit.ok).toBe(false);
    expect(audit.errors).toBeGreaterThan(0);
  });

  it("normalizes custom beats into a safe complete choreography", () => {
    const blueprint = createMotionBlueprint({
      brief: "Custom beats",
      compName: "Demo",
      duration: 4,
      frameRate: 30,
      aspectRatio: "16:9",
      brand,
      scenes: [{ purpose: "hook", title: "Custom", start: 0, end: 4, beats: [{ offset: 20, kind: "impact", intensity: 2 }] }],
    });
    const beats = blueprint.scenes[0]!.beats;
    expect(beats.some((beat) => beat.kind === "settle")).toBe(true);
    expect(beats.every((beat) => beat.offset < 4 && beat.intensity <= 1)).toBe(true);
  });
});
