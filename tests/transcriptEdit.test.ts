import { describe, it, expect } from "vitest";
import { planCutsFromTranscript } from "../src/media/transcriptEdit.js";

describe("planCutsFromTranscript", () => {
  it("removes fillers and stutters and adds pad", () => {
    const plan = planCutsFromTranscript(
      {
        duration: 10,
        words: [
          { start: 1.0, end: 1.2, word: "Um" },
          { start: 1.3, end: 1.5, word: "I" },
          { start: 1.55, end: 1.7, word: "I" }, // stutter
          { start: 1.75, end: 2.1, word: "think" },
          { start: 2.15, end: 2.3, word: "we" },
          { start: 2.35, end: 2.6, word: "should" },
          { start: 3.5, end: 3.7, word: "like" },
          { start: 3.8, end: 4.2, word: "go" },
          { start: 4.25, end: 4.5, word: "now" },
        ],
      },
      { padBefore: 0.1, padAfter: 0.15, mergeGap: 0.3, aggressiveFillers: true },
    );

    const removedWords = plan.removed.map((r) => r.word.toLowerCase());
    expect(removedWords).toContain("um");
    expect(removedWords).toContain("like");
    // one of the I's removed as stutter
    expect(plan.removed.some((r) => r.reason === "stutter")).toBe(true);

    expect(plan.keep.length).toBeGreaterThanOrEqual(1);
    // first keep should start with pad before first kept word
    expect(plan.keep[0]!.start).toBeLessThan(1.3);
    expect(plan.cleanedText.toLowerCase()).toContain("think");
    expect(plan.cleanedText.toLowerCase()).not.toContain("um");
  });

  it("keeps discourse words unless aggressiveFillers", () => {
    const soft = planCutsFromTranscript({
      duration: 5,
      words: [
        { start: 1.0, end: 1.2, word: "thank" },
        { start: 1.25, end: 1.4, word: "you" },
        { start: 1.5, end: 1.8, word: "actually" },
      ],
    });
    expect(soft.cleanedText.toLowerCase()).toContain("you");
    expect(soft.cleanedText.toLowerCase()).toContain("actually");

    const hard = planCutsFromTranscript(
      {
        duration: 5,
        words: [
          { start: 1.0, end: 1.2, word: "thank" },
          { start: 1.25, end: 1.4, word: "you" },
          { start: 1.5, end: 1.8, word: "actually" },
        ],
      },
      { aggressiveFillers: true },
    );
    expect(hard.cleanedText.toLowerCase()).toContain("you");
    expect(hard.cleanedText.toLowerCase()).not.toContain("actually");
  });

  it("merges close words into one run", () => {
    const plan = planCutsFromTranscript({
      duration: 5,
      words: [
        { start: 0.5, end: 0.7, word: "Hello" },
        { start: 0.75, end: 1.0, word: "world" },
        { start: 1.05, end: 1.3, word: "today" },
      ],
    });
    expect(plan.keep.length).toBe(1);
    expect(plan.keep[0]!.text?.toLowerCase()).toContain("hello");
  });
});
