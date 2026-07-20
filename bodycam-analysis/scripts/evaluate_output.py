import argparse
import hashlib
import json
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import cv2

from analyze_editorial import detect_cuts
from inventory import build_asset
from transcribe import DEFAULT_MODEL, TRANSCRIPT_DIR, transcribe


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = ROOT / "config" / "evaluation.default.json"
OUTPUT_ROOT = ROOT / "analysis" / "evaluations"


def run_ffmpeg(path, audio_filter=None, video_filter=None):
    command = ["ffmpeg", "-hide_banner", "-nostats", "-i", str(path)]
    if audio_filter:
        command.extend(["-vn", "-af", audio_filter])
    if video_filter:
        command.extend(["-an", "-vf", video_filter])
    command.extend(["-f", "null", "NUL"])
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode:
        raise SystemExit(result.stderr)
    return result.stderr


def scan_audio(path, config):
    settings = config["audio"]
    output = run_ffmpeg(
        path,
        audio_filter=(
            "ebur128=peak=true,"
            f"silencedetect=noise={settings['silence_db']}dB:"
            f"d={settings['minimum_silence_seconds']}"
        ),
    )
    loudness = re.findall(r"\bI:\s*(-?[\d.]+)\s+LUFS", output)
    peaks = re.findall(r"\bPeak:\s*(-?[\d.]+)\s+dBFS", output)
    starts = [float(value) for value in re.findall(r"silence_start:\s*([\d.]+)", output)]
    ends = [
        (float(end), float(duration))
        for end, duration in re.findall(
            r"silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)",
            output,
        )
    ]
    silences = []
    for index, (end, duration) in enumerate(ends):
        start = starts[index] if index < len(starts) else max(0, end - duration)
        silences.append(
            {"start": round(start, 3), "end": round(end, 3), "duration": round(duration, 3)}
        )
    return {
        "integrated_loudness_lufs": float(loudness[-1]) if loudness else None,
        "true_peak_dbfs": float(peaks[-1]) if peaks else None,
        "silences": silences,
    }


def scan_visual(path, config):
    settings = config["visual"]
    output = run_ffmpeg(
        path,
        video_filter=(
            f"blackdetect=d={settings['black_minimum_seconds']}:pic_th=0.98,"
            f"freezedetect=n=-50dB:d={settings['freeze_minimum_seconds']}"
        ),
    )
    black = [
        {"start": float(start), "end": float(end), "duration": float(duration)}
        for start, end, duration in re.findall(
            r"black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)",
            output,
        )
    ]
    freeze_starts = [float(value) for value in re.findall(r"freeze_start:\s*([\d.]+)", output)]
    freeze_durations = [
        float(value) for value in re.findall(r"freeze_duration:\s*([\d.]+)", output)
    ]
    freeze_ends = [float(value) for value in re.findall(r"freeze_end:\s*([\d.]+)", output)]
    freezes = []
    for index, (duration, end) in enumerate(zip(freeze_durations, freeze_ends)):
        start = freeze_starts[index] if index < len(freeze_starts) else max(0, end - duration)
        freezes.append(
            {"start": round(start, 3), "end": round(end, 3), "duration": round(duration, 3)}
        )
    return {"black_intervals": black, "freeze_intervals": freezes}


def transcript_metrics(transcript, duration):
    segments = transcript.get("segments", []) if transcript else []
    speech_seconds = sum(max(0, segment["end"] - segment["start"]) for segment in segments)
    words = sum(len(segment["text"].split()) for segment in segments)
    return {
        "segment_count": len(segments),
        "first_speech_seconds": segments[0]["start"] if segments else None,
        "speech_coverage_ratio": speech_seconds / duration if duration else 0,
        "words_per_minute_of_runtime": words / (duration / 60) if duration else 0,
    }


def scene_metrics(cuts, duration):
    boundaries = [0] + [cut["time"] for cut in cuts] + [duration]
    lengths = sorted(
        boundaries[index + 1] - boundaries[index] for index in range(len(boundaries) - 1)
    )
    middle = len(lengths) // 2
    median = (
        lengths[middle]
        if len(lengths) % 2
        else (lengths[middle - 1] + lengths[middle]) / 2
    )
    return {
        "total_cuts": len(cuts),
        "cuts_per_minute": len(cuts) / (duration / 60) if duration else 0,
        "hook_cuts_first_20_seconds": sum(cut["time"] <= 20 for cut in cuts),
        "median_scene_seconds": median,
        "longest_scene_seconds": max(lengths),
    }


def score_technical(asset):
    video = asset["video"]
    audio = asset["audio"]
    score = 0
    notes = []
    score += 2 if video else 0
    score += 1 if audio else 0
    if video:
        height = video["height"]
        score += 3 if height >= 1080 else 2 if height >= 720 else 0
        ratio = video["width"] / height
        score += 2 if abs(ratio - (16 / 9)) <= 0.03 else 1
        score += 2 if 23.5 <= (video["frame_rate"] or 0) <= 60.1 else 0
        score += 2 if video["codec"] == "h264" else 1
    if "mp4" in asset["format_name"]:
        score += 1
    if audio and audio[0]["sample_rate"] == 48000:
        score += 2
    elif audio:
        score += 1
    notes.append(
        f"{video['width']}x{video['height']} at {video['frame_rate']:.3f} fps"
        if video
        else "No video stream"
    )
    notes.append(
        f"{audio[0]['codec']} at {audio[0]['sample_rate']} Hz" if audio else "No audio stream"
    )
    return score, notes


def score_audio(audio_scan, duration, config):
    settings = config["audio"]
    loudness = audio_scan["integrated_loudness_lufs"]
    peak = audio_scan["true_peak_dbfs"]
    silences = audio_scan["silences"]
    silence_seconds = sum(item["duration"] for item in silences)
    long_silences = [
        item for item in silences if item["duration"] >= settings["long_silence_seconds"]
    ]
    score = 0
    if loudness is not None:
        if settings["preferred_loudness_lufs_min"] <= loudness <= settings["preferred_loudness_lufs_max"]:
            score += 6
        elif -24 <= loudness <= -10:
            score += 3
    if peak is not None:
        score += 4 if peak <= settings["maximum_true_peak_dbfs"] else 2 if peak <= 0 else 0
    ratio = silence_seconds / duration if duration else 1
    score += 3 if ratio <= 0.05 else 2 if ratio <= 0.1 else 1 if ratio <= 0.2 else 0
    long_rate = len(long_silences) / max(duration / 600, 1)
    score += 2 if not long_silences else 1 if long_rate <= 1 else 0
    notes = [
        f"Integrated loudness: {loudness} LUFS",
        f"True peak: {peak} dBFS",
        f"Detected silence: {ratio:.1%}; long silence intervals: {len(long_silences)}",
    ]
    return score, notes, long_silences, ratio


def score_pacing(metrics, long_silences, duration, config):
    target = config["reference_targets"]["cuts_per_minute"]
    difference = abs(metrics["cuts_per_minute"] - target)
    score = 5 if difference <= 0.35 else 4 if difference <= 0.8 else 2 if difference <= 1.4 else 1
    median = metrics["median_scene_seconds"]
    score += 4 if 8 <= median <= 45 else 3 if 4 <= median <= 90 else 1
    longest = metrics["longest_scene_seconds"]
    score += 3 if longest <= 180 else 2 if longest <= 300 else 0
    long_rate = len(long_silences) / max(duration / 600, 1)
    score += 3 if not long_silences else 2 if long_rate <= 1 else 1 if long_rate <= 3 else 0
    notes = [
        f"{metrics['cuts_per_minute']:.2f} cuts/minute; reference target {target:.2f}",
        f"Median scene {median:.2f}s; longest scene {longest:.2f}s",
        f"{len(long_silences)} silence intervals of at least {config['audio']['long_silence_seconds']}s",
    ]
    return score, notes


def score_opening(metrics, transcript_data, visual_scan, config):
    target = config["reference_targets"]["hook_cuts_first_20_seconds"]
    hook_cuts = metrics["hook_cuts_first_20_seconds"]
    score = 4 if hook_cuts >= target else 3 if hook_cuts == 2 else 1 if hook_cuts == 1 else 0
    first_speech = transcript_data["first_speech_seconds"]
    if first_speech is not None:
        score += 3 if first_speech <= 2 else 2 if first_speech <= 5 else 1 if first_speech <= 10 else 0
    opening_defects = [
        interval
        for interval in visual_scan["black_intervals"]
        if interval["start"] < 20 and interval["duration"] >= 1
    ]
    opening_defects.extend(
        interval for interval in visual_scan["freeze_intervals"] if interval["start"] < 20
    )
    score += 3 if not opening_defects else 1
    notes = [
        f"{hook_cuts} cuts in the first 20 seconds; reference target {target}",
        f"First detected speech: {first_speech}s",
        f"Opening black/freeze defects: {len(opening_defects)}",
    ]
    return score, notes


def make_contact_sheet(path, destination, timestamps):
    capture = cv2.VideoCapture(str(path))
    frames = []
    for timestamp in timestamps:
        capture.set(cv2.CAP_PROP_POS_MSEC, timestamp * 1000)
        ok, frame = capture.read()
        if not ok:
            continue
        height, width = frame.shape[:2]
        resized = cv2.resize(frame, (320, max(1, round(height * 320 / width))))
        cv2.rectangle(resized, (0, 0), (145, 25), (0, 0, 0), -1)
        cv2.putText(
            resized,
            f"{timestamp:.1f}s",
            (7, 18),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.55,
            (255, 255, 255),
            1,
            cv2.LINE_AA,
        )
        frames.append(resized)
    capture.release()
    if not frames:
        return None
    cell_height = max(frame.shape[0] for frame in frames)
    rows = []
    for offset in range(0, len(frames), 4):
        row = frames[offset : offset + 4]
        while len(row) < 4:
            row.append(row[-1].copy())
        row = [cv2.resize(frame, (320, cell_height)) for frame in row]
        rows.append(cv2.hconcat(row))
    cv2.imwrite(str(destination), cv2.vconcat(rows))
    return str(destination)


def load_editorial_review(path, config):
    if not path:
        return None
    review = json.loads(path.read_text(encoding="utf-8"))
    expected = config["editorial_categories"]
    for category, possible in expected.items():
        score = review["categories"][category]["score"]
        if not 0 <= score <= possible:
            raise SystemExit(f"{category} must score between 0 and {possible}.")
    return review


def grade(score):
    if score >= 90:
        return "excellent"
    if score >= 85:
        return "strong"
    if score >= 70:
        return "workable"
    if score >= 55:
        return "weak"
    return "not_publishable"


def write_review_packet(path, transcript, evidence, destination, config):
    opening = [
        segment for segment in (transcript or {}).get("segments", []) if segment["start"] <= 90
    ]
    closing_start = max(0, evidence["duration_seconds"] - 60)
    closing = [
        segment
        for segment in (transcript or {}).get("segments", [])
        if segment["end"] >= closing_start
    ]
    template = {
        "categories": {
            category: {"score": 0, "notes": "", "timestamps": []}
            for category in config["editorial_categories"]
        },
        "publish_gates": {
            gate: {"status": "pending", "notes": ""} for gate in config["publish_gates"]
        },
    }
    lines = [
        "# Output Editorial Review Packet",
        "",
        f"- Render: `{path}`",
        f"- Duration: {evidence['duration_seconds']:.2f}s",
        f"- Opening contact sheet: `{evidence['review_assets']['opening_contact_sheet']}`",
        f"- Overview contact sheet: `{evidence['review_assets']['overview_contact_sheet']}`",
        "",
        "## Measured evidence",
        "",
        f"- Cuts/minute: {evidence['scenes']['cuts_per_minute']:.2f}",
        f"- Cuts in first 20 seconds: {evidence['scenes']['hook_cuts_first_20_seconds']}",
        f"- Loudness: {evidence['audio']['integrated_loudness_lufs']} LUFS",
        f"- True peak: {evidence['audio']['true_peak_dbfs']} dBFS",
        f"- Long silence intervals: {len(evidence['audio']['long_silences'])}",
        f"- Black intervals: {len(evidence['visual']['black_intervals'])}",
        f"- Freeze intervals: {len(evidence['visual']['freeze_intervals'])}",
        "",
        "## Opening transcript (first 90 seconds)",
        "",
    ]
    lines.extend(
        f"- [{segment['start']:.2f}-{segment['end']:.2f}] {segment['text']}"
        for segment in opening
    )
    lines.extend(["", "## Closing transcript (last 60 seconds)", ""])
    lines.extend(
        f"- [{segment['start']:.2f}-{segment['end']:.2f}] {segment['text']}"
        for segment in closing
    )
    lines.extend(
        [
            "",
            "## Required editorial review",
            "",
            "- Hook quality (10): immediate curiosity, stakes, specificity, and visual payoff.",
            "- Story clarity (15): understandable setup, escalation, context, and outcome.",
            "- Editorial polish (10): purposeful additions, clean timing, readable graphics, and no distracting mistakes.",
            "- Context and integrity (10): documentary framing, no invented facts, and responsible treatment of violence.",
            "",
            "Save the completed review as JSON and pass it with `--review`:",
            "",
            "```json",
            json.dumps(template, indent=2),
            "```",
        ]
    )
    destination.write_text("\n".join(lines), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description="Score a rendered body-cam edit for YouTube readiness.")
    parser.add_argument("video", type=Path)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--transcript", type=Path)
    parser.add_argument("--skip-transcription", action="store_true")
    parser.add_argument("--review", type=Path)
    args = parser.parse_args()

    path = args.video.resolve()
    config = json.loads(args.config.read_text(encoding="utf-8"))
    asset = build_asset(path)
    stat = path.stat()
    signature = f"{str(path).lower()}|{stat.st_size}|{stat.st_mtime_ns}"
    asset["asset_id"] = hashlib.sha256(signature.encode("utf-8")).hexdigest()[:16]
    evaluation_id = f"{asset['asset_id']}-{datetime.now().strftime('%Y%m%d%H%M%S')}"
    output_dir = OUTPUT_ROOT / evaluation_id
    output_dir.mkdir(parents=True, exist_ok=True)

    transcript = None
    if args.transcript:
        transcript = json.loads(args.transcript.read_text(encoding="utf-8"))
    elif asset["audio"] and not args.skip_transcription:
        TRANSCRIPT_DIR.mkdir(parents=True, exist_ok=True)
        transcribe(asset, DEFAULT_MODEL, "en", None, False, False)
        transcript = json.loads(
            (TRANSCRIPT_DIR / f"{asset['asset_id']}.json").read_text(encoding="utf-8")
        )

    visual_settings = config["visual"]
    cuts = detect_cuts(
        path,
        visual_settings["adaptive_threshold"],
        visual_settings["minimum_content"],
        visual_settings["minimum_scene_seconds"],
    )
    audio_scan = scan_audio(path, config) if asset["audio"] else {
        "integrated_loudness_lufs": None,
        "true_peak_dbfs": None,
        "silences": [],
    }
    visual_scan = scan_visual(path, config)
    duration = asset["duration_seconds"]
    scenes = scene_metrics(cuts, duration)
    transcript_data = transcript_metrics(transcript, duration)

    opening_times = [time for time in [0, 3, 7, 12, 20, 30, 45, 60] if time < duration]
    overview_times = [duration * index / 12 for index in range(12)] if duration else []
    opening_sheet = make_contact_sheet(path, output_dir / "opening-contact-sheet.jpg", opening_times)
    overview_sheet = make_contact_sheet(path, output_dir / "overview-contact-sheet.jpg", overview_times)

    technical_score, technical_notes = score_technical(asset)
    if asset["audio"]:
        audio_score, audio_notes, long_silences, silence_ratio = score_audio(
            audio_scan, duration, config
        )
    else:
        audio_score, audio_notes, long_silences, silence_ratio = 0, ["No audio stream"], [], 1
    pacing_score, pacing_notes = score_pacing(scenes, long_silences, duration, config)
    opening_score, opening_notes = score_opening(
        scenes, transcript_data, visual_scan, config
    )
    automated_score = technical_score + audio_score + pacing_score + opening_score

    categories = [
        {"id": "technical_delivery", "score": technical_score, "possible": 15, "status": "measured", "notes": technical_notes},
        {"id": "audio_quality", "score": audio_score, "possible": 15, "status": "measured", "notes": audio_notes},
        {"id": "pacing_and_dead_time", "score": pacing_score, "possible": 15, "status": "measured", "notes": pacing_notes},
        {"id": "opening_structure", "score": opening_score, "possible": 10, "status": "measured", "notes": opening_notes},
    ]

    review = load_editorial_review(args.review, config)
    editorial_score = None
    gates = [
        {"id": gate, "status": "pending", "notes": "Editorial review required."}
        for gate in config["publish_gates"]
    ]
    if review:
        editorial_score = 0
        for category, possible in config["editorial_categories"].items():
            item = review["categories"][category]
            editorial_score += item["score"]
            categories.append(
                {
                    "id": category,
                    "score": item["score"],
                    "possible": possible,
                    "status": "reviewed",
                    "notes": [item["notes"]],
                }
            )
        gates = [
            {
                "id": gate,
                "status": review["publish_gates"][gate]["status"],
                "notes": review["publish_gates"][gate]["notes"],
            }
            for gate in config["publish_gates"]
        ]
    else:
        categories.extend(
            {
                "id": category,
                "score": None,
                "possible": possible,
                "status": "pending",
                "notes": ["Requires AI editorial review of the render, transcript, and contact sheets."],
            }
            for category, possible in config["editorial_categories"].items()
        )

    findings = []
    if not asset["video"]:
        findings.append(
            {"severity": "critical", "category": "technical_delivery", "message": "No video stream.", "timestamp": None, "recommendation": "Render a valid video stream."}
        )
    if not asset["audio"]:
        findings.append(
            {"severity": "critical", "category": "audio_quality", "message": "No audio stream.", "timestamp": None, "recommendation": "Render narration and source audio."}
        )
    if audio_scan["true_peak_dbfs"] is not None and audio_scan["true_peak_dbfs"] > 0:
        findings.append(
            {"severity": "high", "category": "audio_quality", "message": "Audio exceeds 0 dBFS.", "timestamp": None, "recommendation": "Lower the master or add a true-peak limiter."}
        )
    for interval in long_silences:
        findings.append(
            {"severity": "medium", "category": "pacing_and_dead_time", "message": f"{interval['duration']:.2f}s of detected silence.", "timestamp": interval["start"], "recommendation": "Confirm this pause is intentional; otherwise tighten the edit or restore an audio bed."}
        )
    for interval in visual_scan["black_intervals"]:
        if interval["duration"] >= 1:
            findings.append(
                {"severity": "high", "category": "technical_delivery", "message": f"{interval['duration']:.2f}s black interval.", "timestamp": interval["start"], "recommendation": "Remove the render gap or confirm it is an intentional transition."}
            )
    for interval in visual_scan["freeze_intervals"]:
        findings.append(
            {"severity": "medium", "category": "editorial_polish", "message": f"{interval['duration']:.2f}s frozen image.", "timestamp": interval["start"], "recommendation": "Confirm it is an intentional freeze frame and support it with narration or graphics."}
        )

    final_score = automated_score + editorial_score if editorial_score is not None else None
    blocking = [finding["message"] for finding in findings if finding["severity"] == "critical"]
    blocking.extend(
        f"{gate['id']}: {gate['notes']}" for gate in gates if gate["status"] == "fail"
    )
    if final_score is None:
        status = "pending_editorial_review"
    elif blocking:
        status = "blocked"
    elif any(gate["status"] == "pending" for gate in gates):
        status = "pending_publish_gates"
    elif final_score >= config["ready_score"]:
        status = "ready"
    elif final_score >= config["revise_score"]:
        status = "revise"
    else:
        status = "not_ready"

    evidence = {
        "path": str(path),
        "duration_seconds": duration,
        "media": asset,
        "audio": {
            **audio_scan,
            "silence_ratio": silence_ratio,
            "long_silences": long_silences,
        },
        "visual": visual_scan,
        "scenes": scenes,
        "transcript": transcript_data,
        "review_assets": {
            "opening_contact_sheet": opening_sheet,
            "overview_contact_sheet": overview_sheet,
            "transcript": str(args.transcript.resolve()) if args.transcript else (
                str(TRANSCRIPT_DIR / f"{asset['asset_id']}.json") if transcript else None
            ),
        },
    }
    evaluation = {
        "version": "0.1",
        "evaluation_id": evaluation_id,
        "asset_id": asset["asset_id"],
        "created_at": datetime.now(timezone.utc).isoformat(),
        "score": {
            "automated_earned": automated_score,
            "automated_possible": 55,
            "editorial_earned": editorial_score,
            "editorial_possible": 45,
            "final": final_score,
        },
        "decision": {
            "status": status,
            "grade": grade(final_score) if final_score is not None else None,
            "blocking_reasons": blocking,
        },
        "categories": categories,
        "evidence": evidence,
        "findings": findings,
        "publish_gates": gates,
    }
    output = output_dir / "output-evaluation.json"
    output.write_text(json.dumps(evaluation, indent=2), encoding="utf-8")
    write_review_packet(path, transcript, evidence, output_dir / "REVIEW_PACKET.md", config)
    print(
        f"Automated score: {automated_score}/55; "
        f"final: {final_score if final_score is not None else 'pending editorial review'}"
    )
    print(f"Evaluation -> {output}")


if __name__ == "__main__":
    main()
