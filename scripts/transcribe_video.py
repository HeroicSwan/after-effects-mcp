#!/usr/bin/env python3
"""
Transcribe a video/audio file with word-level timestamps.
Uses faster-whisper if available, else openai-whisper.
Outputs JSON to stdout (or --out path).

Usage:
  python scripts/transcribe_video.py --input video.mp4 --out transcript.json
  python scripts/transcribe_video.py --input video.mp4 --model base --language en
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


def extract_wav(input_path: str, wav_path: str) -> None:
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        input_path,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        wav_path,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0 and not Path(wav_path).exists():
        raise RuntimeError(f"ffmpeg failed:\n{r.stderr[-2000:]}")


def transcribe_faster(wav: str, model_size: str, language: str | None):
    from faster_whisper import WhisperModel

    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    segments_iter, info = model.transcribe(
        wav,
        language=language,
        word_timestamps=True,
        vad_filter=True,
    )
    segments = []
    words = []
    full = []
    for seg in segments_iter:
        text = (seg.text or "").strip()
        segments.append(
            {
                "id": len(segments),
                "start": float(seg.start),
                "end": float(seg.end),
                "text": text,
            }
        )
        full.append(text)
        if seg.words:
            for w in seg.words:
                words.append(
                    {
                        "start": float(w.start),
                        "end": float(w.end),
                        "word": (w.word or "").strip(),
                        "probability": float(getattr(w, "probability", 0) or 0),
                    }
                )
    return {
        "engine": "faster-whisper",
        "model": model_size,
        "language": getattr(info, "language", language),
        "duration": float(getattr(info, "duration", 0) or 0),
        "text": " ".join(full).strip(),
        "segments": segments,
        "words": words,
    }


def transcribe_openai(wav: str, model_size: str, language: str | None):
    import whisper

    model = whisper.load_model(model_size)
    result = model.transcribe(
        wav,
        language=language,
        word_timestamps=True,
        verbose=False,
    )
    segments = []
    words = []
    for i, seg in enumerate(result.get("segments") or []):
        segments.append(
            {
                "id": i,
                "start": float(seg["start"]),
                "end": float(seg["end"]),
                "text": (seg.get("text") or "").strip(),
            }
        )
        for w in seg.get("words") or []:
            words.append(
                {
                    "start": float(w["start"]),
                    "end": float(w["end"]),
                    "word": (w.get("word") or "").strip(),
                    "probability": float(w.get("probability") or 0),
                }
            )
    return {
        "engine": "openai-whisper",
        "model": model_size,
        "language": result.get("language") or language,
        "duration": float(segments[-1]["end"]) if segments else 0,
        "text": (result.get("text") or "").strip(),
        "segments": segments,
        "words": words,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--out", default="")
    ap.add_argument("--model", default="base")
    ap.add_argument("--language", default="")
    args = ap.parse_args()

    inp = Path(args.input)
    if not inp.exists():
        print(json.dumps({"error": f"File not found: {inp}"}), file=sys.stderr)
        return 1

    lang = args.language or None
    with tempfile.TemporaryDirectory() as td:
        wav = os.path.join(td, "audio.wav")
        extract_wav(str(inp), wav)

        err = None
        data = None
        try:
            data = transcribe_faster(wav, args.model, lang)
        except Exception as e:
            err = f"faster-whisper: {e}"
            try:
                data = transcribe_openai(wav, args.model, lang)
                err = None
            except Exception as e2:
                err = f"{err}; openai-whisper: {e2}"

        if data is None:
            print(
                json.dumps(
                    {
                        "error": err
                        or "No STT engine",
                        "hint": "pip install faster-whisper   OR   pip install openai-whisper torch",
                    }
                ),
                file=sys.stderr,
            )
            return 2

        data["source"] = str(inp.resolve())
        out = json.dumps(data, ensure_ascii=False, indent=2)
        if args.out:
            Path(args.out).write_text(out, encoding="utf-8")
        print(out)
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
