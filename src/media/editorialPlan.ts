import type { TranscriptDoc, TranscriptSegment, TranscriptWord } from "./transcriptEdit.js";
import { planCutsFromTranscript, wordsFromTranscript } from "./transcriptEdit.js";
import type { EditMode } from "../workflow/preferences.js";

export interface EditorialSegment {
  start: number;
  end: number;
  duration: number;
  text: string;
  score: number;
  reason: string;
  cutQuality: { sentenceBoundary: boolean; naturalPause: boolean; semanticEmphasis: boolean; score: number };
  visualSuggestion?: string;
}

export interface ChapterSuggestion {
  start: number;
  title: string;
}

export interface EditorialPlan {
  mode: EditMode;
  source: string;
  duration: number;
  hook: { start: number; end: number; text: string; reason: string } | null;
  keep: EditorialSegment[];
  chapters: ChapterSuggestion[];
  removed: { start: number; end: number; reason: string }[];
  visualSuggestions: { start: number; end: number; suggestion: string }[];
  brollSuggestions: { start: number; end: number; query: string; reason: string }[];
  structure: { hook: string; promise: string; sections: string[]; payoff: string; callToAction: string };
  pacing: { averageShotSeconds: number; cutsPerMinute: number; score: number };
}

function textOf(s: TranscriptSegment | undefined): string {
  return (s?.text || "").replace(/\s+/g, " ").trim();
}

function sentenceBoundary(text: string): boolean {
  return /[.!?…]$/.test(text.trim());
}

function topicTitle(text: string): string {
  const words = text.replace(/[^a-zA-Z0-9 ]/g, "").split(/\s+/).filter(Boolean);
  return words.slice(0, 6).join(" ") || "Section";
}

function energy(text: string): number {
  const emphasis = (text.match(/[!?]/g) || []).length;
  const longWords = text.split(/\s+/).filter((w) => w.length > 8).length;
  return Math.min(1, 0.35 + emphasis * 0.12 + longWords * 0.02);
}

function segmentScore(segment: TranscriptSegment, next?: TranscriptSegment): number {
  const t = textOf(segment);
  let score = 0.45 + energy(t) * 0.25;
  if (sentenceBoundary(t)) score += 0.18;
  if (/\b(the point|remember|important|because|here's why|finally|the best)\b/i.test(t)) score += 0.12;
  if (next && next.start - segment.end > 0.35) score += 0.08;
  return Math.min(1, Number(score.toFixed(3)));
}

function cutQuality(segment: TranscriptSegment, next?: TranscriptSegment): EditorialSegment["cutQuality"] {
  const text = textOf(segment);
  const sentenceBoundaryValue = sentenceBoundary(text);
  const naturalPause = !!next && next.start - segment.end >= 0.28;
  const semanticEmphasis = /\b(important|because|remember|point|best|finally|why)\b/i.test(text) || /[!?]/.test(text);
  const score = Math.min(1, 0.38 + (sentenceBoundaryValue ? 0.28 : 0) + (naturalPause ? 0.18 : 0) + (semanticEmphasis ? 0.16 : 0));
  return { sentenceBoundary: sentenceBoundaryValue, naturalPause, semanticEmphasis, score: Number(score.toFixed(3)) };
}

function visualFor(text: string): string | undefined {
  if (/\b(number|percent|million|billion|three|four|five|ten)\b/i.test(text)) return "Statistic or kinetic number callout";
  if (/\b(show|look|example|screen|step|process|before|after)\b/i.test(text)) return "B-roll, screen capture, or before/after graphic";
  if (/[!?]/.test(text)) return "Punch-in or kinetic emphasis on the key phrase";
  return undefined;
}

function brollFor(text: string): { query: string; reason: string } | undefined {
  if (/\b(screen|software|app|workflow|step|process)\b/i.test(text)) return { query: "screen recording or workflow demonstration", reason: "The line describes a process" };
  if (/\b(before|after|change|improve|faster|slow)\b/i.test(text)) return { query: "before and after comparison graphic", reason: "The line implies a contrast" };
  if (/\b(number|percent|million|billion|hours|dollars)\b/i.test(text)) return { query: "minimal data visualization or kinetic statistic", reason: "The line contains a measurable claim" };
  return undefined;
}

function removeRanges(words: TranscriptWord[]): { start: number; end: number; reason: string }[] {
  const ranges: { start: number; end: number; reason: string }[] = [];
  for (const word of words) {
    const n = word.word.toLowerCase().replace(/[^a-z]/g, "");
    if (/^(um|uh|umm|uhh|erm|hmm|like)$/.test(n)) ranges.push({ start: word.start, end: word.end, reason: "Filler word" });
  }
  return ranges;
}

export function buildEditorialPlan(doc: TranscriptDoc, mode: EditMode = "clean"): EditorialPlan {
  const segments = (doc.segments || []).slice().sort((a, b) => a.start - b.start);
  const duration = doc.duration || segments.at(-1)?.end || wordsFromTranscript(doc).at(-1)?.end || 0;
  const keep: EditorialSegment[] = [];
  const cleaned = planCutsFromTranscript(doc, {
    padBefore: mode === "retention" ? 0.08 : 0.12,
    padAfter: mode === "retention" ? 0.12 : 0.18,
    mergeGap: mode === "retention" ? 0.2 : 0.28,
    aggressiveFillers: mode === "retention",
    includeFillers: true,
    removeStutters: true,
  });
  const removed = [
    ...removeRanges(wordsFromTranscript(doc)),
    ...cleaned.removed.map((r) => ({ start: r.start, end: r.end, reason: r.reason })),
  ];
  const visualSuggestions: { start: number; end: number; suggestion: string }[] = [];
  const brollSuggestions: { start: number; end: number; query: string; reason: string }[] = [];

  for (let i = 0; i < cleaned.keep.length; i++) {
    const s = cleaned.keep[i]!;
    const sourceSegment = segments.find((candidate) => candidate.start <= s.end && candidate.end >= s.start);
    const text = s.text || textOf(sourceSegment);
    if (!text) continue;
    const nextSource = sourceSegment ? segments[segments.indexOf(sourceSegment) + 1] : undefined;
    const quality = sourceSegment ? cutQuality(sourceSegment, nextSource) : { sentenceBoundary: false, naturalPause: false, semanticEmphasis: false, score: 0.5 };
    const score = sourceSegment ? Math.max(segmentScore(sourceSegment, nextSource), quality.score) : 0.5;
    const short = s.end - s.start < (mode === "retention" ? 0.35 : 0.2);
    if (short && mode !== "story") {
      removed.push({ start: s.start, end: s.end, reason: "Very short speech fragment" });
      continue;
    }
    const visualSuggestion = visualFor(text);
    keep.push({ start: s.start, end: s.end, duration: s.end - s.start, text, score, cutQuality: quality, reason: quality.sentenceBoundary ? "Sentence boundary" : "Natural speech segment after filler cleanup", visualSuggestion });
    if (visualSuggestion) visualSuggestions.push({ start: s.start, end: s.end, suggestion: visualSuggestion });
    const broll = brollFor(text);
    if (broll) brollSuggestions.push({ start: s.start, end: s.end, ...broll });
  }

  const hookCandidate = keep.filter((s) => s.start < Math.min(30, duration)).sort((a, b) => b.score - a.score)[0] || keep[0];
  const hook = hookCandidate ? { start: hookCandidate.start, end: hookCandidate.end, text: hookCandidate.text, reason: "Strongest early statement; use as hook candidate" } : null;
  const chapters = keep.filter((s, i) => i === 0 || s.start - keep[i - 1]!.end > 8 || /\b(first|second|third|next|finally|chapter)\b/i.test(s.text)).slice(0, 12).map((s) => ({ start: s.start, title: topicTitle(s.text) }));
  const cutsPerMinute = duration > 0 ? (Math.max(0, keep.length - 1) / duration) * 60 : 0;
  const averageShotSeconds = keep.length ? keep.reduce((sum, s) => sum + s.duration, 0) / keep.length : 0;
  const target = mode === "retention" ? 8 : mode === "story" ? 14 : 11;
  const pacingScore = Math.max(0, Math.min(1, 1 - Math.abs(averageShotSeconds - target) / target));

  return {
    mode,
    source: doc.source || "",
    duration,
    hook,
    keep,
    chapters,
    removed: removed.sort((a, b) => a.start - b.start),
    visualSuggestions,
    brollSuggestions,
    structure: {
      hook: hook ? hook.text : "No hook detected",
      promise: keep[1]?.text || keep[0]?.text || "Define the viewer promise",
      sections: chapters.map((chapter) => chapter.title),
      payoff: keep.at(-1)?.text || "No clear payoff detected",
      callToAction: keep.find((s) => /\b(subscribe|comment|follow|learn more|link below)\b/i.test(s.text))?.text || "Add a concise call to action",
    },
    pacing: { averageShotSeconds: Number(averageShotSeconds.toFixed(2)), cutsPerMinute: Number(cutsPerMinute.toFixed(2)), score: Number(pacingScore.toFixed(3)) },
  };
}
