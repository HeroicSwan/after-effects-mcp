/**
 * Smart cut detection via ffmpeg silencedetect.
 * Returns KEEP segments (content), not silence ranges.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";

export interface SilenceRange {
  start: number;
  end: number;
  duration: number;
}

export interface KeepSegment {
  start: number;
  end: number;
  duration: number;
}

export interface SmartCutOptions {
  /** dB threshold (default -35) */
  noiseDb?: number;
  /** Min silence length to cut (seconds, default 0.45) */
  minSilence?: number;
  /** Min keep segment length (default 0.4) */
  minKeep?: number;
  /** Pad kept edges slightly (default 0.05) */
  pad?: number;
  /** Max output duration for highlight mode (optional) */
  maxDuration?: number;
}

function findFfmpeg(): string {
  const r = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
  if (r.error || r.status !== 0) {
    throw new Error("ffmpeg not found on PATH — required for smart cuts");
  }
  return "ffmpeg";
}

export function detectSilences(
  videoPath: string,
  options: SmartCutOptions = {},
): SilenceRange[] {
  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video not found: ${videoPath}`);
  }
  const noise = options.noiseDb ?? -35;
  const minSil = options.minSilence ?? 0.45;
  const ffmpeg = findFfmpeg();

  const r = spawnSync(
    ffmpeg,
    [
      "-hide_banner",
      "-i",
      videoPath,
      "-af",
      `silencedetect=noise=${noise}dB:d=${minSil}`,
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
  );
  const stderr = `${r.stderr || ""}${r.stdout || ""}`;

  const ranges: SilenceRange[] = [];
  let curStart: number | null = null;
  const lines = stderr.split(/\r?\n/);
  for (const line of lines) {
    const s = line.match(/silence_start:\s*([0-9.]+)/);
    if (s) {
      curStart = parseFloat(s[1]!);
      continue;
    }
    const e = line.match(
      /silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/,
    );
    if (e && curStart !== null) {
      ranges.push({
        start: curStart,
        end: parseFloat(e[1]!),
        duration: parseFloat(e[2]!),
      });
      curStart = null;
    }
  }
  return ranges;
}

export function getMediaDuration(videoPath: string): number {
  // Prefer ffprobe (clean stdout)
  const probe = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      videoPath,
    ],
    { encoding: "utf8" },
  );
  if (probe.status === 0 && probe.stdout) {
    const d = parseFloat(probe.stdout.trim());
    if (!Number.isNaN(d) && d > 0) return d;
  }

  const ffmpeg = findFfmpeg();
  const r = spawnSync(ffmpeg, ["-i", videoPath, "-f", "null", "-"], {
    encoding: "utf8",
  });
  const stderr = `${r.stderr || ""}`;
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  if (m) {
    return (
      parseInt(m[1]!, 10) * 3600 + parseInt(m[2]!, 10) * 60 + parseFloat(m[3]!)
    );
  }
  throw new Error("Could not determine media duration");
}

/**
 * Invert silences → keep segments (the parts that should remain).
 */
export function silencesToKeep(
  silences: SilenceRange[],
  duration: number,
  options: SmartCutOptions = {},
): KeepSegment[] {
  const minKeep = options.minKeep ?? 0.4;
  var pad = options.pad ?? 0.05;
  const sorted = silences.slice().sort((a, b) => a.start - b.start);

  const keep: KeepSegment[] = [];
  let cursor = 0;

  for (const sil of sorted) {
    const end = Math.max(0, sil.start - pad);
    if (end > cursor + minKeep) {
      const start = Math.max(0, cursor);
      keep.push({
        start,
        end: Math.min(duration, end),
        duration: Math.min(duration, end) - start,
      });
    }
    cursor = Math.min(duration, sil.end + pad);
  }
  if (cursor < duration - minKeep) {
    keep.push({
      start: cursor,
      end: duration,
      duration: duration - cursor,
    });
  }

  // Merge tiny gaps between keeps if accidental
  const merged: KeepSegment[] = [];
  for (const k of keep) {
    if (k.duration < minKeep) continue;
    const last = merged[merged.length - 1];
    if (last && k.start - last.end < 0.15) {
      last.end = k.end;
      last.duration = last.end - last.start;
    } else {
      merged.push({ ...k });
    }
  }

  // Optional max duration: keep longest / first segments until cap
  if (options.maxDuration && options.maxDuration > 0) {
    const capped: KeepSegment[] = [];
    let used = 0;
    for (const k of merged) {
      if (used >= options.maxDuration) break;
      const take = Math.min(k.duration, options.maxDuration - used);
      capped.push({
        start: k.start,
        end: k.start + take,
        duration: take,
      });
      used += take;
    }
    return capped;
  }

  return merged;
}

export function analyzeSmartCuts(
  videoPath: string,
  options: SmartCutOptions = {},
): {
  duration: number;
  silences: SilenceRange[];
  keep: KeepSegment[];
  removedSeconds: number;
  keptSeconds: number;
} {
  const duration = getMediaDuration(videoPath);
  const silences = detectSilences(videoPath, options);
  const keep = silencesToKeep(silences, duration, options);
  const keptSeconds = keep.reduce((s, k) => s + k.duration, 0);
  return {
    duration,
    silences,
    keep,
    removedSeconds: Math.max(0, duration - keptSeconds),
    keptSeconds,
  };
}
