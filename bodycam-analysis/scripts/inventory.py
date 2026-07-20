import argparse
import hashlib
import json
import subprocess
from datetime import datetime, timezone
from fractions import Fraction
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MEDIA_ROOT = ROOT / "reference-data"
OUTPUT = ROOT / "analysis" / "inventory" / "media.json"
MEDIA_EXTENSIONS = {
    ".aac",
    ".avi",
    ".flac",
    ".m4a",
    ".mkv",
    ".mov",
    ".mp3",
    ".mp4",
    ".mxf",
    ".wav",
    ".webm",
}


def number(value, cast=float):
    if value in (None, "", "N/A"):
        return None
    return cast(value)


def frame_rate(value):
    if value in (None, "", "0/0", "N/A"):
        return None
    return float(Fraction(value))


def probe(path):
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_format",
            "-show_streams",
            "-print_format",
            "json",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def build_asset(path):
    try:
        relative_path = path.relative_to(MEDIA_ROOT).as_posix()
        category = Path(relative_path).parts[0]
    except ValueError:
        relative_path = str(path)
        category = "external"
    metadata = probe(path)
    format_data = metadata.get("format", {})
    streams = metadata.get("streams", [])
    video_stream = next(
        (
            stream
            for stream in streams
            if stream.get("codec_type") == "video"
            and stream.get("disposition", {}).get("attached_pic") != 1
        ),
        None,
    )
    audio_streams = [stream for stream in streams if stream.get("codec_type") == "audio"]
    asset_id = hashlib.sha256(relative_path.lower().encode("utf-8")).hexdigest()[:16]

    video = None
    if video_stream:
        video = {
            "codec": video_stream.get("codec_name", "unknown"),
            "width": video_stream["width"],
            "height": video_stream["height"],
            "pixel_format": video_stream.get("pix_fmt"),
            "frame_rate": frame_rate(video_stream.get("avg_frame_rate")),
        }

    audio = []
    for stream in audio_streams:
        audio.append(
            {
                "index": stream["index"],
                "codec": stream.get("codec_name", "unknown"),
                "channels": number(stream.get("channels"), int),
                "sample_rate": number(stream.get("sample_rate"), int),
                "language": stream.get("tags", {}).get("language"),
            }
        )

    stat = path.stat()
    return {
        "asset_id": asset_id,
        "category": category,
        "relative_path": relative_path,
        "file_name": path.name,
        "file_size_bytes": stat.st_size,
        "modified_at": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
        "format_name": format_data.get("format_name", "unknown"),
        "duration_seconds": number(format_data.get("duration")) or 0,
        "bit_rate": number(format_data.get("bit_rate"), int),
        "video": video,
        "audio": audio,
    }


def main():
    parser = argparse.ArgumentParser(description="Inventory reference video and audio files.")
    parser.add_argument("inputs", nargs="*", type=Path)
    args = parser.parse_args()
    if args.inputs:
        media_files = [path.resolve() for path in args.inputs]
        media_root = "explicit-inputs"
    else:
        media_files = sorted(
            path
            for path in MEDIA_ROOT.rglob("*")
            if path.is_file() and path.suffix.lower() in MEDIA_EXTENSIONS
        )
        media_root = str(MEDIA_ROOT)
    assets = [build_asset(path) for path in media_files]
    inventory = {
        "version": "0.1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "media_root": media_root,
        "asset_count": len(assets),
        "assets": assets,
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(inventory, indent=2), encoding="utf-8")
    print(f"Inventoried {len(assets)} media files -> {OUTPUT}")


if __name__ == "__main__":
    main()
