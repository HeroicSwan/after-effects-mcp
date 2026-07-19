/**
 * Turn timestamped transcripts into KEEP cut segments:
 * - drop filler words / stutters / short garbage
 * - merge nearby kept words into speech runs
 * - add pad before/after for clean edits
 */

export interface TranscriptWord {
  start: number;
  end: number;
  word: string;
  probability?: number;
}

export interface TranscriptSegment {
  id?: number;
  start: number;
  end: number;
  text: string;
}

export interface TranscriptDoc {
  source?: string;
  language?: string;
  duration?: number;
  text?: string;
  segments?: TranscriptSegment[];
  words?: TranscriptWord[];
  engine?: string;
  model?: string;
}

export interface KeepSegment {
  start: number;
  end: number;
  duration: number;
  text?: string;
}

export interface RemovedWord {
  word: string;
  start: number;
  end: number;
  reason: "filler" | "stutter" | "low_confidence" | "short_noise";
}

export interface TranscriptEditOptions {
  /** Seconds of handles before/after each keep run (default 0.12 / 0.18) */
  padBefore?: number;
  padAfter?: number;
  /** Min gap between runs to keep separate (default 0.28) */
  mergeGap?: number;
  /** Drop words shorter than this when likely noise (default 0.04) */
  minWordDur?: number;
  /** Drop short low-confidence noise tokens (default 0.12) */
  minProbability?: number;
  /** Custom fillers (lowercase, no punctuation) */
  extraFillers?: string[];
  /** Strip vocal fillers um/uh/… (default true) */
  includeFillers?: boolean;
  /** Also strip like/basically/actually/well/… (default false — too aggressive for many talks) */
  aggressiveFillers?: boolean;
  removeStutters?: boolean;
}

/** Pure vocal tics — safe to always strip */
const DEFAULT_FILLERS = new Set(
  [
    "um",
    "uh",
    "uhh",
    "umm",
    "erm",
    "ah",
    "eh",
    "hm",
    "hmm",
    "mhm",
    "mm",
    "mmm",
    "uhuh",
    "huh",
  ].map((s) => s.toLowerCase()),
);

/**
 * Discourse fillers — only when aggressiveFillers is on.
 * Never put real content words like "you" / "to" here alone.
 */
const AGGRESSIVE_FILLERS = new Set(
  [
    "like",
    "literally",
    "basically",
    "actually",
    "honestly",
    "okay",
    "ok",
    "well",
    "yeah",
    "yep",
    "yup",
    "nah",
    "sorta",
    "kinda",
  ].map((s) => s.toLowerCase()),
);

function normalizeWord(w: string): string {
  return w
    .toLowerCase()
    .replace(/^[^a-z0-9']+|[^a-z0-9']+$/gi, "")
    .replace(/'/g, "'");
}

function isFillerToken(
  norm: string,
  extras: Set<string>,
  aggressive: boolean,
): boolean {
  if (!norm) return true;
  if (DEFAULT_FILLERS.has(norm) || extras.has(norm)) return true;
  if (aggressive && AGGRESSIVE_FILLERS.has(norm)) return true;
  // pure non-speech noise tokens (uuuh, mmm)
  if (/^[uh]+m*$/i.test(norm)) return true;
  if (/^m+$/i.test(norm)) return true;
  return false;
}

/** Detect immediate word repeats: "I I think" / "the the" */
function isStutter(
  prev: TranscriptWord | null,
  cur: TranscriptWord,
  gapMax = 0.45,
): boolean {
  if (!prev) return false;
  const a = normalizeWord(prev.word);
  const b = normalizeWord(cur.word);
  if (!a || !b) return false;
  if (a !== b) return false;
  const gap = cur.start - prev.end;
  return gap >= 0 && gap <= gapMax;
}

/** "you know" bigram filler */
function isYouKnowBigram(prev: TranscriptWord | null, cur: TranscriptWord): boolean {
  if (!prev) return false;
  return normalizeWord(prev.word) === "you" && normalizeWord(cur.word) === "know";
}

export function wordsFromTranscript(doc: TranscriptDoc): TranscriptWord[] {
  if (doc.words && doc.words.length) {
    return doc.words.map((w) => ({
      start: Number(w.start),
      end: Number(w.end),
      word: String(w.word || ""),
      probability: w.probability,
    }));
  }
  // Fallback: treat segment text as one "word" blob (worse cuts)
  return (doc.segments || []).map((s) => ({
    start: Number(s.start),
    end: Number(s.end),
    word: String(s.text || ""),
    probability: 1,
  }));
}

export function planCutsFromTranscript(
  doc: TranscriptDoc,
  options: TranscriptEditOptions = {},
): {
  keep: KeepSegment[];
  removed: RemovedWord[];
  keptSeconds: number;
  removedSeconds: number;
  cleanedText: string;
  srt: string;
  optionsUsed: Required<
    Pick<
      TranscriptEditOptions,
      | "padBefore"
      | "padAfter"
      | "mergeGap"
      | "minWordDur"
      | "minProbability"
      | "includeFillers"
      | "aggressiveFillers"
      | "removeStutters"
    >
  >;
} {
  const padBefore = options.padBefore ?? 0.12;
  const padAfter = options.padAfter ?? 0.18;
  const mergeGap = options.mergeGap ?? 0.28;
  const minWordDur = options.minWordDur ?? 0.04;
  const minProbability = options.minProbability ?? 0.12;
  const includeFillers = options.includeFillers !== false;
  const aggressiveFillers = options.aggressiveFillers === true;
  const removeStutters = options.removeStutters !== false;
  const extras = new Set((options.extraFillers || []).map((s) => s.toLowerCase()));

  const words = wordsFromTranscript(doc).sort((a, b) => a.start - b.start);
  const duration =
    doc.duration && doc.duration > 0
      ? doc.duration
      : words.length
        ? words[words.length - 1]!.end
        : 0;

  const removed: RemovedWord[] = [];
  const keptWords: TranscriptWord[] = [];
  let prevKept: TranscriptWord | null = null;
  let prevAny: TranscriptWord | null = null;

  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const norm = normalizeWord(w.word);
    const dur = Math.max(0, w.end - w.start);

    // Only drop ultra-short noise tokens (not real words like "to"/"be" with glitchy timestamps)
    if (
      dur > 0 &&
      dur < minWordDur &&
      (norm.length <= 1 || /^[uhmeah]+$/i.test(norm) || !/[a-z]/i.test(norm))
    ) {
      removed.push({ word: w.word, start: w.start, end: w.end, reason: "short_noise" });
      prevAny = w;
      continue;
    }
    // Low confidence: only drop very short, filler-like tokens
    if (
      w.probability !== undefined &&
      w.probability > 0 &&
      w.probability < minProbability &&
      norm.length <= 2 &&
      (DEFAULT_FILLERS.has(norm) || /^[uh]+m*$/i.test(norm) || /^m+$/i.test(norm))
    ) {
      removed.push({ word: w.word, start: w.start, end: w.end, reason: "low_confidence" });
      prevAny = w;
      continue;
    }

    if (removeStutters && isStutter(prevAny, w)) {
      removed.push({ word: w.word, start: w.start, end: w.end, reason: "stutter" });
      prevAny = w;
      continue;
    }

    if (includeFillers) {
      if (isYouKnowBigram(prevAny, w)) {
        // remove "know" and previous "you" if kept
        removed.push({ word: w.word, start: w.start, end: w.end, reason: "filler" });
        if (prevKept && normalizeWord(prevKept.word) === "you") {
          const popped = keptWords.pop();
          if (popped) {
            removed.push({
              word: popped.word,
              start: popped.start,
              end: popped.end,
              reason: "filler",
            });
            prevKept = keptWords[keptWords.length - 1] ?? null;
          }
        }
        prevAny = w;
        continue;
      }
      // "i mean" bigram
      if (
        prevAny &&
        normalizeWord(prevAny.word) === "i" &&
        (norm === "mean" || norm === "meant")
      ) {
        removed.push({ word: w.word, start: w.start, end: w.end, reason: "filler" });
        if (prevKept && normalizeWord(prevKept.word) === "i") {
          const popped = keptWords.pop();
          if (popped) {
            removed.push({
              word: popped.word,
              start: popped.start,
              end: popped.end,
              reason: "filler",
            });
            prevKept = keptWords[keptWords.length - 1] ?? null;
          }
        }
        prevAny = w;
        continue;
      }
      if (isFillerToken(norm, extras, aggressiveFillers)) {
        removed.push({ word: w.word, start: w.start, end: w.end, reason: "filler" });
        prevAny = w;
        continue;
      }
    }

    keptWords.push(w);
    prevKept = w;
    prevAny = w;
  }

  // Build runs from kept words
  const runs: KeepSegment[] = [];
  if (keptWords.length) {
    let runStart = keptWords[0]!.start;
    let runEnd = keptWords[0]!.end;
    let runText: string[] = [keptWords[0]!.word];

    for (let i = 1; i < keptWords.length; i++) {
      const w = keptWords[i]!;
      const gap = w.start - runEnd;
      if (gap <= mergeGap) {
        runEnd = Math.max(runEnd, w.end);
        runText.push(w.word);
      } else {
        runs.push({
          start: runStart,
          end: runEnd,
          duration: runEnd - runStart,
          text: runText.join(" ").replace(/\s+/g, " ").trim(),
        });
        runStart = w.start;
        runEnd = w.end;
        runText = [w.word];
      }
    }
    runs.push({
      start: runStart,
      end: runEnd,
      duration: runEnd - runStart,
      text: runText.join(" ").replace(/\s+/g, " ").trim(),
    });
  }

  // Apply pad / clamp
  const keep: KeepSegment[] = runs.map((r) => {
    const start = Math.max(0, r.start - padBefore);
    const end = Math.min(duration || r.end + padAfter, r.end + padAfter);
    return {
      start,
      end,
      duration: Math.max(0, end - start),
      text: r.text,
    };
  });

  // Merge overlapping after pad
  const merged: KeepSegment[] = [];
  for (const k of keep) {
    const last = merged[merged.length - 1];
    if (last && k.start <= last.end + 0.05) {
      last.end = Math.max(last.end, k.end);
      last.duration = last.end - last.start;
      last.text = [last.text, k.text].filter(Boolean).join(" ");
    } else {
      merged.push({ ...k });
    }
  }

  const keptSeconds = merged.reduce((s, k) => s + k.duration, 0);
  const removedSeconds = Math.max(0, (duration || keptSeconds) - keptSeconds);
  const cleanedText = keptWords
    .map((w) => w.word)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  const srt = toSrt(
    merged.map((m, i) => ({
      id: i + 1,
      start: m.start,
      end: m.end,
      text: m.text || "",
    })),
  );

  return {
    keep: merged,
    removed,
    keptSeconds,
    removedSeconds,
    cleanedText,
    srt,
    optionsUsed: {
      padBefore,
      padAfter,
      mergeGap,
      minWordDur,
      minProbability,
      includeFillers,
      aggressiveFillers,
      removeStutters,
    },
  };
}

function fmtSrtTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

export function toSrt(
  cues: { id: number; start: number; end: number; text: string }[],
): string {
  return cues
    .map((c) => `${c.id}\n${fmtSrtTime(c.start)} --> ${fmtSrtTime(c.end)}\n${c.text}\n`)
    .join("\n");
}

export function toVtt(doc: TranscriptDoc): string {
  const segs = doc.segments || [];
  const body = segs
    .map((s) => {
      const a = fmtSrtTime(s.start).replace(",", ".");
      const b = fmtSrtTime(s.end).replace(",", ".");
      return `${a} --> ${b}\n${s.text}\n`;
    })
    .join("\n");
  return `WEBVTT\n\n${body}`;
}
