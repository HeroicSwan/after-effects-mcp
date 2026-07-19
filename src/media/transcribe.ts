/**
 * Node wrapper: extract audio + run Python whisper helper.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { getDataRoot, ensureDataDirs, getPackageRoot } from "../util/paths.js";
import type { TranscriptDoc } from "./transcriptEdit.js";

function scriptPath(): string {
  const pkg = getPackageRoot();
  const p = path.join(pkg, "scripts", "transcribe_video.py");
  if (fs.existsSync(p)) return p;
  // dev
  const alt = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "transcribe_video.py");
  return path.resolve(alt);
}

/** Prefer a Python that can import faster_whisper or whisper (Windows: py -3 often wins over a broken venv `python`). */
export function findPython(): string {
  const candidates: { cmd: string; prefix: string[] }[] = [
    { cmd: "py", prefix: ["-3"] },
    { cmd: "python", prefix: [] },
    { cmd: "python3", prefix: [] },
  ];

  let fallback: string | null = null;
  for (const { cmd, prefix } of candidates) {
    const ver = spawnSync(cmd, [...prefix, "--version"], { encoding: "utf8" });
    if (ver.error || (ver.status !== 0 && ver.status !== null)) continue;
    if (!fallback) fallback = cmd === "py" ? "py" : cmd;

    // Prefer interpreter that already has Whisper
    const probe = spawnSync(
      cmd,
      [...prefix, "-c", "import faster_whisper; print('ok')"],
      { encoding: "utf8" },
    );
    if (!probe.error && probe.status === 0 && (probe.stdout || "").includes("ok")) {
      return cmd === "py" ? "py" : cmd;
    }
    const probe2 = spawnSync(
      cmd,
      [...prefix, "-c", "import whisper; print('ok')"],
      { encoding: "utf8" },
    );
    if (!probe2.error && probe2.status === 0 && (probe2.stdout || "").includes("ok")) {
      return cmd === "py" ? "py" : cmd;
    }
  }
  if (fallback) return fallback;
  throw new Error("Python not found on PATH");
}

export interface TranscribeOptions {
  model?: string;
  language?: string;
  outPath?: string;
}

export function transcribeVideo(
  videoPath: string,
  options: TranscribeOptions = {},
): TranscriptDoc {
  if (!fs.existsSync(videoPath)) {
    throw new Error(`File not found: ${videoPath}`);
  }
  ensureDataDirs();
  const py = findPython();
  const script = scriptPath();
  if (!fs.existsSync(script)) {
    throw new Error(`Missing ${script}`);
  }

  const outDir = path.join(getDataRoot(), "transcripts");
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.basename(videoPath, path.extname(videoPath)).replace(/[^\w\-]+/g, "_");
  const outPath =
    options.outPath ||
    path.join(outDir, `${base}_${Date.now().toString(36)}.json`);

  const args = [
    script,
    "--input",
    videoPath,
    "--out",
    outPath,
    "--model",
    options.model || "base",
  ];
  if (options.language) {
    args.push("--language", options.language);
  }

  // Windows py launcher
  const cmd = py === "py" ? "py" : py;
  const fullArgs = py === "py" ? ["-3", ...args] : args;

  const r = spawnSync(cmd, fullArgs, {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    env: { ...process.env },
  });

  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || "").slice(-3000);
    throw new Error(
      `Transcription failed (exit ${r.status}). ${err}\nHint: pip install faster-whisper`,
    );
  }

  // Prefer written file
  if (fs.existsSync(outPath)) {
    return JSON.parse(fs.readFileSync(outPath, "utf8")) as TranscriptDoc;
  }
  // stdout JSON
  const text = (r.stdout || "").trim();
  if (!text) throw new Error("Empty transcript output");
  return JSON.parse(text) as TranscriptDoc;
}

export function ensureWhisperHint(): string {
  return [
    "Transcription needs Python + a Whisper package:",
    "  pip install faster-whisper",
    "  # or: pip install openai-whisper",
    "Also needs ffmpeg on PATH (you already have it).",
  ].join("\n");
}
