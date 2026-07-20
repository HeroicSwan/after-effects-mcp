import argparse
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_JOBS_ROOT = ROOT / "jobs"
JOB_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{1,63}$")


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def asset_id(path):
    value = path.resolve().as_posix().lower()
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]


def main():
    parser = argparse.ArgumentParser(description="Create a standardized body-cam editing job.")
    parser.add_argument("job_id")
    parser.add_argument("--title")
    parser.add_argument("--video", type=Path)
    parser.add_argument("--jobs-root", type=Path, default=DEFAULT_JOBS_ROOT)
    args = parser.parse_args()

    if not JOB_ID_PATTERN.fullmatch(args.job_id):
        raise SystemExit("job_id must use 2-64 lowercase letters, numbers, or hyphens.")
    if args.video and not args.video.is_file():
        raise SystemExit(f"Video not found: {args.video}")

    job_dir = args.jobs_root.resolve() / args.job_id
    if job_dir.exists():
        raise SystemExit(f"Job already exists: {job_dir}")

    for relative in [
        "inputs/bodycam",
        "inputs/narration",
        "inputs/case-info",
        "analysis/evidence",
        "edit",
        "renders",
        "review",
        "work",
        "logs",
    ]:
        (job_dir / relative).mkdir(parents=True)

    now = timestamp()
    bodycam = []
    if args.video:
        video = args.video.resolve()
        bodycam.append(
            {
                "asset_id": asset_id(video),
                "path": str(video),
                "role": "primary",
            }
        )
    job = {
        "$schema": "../../schemas/bodycam-job.schema.json",
        "version": "0.1",
        "job_id": args.job_id,
        "title": args.title or args.job_id.replace("-", " ").title(),
        "created_at": now,
        "updated_at": now,
        "status": "created",
        "inputs": {
            "bodycam": bodycam,
            "narration": [],
            "case_info": [],
        },
        "target": {
            "platform": "youtube",
            "width": 1920,
            "height": 1080,
            "frame_rate": 30,
            "duration_target_seconds": None,
        },
        "analysis": {
            "state": "not_started",
            "config": "../../config/analysis.default.json",
            "transcript": None,
            "raw_timeline": None,
        },
        "review": {
            "timeline": {
                "status": "pending",
                "reviewer": None,
                "reviewed_at": None,
                "notes": [],
            },
            "edit_build_allowed": False,
        },
    }
    destination = job_dir / "job.json"
    destination.write_text(json.dumps(job, indent=2), encoding="utf-8")
    print(f"Body-cam job created -> {destination}")


if __name__ == "__main__":
    main()
