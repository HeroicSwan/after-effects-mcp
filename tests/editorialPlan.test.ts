import { describe, expect, it } from "vitest";
import { buildEditorialPlan } from "../src/media/editorialPlan.js";
import { auditEditorialPlan } from "../src/media/qualityAudit.js";

describe("editorial plan", () => {
  it("removes filler words and identifies a hook", () => {
    const plan = buildEditorialPlan({
      source: "demo.mp4",
      duration: 12,
      segments: [
        { start: 0, end: 3, text: "Um this is the important idea!" },
        { start: 3.2, end: 7, text: "The workflow saves three hours every week." },
      ],
      words: [
        { start: 0, end: 0.3, word: "Um" },
        { start: 0.4, end: 0.7, word: "this" },
        { start: 0.8, end: 1.1, word: "is" },
        { start: 1.2, end: 1.6, word: "the" },
        { start: 1.7, end: 2.4, word: "important" },
        { start: 2.5, end: 3, word: "idea" },
      ],
    }, "retention");
    expect(plan.hook).not.toBeNull();
    expect(plan.keep[0]?.text).not.toMatch(/\bum\b/i);
    expect(plan.removed.some((item) => item.reason === "filler")).toBe(true);
  });

  it("audits a plan without mutating AE", () => {
    const plan = buildEditorialPlan({ duration: 5, segments: [{ start: 0, end: 2, text: "Here is the point." }] });
    const audit = auditEditorialPlan(plan);
    expect(audit.checks.length).toBeGreaterThan(3);
    expect(audit.score).toBeGreaterThanOrEqual(0);
  });
});
