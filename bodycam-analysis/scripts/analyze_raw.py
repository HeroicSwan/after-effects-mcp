import argparse
import hashlib
import json
import re
import subprocess
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np
from scipy.io import wavfile

from analyze_editorial import detect_cuts, detect_silences
from inventory import probe


ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ROOT.parent
VIDEO_EXTENSIONS = {".avi", ".mkv", ".mov", ".mp4", ".mxf", ".webm"}
COMMAND_PATTERNS = {
    "command_or_compliance": re.compile(
        r"\b(show me your hands|hands up|hands behind|do not move|don't move|"
        r"get down|step out|drop it|put it down|stop running|on the ground)\b",
        re.IGNORECASE,
    ),
    "possible_emergency": re.compile(
        r"\b(shots? fired|gun|weapon|taser|ambulance|bleeding|not breathing|"
        r"officer down|send medical)\b",
        re.IGNORECASE,
    ),
    "detention_or_outcome": re.compile(
        r"\b(under arrest|being detained|in custody|handcuff|read you your rights)\b",
        re.IGNORECASE,
    ),
}


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def relative_to_job(path, job_dir):
    try:
        return path.relative_to(job_dir).as_posix()
    except ValueError:
        return str(path)


def resolve_job(value):
    path = value.resolve()
    return (path, path.parent) if path.is_file() else (path / "job.json", path)


def asset_id(path):
    value = path.resolve().as_posix().lower()
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]


def resolve_source(job, job_dir):
    candidates = job["inputs"]["bodycam"]
    primary = next((item for item in candidates if item["role"] == "primary"), None)
    if primary:
        path = Path(primary["path"])
        path = path if path.is_absolute() else job_dir / path
        return primary, path.resolve()

    dropped = sorted(
        path
        for path in (job_dir / "inputs" / "bodycam").iterdir()
        if path.is_file() and path.suffix.lower() in VIDEO_EXTENSIONS
    )
    if len(dropped) != 1:
        raise SystemExit(
            "Add exactly one primary body-cam video to job.json or inputs/bodycam/."
        )
    path = dropped[0].resolve()
    primary = {
        "asset_id": asset_id(path),
        "path": relative_to_job(path, job_dir),
        "role": "primary",
    }
    candidates.append(primary)
    return primary, path


def media_facts(path):
    data = probe(path)
    format_data = data.get("format", {})
    streams = data.get("streams", [])
    video = next(
        (
            stream
            for stream in streams
            if stream.get("codec_type") == "video"
            and stream.get("disposition", {}).get("attached_pic") != 1
        ),
        None,
    )
    if not video:
        raise SystemExit("The primary body-cam input has no video stream.")
    return {
        "duration": float(format_data.get("duration") or 0),
        "width": int(video["width"]),
        "height": int(video["height"]),
        "has_audio": any(stream.get("codec_type") == "audio" for stream in streams),
    }


def normalize_transcript(raw, source, source_asset_id):
    if raw.get("version") and raw.get("asset_id"):
        return raw
    words = raw.get("words") or []
    segments = []
    for segment in raw.get("segments") or []:
        segment_words = [
            word
            for word in words
            if float(word["start"]) < float(segment["end"])
            and float(word["end"]) > float(segment["start"])
        ]
        probabilities = [
            float(word.get("probability") or 0)
            for word in segment_words
            if word.get("probability") is not None
        ]
        confidence = sum(probabilities) / len(probabilities) if probabilities else None
        segments.append(
            {
                "start": float(segment["start"]),
                "end": float(segment["end"]),
                "text": (segment.get("text") or "").strip(),
                "speaker": None,
                "confidence": round(confidence, 3) if confidence is not None else None,
                "words": [
                    {
                        "start": float(word["start"]),
                        "end": float(word["end"]),
                        "text": (word.get("word") or "").strip(),
                        "confidence": float(word.get("probability") or 0),
                    }
                    for word in segment_words
                ],
            }
        )
    return {
        "version": "0.1",
        "asset_id": source_asset_id,
        "language": raw.get("language") or "unknown",
        "source": str(source),
        "segments": segments,
    }


def load_or_transcribe(
    source,
    source_asset_id,
    output,
    supplied,
    model,
    language,
    force,
    skip,
):
    if supplied:
        raw = json.loads(supplied.read_text(encoding="utf-8"))
    elif output.exists() and not force:
        raw = json.loads(output.read_text(encoding="utf-8"))
    elif skip:
        return None
    else:
        script = REPO_ROOT / "scripts" / "transcribe_video.py"
        command = [
            sys.executable,
            str(script),
            "--input",
            str(source),
            "--out",
            str(output),
            "--model",
            model,
        ]
        if language:
            command.extend(["--language", language])
        subprocess.run(command, cwd=REPO_ROOT, check=True, capture_output=True, text=True)
        raw = json.loads(output.read_text(encoding="utf-8"))
    transcript = normalize_transcript(raw, source, source_asset_id)
    output.write_text(json.dumps(transcript, indent=2), encoding="utf-8")
    return transcript


def event(start, end, event_type, description, evidence, confidence, review, source):
    return {
        "start": round(max(0, start), 3),
        "end": round(max(start, end), 3),
        "event_type": event_type,
        "description": description,
        "evidence": evidence,
        "confidence": round(confidence, 3),
        "review_required": review,
        "source": source,
    }


def transcript_events(transcript, review_below):
    events = []
    for segment in transcript.get("segments", []) if transcript else []:
        text = segment["text"].strip()
        if not text:
            continue
        confidence = segment.get("confidence")
        measured_confidence = confidence if confidence is not None else 0.6
        events.append(
            event(
                segment["start"],
                segment["end"],
                "speech",
                text,
                [f'transcript: "{text[:240]}"'],
                measured_confidence,
                confidence is None or confidence < review_below,
                "transcript",
            )
        )
        for cue_type, pattern in COMMAND_PATTERNS.items():
            match = pattern.search(text)
            if match:
                events.append(
                    event(
                        segment["start"],
                        segment["end"],
                        "action",
                        f"Language cue: {cue_type.replace('_', ' ')}",
                        [f'matched phrase: "{match.group(0)}"', f'transcript: "{text[:240]}"'],
                        min(0.8, measured_confidence),
                        True,
                        "transcript_keyword",
                    )
                )
    return events


def merge_ranges(items, maximum_gap=0.6):
    merged = []
    groups = {}
    for item in items:
        key = (item["event_type"], item["description"], item["source"])
        groups.setdefault(key, []).append(item)
    for group in groups.values():
        group_merged = []
        for item in sorted(group, key=lambda value: value["start"]):
            if group_merged and item["start"] <= group_merged[-1]["end"] + maximum_gap:
                group_merged[-1]["end"] = item["end"]
                group_merged[-1]["confidence"] = min(
                    group_merged[-1]["confidence"], item["confidence"]
                )
                group_merged[-1]["evidence"].extend(item["evidence"])
            else:
                group_merged.append(item.copy())
        merged.extend(group_merged)
    merged.sort(key=lambda value: (value["start"], value["end"], value["event_type"]))
    for item in merged:
        item["evidence"] = item["evidence"][:12]
    return merged


def audio_energy_events(path, work_dir, duration):
    wav_path = work_dir / "analysis-audio.wav"
    if not wav_path.exists():
        subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-v",
                "error",
                "-i",
                str(path),
                "-vn",
                "-ac",
                "1",
                "-ar",
                "16000",
                "-c:a",
                "pcm_s16le",
                "-y",
                str(wav_path),
            ],
            check=True,
        )
    sample_rate, samples = wavfile.read(wav_path, mmap=True)
    source_dtype = samples.dtype
    samples = samples.astype(np.float32)
    if np.issubdtype(source_dtype, np.integer):
        samples /= max(float(np.iinfo(source_dtype).max), 1)
    window = sample_rate
    levels = []
    for index in range(0, len(samples), window):
        clip = samples[index : index + window]
        if not len(clip):
            continue
        rms = float(np.sqrt(np.mean(clip**2) + 1e-12))
        levels.append((index / sample_rate, 20 * np.log10(rms + 1e-12)))
    active = [level for _, level in levels if level > -55]
    threshold = max(-40, float(np.median(active)) + 8) if active else -18
    candidates = [
        event(
            start,
            min(duration, start + 1),
            "sound",
            "Elevated audio energy",
            [f"1-second RMS: {level:.1f} dBFS", f"adaptive threshold: {threshold:.1f} dBFS"],
            0.8,
            True,
            "audio_energy",
        )
        for start, level in levels
        if level >= threshold
    ]
    return merge_ranges(candidates, maximum_gap=1.05)


def visual_events(path, duration, samples_per_second, review_below, detect_faces):
    interval = max(0.5, 1 / max(samples_per_second, 0.01))
    capture = cv2.VideoCapture(str(path))
    face_detector = None
    if detect_faces:
        cascade_path = Path(cv2.data.haarcascades) / "haarcascade_frontalface_default.xml"
        face_detector = cv2.CascadeClassifier(str(cascade_path))
    previous_gray = None
    candidates = []
    sample_count = 0
    time = 0.0
    while time < duration:
        capture.set(cv2.CAP_PROP_POS_MSEC, time * 1000)
        success, frame = capture.read()
        if not success:
            time += interval
            continue
        sample_count += 1
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        brightness = float(np.mean(gray))
        blur = float(cv2.Laplacian(gray, cv2.CV_64F).var())
        small = cv2.resize(gray, (320, max(1, round(gray.shape[0] * 320 / gray.shape[1]))))
        motion = (
            float(np.mean(cv2.absdiff(small, previous_gray)))
            if previous_gray is not None and previous_gray.shape == small.shape
            else 0
        )
        previous_gray = small
        end = min(duration, time + interval)
        metrics = f"brightness={brightness:.1f}, blur={blur:.1f}, sampled_motion={motion:.1f}"
        if brightness < 35:
            candidates.append(event(time, end, "quality", "Low-light footage", [metrics], 0.9, False, "visual_sample"))
        if brightness > 220:
            candidates.append(event(time, end, "quality", "Possibly overexposed footage", [metrics], 0.85, True, "visual_sample"))
        if blur < 35:
            candidates.append(event(time, end, "quality", "Low-detail or blurred footage", [metrics], 0.78, True, "visual_sample"))
        if motion > 24:
            candidates.append(event(time, end, "action", "Elevated camera or subject motion", [metrics], 0.72, True, "visual_sample"))

        faces = []
        if face_detector is not None:
            scaled = cv2.resize(gray, None, fx=0.5, fy=0.5)
            faces = face_detector.detectMultiScale(
                scaled,
                scaleFactor=1.15,
                minNeighbors=5,
                minSize=(24, 24),
            )
        if len(faces):
            confidence = 0.7
            candidates.append(
                event(
                    time,
                    end,
                    "privacy",
                    "Possible visible face; redaction review candidate",
                    [f"OpenCV face candidates: {len(faces)}", metrics],
                    confidence,
                    confidence < review_below,
                    "face_detector",
                )
            )
        time += interval
    capture.release()
    return merge_ranges(candidates, maximum_gap=interval * 1.1), sample_count


def save_evidence_frames(source, events, evidence_dir, limit=120):
    candidates = [
        item
        for item in events
        if item["event_type"] in {"privacy", "quality", "action"}
        and item["source"] in {"face_detector", "visual_sample"}
    ][:limit]
    if not candidates:
        return
    capture = cv2.VideoCapture(str(source))
    for index, item in enumerate(candidates):
        capture.set(cv2.CAP_PROP_POS_MSEC, item["start"] * 1000)
        success, frame = capture.read()
        if not success:
            continue
        width = 640
        frame = cv2.resize(frame, (width, round(frame.shape[0] * width / frame.shape[1])))
        destination = evidence_dir / f"{index:04d}-{item['start']:010.3f}.jpg"
        cv2.imwrite(str(destination), frame)
        item["evidence"].append(f"frame: {destination.name}")
    capture.release()


def coverage(events, event_type, duration):
    ranges = merge_ranges(
        [
            {
                **item,
                "description": event_type,
                "source": event_type,
            }
            for item in events
            if item["event_type"] == event_type
        ],
        maximum_gap=0,
    )
    return (
        sum(max(0, item["end"] - item["start"]) for item in ranges) / duration
        if duration
        else 0
    )


def main():
    parser = argparse.ArgumentParser(description="Build an evidence-first raw body-cam timeline.")
    parser.add_argument("job", type=Path)
    parser.add_argument("--transcript", type=Path)
    parser.add_argument("--model", default="base")
    parser.add_argument("--language", default="en")
    parser.add_argument("--skip-transcription", action="store_true")
    parser.add_argument("--force-transcript", action="store_true")
    args = parser.parse_args()

    job_path, job_dir = resolve_job(args.job)
    job = json.loads(job_path.read_text(encoding="utf-8"))
    primary, source = resolve_source(job, job_dir)
    if not source.is_file():
        raise SystemExit(f"Primary body-cam video not found: {source}")

    config_path = Path(job["analysis"]["config"])
    config_path = config_path if config_path.is_absolute() else job_dir / config_path
    config = json.loads(config_path.resolve().read_text(encoding="utf-8"))
    facts = media_facts(source)
    analysis_dir = job_dir / "analysis"
    evidence_dir = analysis_dir / "evidence"
    work_dir = job_dir / "work"
    analysis_dir.mkdir(exist_ok=True)
    evidence_dir.mkdir(exist_ok=True)
    work_dir.mkdir(exist_ok=True)

    job["status"] = "analyzing"
    job["analysis"]["state"] = "running"
    job["updated_at"] = timestamp()
    job_path.write_text(json.dumps(job, indent=2), encoding="utf-8")

    transcript_path = analysis_dir / "transcript.json"
    transcript = (
        load_or_transcribe(
            source,
            primary["asset_id"],
            transcript_path,
            args.transcript.resolve() if args.transcript else None,
            args.model,
            args.language,
            args.force_transcript,
            args.skip_transcription or not facts["has_audio"],
        )
        if facts["has_audio"]
        else None
    )
    confidence = config["confidence"]
    processing = config["processing"]
    events = transcript_events(transcript, confidence["transcript_review_below"])

    cuts = detect_cuts(source, 3.2, 20, 0.75)
    events.extend(
        event(
            max(0, cut["time"] - 0.1),
            min(facts["duration"], cut["time"] + 0.1),
            "scene",
            "Abrupt visual discontinuity detected",
            [f"adaptive scene boundary at {cut['time']:.3f}s"],
            0.75,
            True,
            "adaptive_scene_detection",
        )
        for cut in cuts
    )

    silences = []
    if facts["has_audio"] and processing["detect_silence"]:
        silences = detect_silences(source, -35, 0.8)
        events.extend(
            event(
                silence["start"],
                silence["end"],
                "sound",
                "Dead-silence interval",
                [f"silencedetect duration: {silence['duration']:.3f}s", "threshold: -35 dB"],
                0.98,
                silence["duration"] >= 5,
                "ffmpeg_silencedetect",
            )
            for silence in silences
        )
        events.extend(audio_energy_events(source, work_dir, facts["duration"]))

    visual, sample_count = visual_events(
        source,
        facts["duration"],
        processing["base_visual_samples_per_second"],
        confidence["redaction_review_below"],
        processing["detect_faces"],
    )
    events.extend(visual)
    events.sort(key=lambda item: (item["start"], item["end"], item["event_type"]))
    for index, item in enumerate(events, start=1):
        item["event_id"] = f"evt-{index:06d}"
    save_evidence_frames(source, events, evidence_dir)

    counts = Counter(item["event_type"] for item in events)
    review_reasons = []
    if transcript is None:
        review_reasons.append("No transcript was generated; speech content is not represented.")
    if counts["privacy"]:
        review_reasons.append(f"{counts['privacy']} privacy candidate(s) require confirmation.")
    if counts["action"]:
        review_reasons.append(f"{counts['action']} action or elevated-motion candidate(s) require interpretation.")
    review_reasons.append("Timeline approval is required before edit planning or After Effects execution.")

    timeline = {
        "version": "0.2",
        "job_id": job["job_id"],
        "asset_id": primary["asset_id"],
        "source_path": str(source),
        "generated_at": timestamp(),
        "duration_seconds": facts["duration"],
        "analyzer": {
            "name": "bodycam-raw-timeline",
            "mode": "deterministic-evidence-first",
            "visual_samples": sample_count,
            "limitations": [
                "Face detection produces review candidates, not identity findings.",
                "Elevated motion and audio energy do not prove a specific action.",
                "License plates, weapons, violence, charges, and outcomes are not inferred by this pass.",
                "Transcript speakers are not identified or separated from radio traffic.",
            ],
        },
        "summary": {
            "event_count": len(events),
            "event_counts": dict(sorted(counts.items())),
            "speech_coverage_ratio": round(coverage(events, "speech", facts["duration"]), 4),
            "silence_duration_seconds": round(
                sum(item["duration"] for item in silences), 3
            ),
            "visual_discontinuities": len(cuts),
            "review_required_count": sum(item["review_required"] for item in events),
        },
        "events": events,
        "review": {
            "required": True,
            "status": "pending",
            "reasons": review_reasons,
            "edit_build_allowed": False,
        },
    }
    timeline_path = analysis_dir / "raw-timeline.json"
    timeline_path.write_text(json.dumps(timeline, indent=2), encoding="utf-8")

    job["status"] = "timeline_ready"
    job["analysis"] = {
        **job["analysis"],
        "state": "complete",
        "transcript": relative_to_job(transcript_path, job_dir) if transcript else None,
        "raw_timeline": relative_to_job(timeline_path, job_dir),
        "analyzed_at": timestamp(),
    }
    job["review"]["timeline"]["status"] = "pending"
    job["review"]["edit_build_allowed"] = False
    job["updated_at"] = timestamp()
    job_path.write_text(json.dumps(job, indent=2), encoding="utf-8")
    print(f"Raw body-cam timeline -> {timeline_path}")
    print(f"Events: {len(events)}; review required: {timeline['summary']['review_required_count']}")
    print("Edit build remains locked until timeline review is approved.")


if __name__ == "__main__":
    main()
