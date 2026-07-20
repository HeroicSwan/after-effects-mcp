import argparse
import json
import re
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
INVENTORY = ROOT / "analysis" / "inventory" / "media.json"
TRANSCRIPT_DIR = ROOT / "analysis" / "transcripts"
DEFAULT_MODEL = ROOT / "models" / "ggml-large-v3-turbo-q5_0.bin"
SEGMENT_PATTERN = re.compile(
    r'^\{"start":(?P<start>\d+),"end":(?P<end>\d+),"text":"(?P<text>.*)"\}$'
)


def parse_segment(line):
    try:
        return json.loads(line)
    except json.JSONDecodeError:
        match = SEGMENT_PATTERN.match(line)
        if not match:
            raise
        return {
            "start": int(match.group("start")),
            "end": int(match.group("end")),
            "text": match.group("text"),
        }


def transcribe(asset, model, language, limit_seconds, force, recover_raw):
    output = TRANSCRIPT_DIR / f"{asset['asset_id']}.json"
    text_output = TRANSCRIPT_DIR / f"{asset['asset_id']}.txt"
    if output.exists() and not force:
        existing = json.loads(output.read_text(encoding="utf-8"))
        last_end = existing["segments"][-1]["end"] if existing["segments"] else 0
        if last_end >= asset["duration_seconds"] * 0.9:
            print(f"Skipped {asset['file_name']} (full transcript exists)")
            return

    raw_output = TRANSCRIPT_DIR / f".{asset['asset_id']}.jsonl"
    model_path = model.relative_to(ROOT).as_posix()
    destination = raw_output.relative_to(ROOT).as_posix()
    whisper_filter = (
        f"whisper=model={model_path}:language={language}:queue=20:"
        f"destination={destination}:format=json:max_len=80:use_gpu=true"
    )
    if not recover_raw:
        command = [
            "ffmpeg",
            "-hide_banner",
            "-v",
            "warning",
            "-i",
            asset["relative_path"],
        ]
        if limit_seconds:
            command.extend(["-t", str(limit_seconds)])
        command.extend(["-vn", "-af", whisper_filter, "-f", "null", "NUL"])
        subprocess.run(command, cwd=ROOT, check=True)
    elif not raw_output.exists():
        raise SystemExit(f"Raw transcript not found: {raw_output}")

    segments = []
    for line in raw_output.read_text(encoding="utf-8").splitlines():
        segment = parse_segment(line)
        segments.append(
            {
                "start": segment["start"] / 1000,
                "end": segment["end"] / 1000,
                "text": segment["text"].strip(),
                "speaker": None,
                "confidence": None,
                "words": [],
            }
        )

    transcript = {
        "version": "0.1",
        "asset_id": asset["asset_id"],
        "language": language,
        "segments": segments,
    }
    output.write_text(json.dumps(transcript, indent=2), encoding="utf-8")
    text_output.write_text(
        "\n".join(
            f"[{segment['start']:.3f} - {segment['end']:.3f}] {segment['text']}"
            for segment in segments
        ),
        encoding="utf-8",
    )
    raw_output.unlink()
    print(f"Transcribed {asset['file_name']} -> {output}")


def main():
    parser = argparse.ArgumentParser(description="Transcribe inventoried media locally.")
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--language", default="en")
    parser.add_argument("--limit-seconds", type=float)
    parser.add_argument("--asset-id", action="append")
    parser.add_argument("--recover-raw", action="store_true")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    model = args.model.resolve()
    if not model.exists():
        raise SystemExit(f"Whisper model not found: {model}")

    inventory = json.loads(INVENTORY.read_text(encoding="utf-8"))
    assets = [asset for asset in inventory["assets"] if asset["audio"]]
    if args.asset_id:
        assets = [asset for asset in assets if asset["asset_id"] in args.asset_id]
    TRANSCRIPT_DIR.mkdir(parents=True, exist_ok=True)
    for asset in assets:
        transcribe(
            asset,
            model,
            args.language,
            args.limit_seconds,
            args.force,
            args.recover_raw,
        )


if __name__ == "__main__":
    main()
