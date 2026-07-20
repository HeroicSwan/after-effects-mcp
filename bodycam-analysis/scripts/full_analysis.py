import argparse
import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
INVENTORY = ROOT / "analysis" / "inventory" / "media.json"


def run(*arguments):
    subprocess.run([sys.executable, *arguments], cwd=ROOT, check=True)


def main():
    parser = argparse.ArgumentParser(
        description="Inventory, transcribe, and analyze editor-added video choices."
    )
    parser.add_argument("inputs", nargs="*", type=Path)
    parser.add_argument("--force-transcripts", action="store_true")
    args = parser.parse_args()

    run("scripts/inventory.py", *[str(path) for path in args.inputs])
    transcript_command = ["scripts/transcribe.py"]
    if args.force_transcripts:
        transcript_command.append("--force")
    run(*transcript_command)

    inventory = json.loads(INVENTORY.read_text(encoding="utf-8"))
    video_assets = [asset for asset in inventory["assets"] if asset["video"]]
    for asset in video_assets:
        run("scripts/analyze_editorial.py", "--asset-id", asset["asset_id"])

    print(
        f"Full analysis complete: {len(inventory['assets'])} media files, "
        f"{len(video_assets)} editorial video reports."
    )


if __name__ == "__main__":
    main()
