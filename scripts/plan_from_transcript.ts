import fs from "fs";
import { planCutsFromTranscript } from "../src/media/transcriptEdit.ts";

const p = process.argv[2];
if (!p) throw new Error("Usage: tsx scripts/plan_from_transcript.ts <transcript.json> [output.json]");
const outputPath = process.argv[3] || "edit_plan_sample.json";
const doc = JSON.parse(fs.readFileSync(p, "utf8"));
console.log(
  "first words",
  JSON.stringify((doc.words || []).slice(0, 12), null, 2),
);
const plan = planCutsFromTranscript(doc, {
  padBefore: 0.12,
  padAfter: 0.18,
});
console.log("options", plan.optionsUsed);
console.log(
  "keep head",
  JSON.stringify(plan.keep.slice(0, 4), null, 2),
);
console.log(
  "removed",
  plan.removed.length,
  JSON.stringify(plan.removed.slice(0, 10), null, 2),
);
console.log("cleaned", plan.cleanedText.slice(0, 300));
fs.writeFileSync(
  outputPath,
  JSON.stringify(
    {
      source: doc.source,
      keep: plan.keep,
      cleanedText: plan.cleanedText,
      removed: plan.removed,
      options: plan.optionsUsed,
    },
    null,
    2,
  ),
);
