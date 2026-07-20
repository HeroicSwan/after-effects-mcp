import argparse
import json
import math
import re
import subprocess
from collections import Counter
from pathlib import Path

import cv2
import numpy as np
from scipy.fft import dct
from scipy.io import wavfile
from scenedetect import AdaptiveDetector, SceneManager, open_video
from sklearn.cluster import KMeans
from sklearn.preprocessing import StandardScaler


ROOT = Path(__file__).resolve().parents[1]
INVENTORY = ROOT / "analysis" / "inventory" / "media.json"
TRANSCRIPT_DIR = ROOT / "analysis" / "transcripts"
OUTPUT_ROOT = ROOT / "analysis" / "editorial"
SILENCE_START_PATTERN = re.compile(r"silence_start:\s*([\d.]+)")
SILENCE_END_PATTERN = re.compile(r"silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)")


def run(command):
    return subprocess.run(
        command,
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
        errors="replace",
    )


def detect_cuts(path, adaptive_threshold, minimum_content, minimum_scene_seconds):
    video = open_video(str(path))
    manager = SceneManager()
    manager.auto_downscale = False
    manager.downscale = max(1, round(video.frame_size[0] / 320))
    manager.add_detector(
        AdaptiveDetector(
            adaptive_threshold=adaptive_threshold,
            min_scene_len=minimum_scene_seconds,
            min_content_val=minimum_content,
        )
    )
    manager.detect_scenes(video=video, show_progress=False)
    scenes = manager.get_scene_list(start_in_scene=True)
    return [
        {
            "time": round(scene[0].seconds, 3),
            "method": "adaptive_hsv",
        }
        for scene in scenes[1:]
    ]


def detect_silences(path, noise_db, minimum_duration):
    result = run(
        [
            "ffmpeg",
            "-hide_banner",
            "-v",
            "info",
            "-i",
            str(path),
            "-vn",
            "-af",
            f"silencedetect=noise={noise_db}dB:d={minimum_duration}",
            "-f",
            "null",
            "NUL",
        ]
    )
    silences = []
    current_start = None
    for line in result.stderr.splitlines():
        start_match = SILENCE_START_PATTERN.search(line)
        if start_match:
            current_start = float(start_match.group(1))
        end_match = SILENCE_END_PATTERN.search(line)
        if end_match:
            end = float(end_match.group(1))
            duration = float(end_match.group(2))
            start = current_start if current_start is not None else end - duration
            silences.append({"start": start, "end": end, "duration": duration})
            current_start = None
    return silences


def extract_audio(path, destination):
    if destination.exists():
        return
    run(
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
            str(destination),
        ]
    )


def mel_filterbank(sample_rate=16000, fft_size=512, mel_count=26):
    low_mel = 2595 * math.log10(1)
    high_mel = 2595 * math.log10(1 + (sample_rate / 2) / 700)
    mel_points = np.linspace(low_mel, high_mel, mel_count + 2)
    hz_points = 700 * (10 ** (mel_points / 2595) - 1)
    bins = np.floor((fft_size + 1) * hz_points / sample_rate).astype(int)
    filters = np.zeros((mel_count, fft_size // 2 + 1))
    for index in range(1, mel_count + 1):
        left, center, right = bins[index - 1 : index + 2]
        if center > left:
            filters[index - 1, left:center] = (
                np.arange(left, center) - left
            ) / (center - left)
        if right > center:
            filters[index - 1, center:right] = (
                right - np.arange(center, right)
            ) / (right - center)
    return filters


def audio_features(samples, sample_rate, start, end, filters):
    clip = samples[int(start * sample_rate) : int(end * sample_rate)].astype(np.float32)
    if len(clip) < 400:
        clip = np.pad(clip, (0, 400 - len(clip)))
    if len(clip) > sample_rate * 12:
        midpoint = len(clip) // 2
        clip = clip[midpoint - sample_rate * 6 : midpoint + sample_rate * 6]
    clip /= max(np.max(np.abs(clip)), 1)
    frame_length, hop = 400, 160
    frame_count = max(1, 1 + (len(clip) - frame_length) // hop)
    indices = np.arange(frame_length)[None, :] + hop * np.arange(frame_count)[:, None]
    frames = clip[indices] * np.hamming(frame_length)
    spectrum = np.abs(np.fft.rfft(frames, n=512)) ** 2
    mel_energy = np.maximum(spectrum @ filters.T, 1e-10)
    coefficients = dct(np.log(mel_energy), type=2, axis=1, norm="ortho")[:, :13]
    rms = np.sqrt(np.mean(frames**2, axis=1) + 1e-10)
    zcr = np.mean(np.diff(np.signbit(frames), axis=1), axis=1)
    return np.concatenate(
        [
            coefficients.mean(axis=0),
            coefficients.std(axis=0),
            [np.log(rms.mean() + 1e-10), rms.std(), zcr.mean(), zcr.std()],
        ]
    )


def classify_speech(path, transcript, cache_dir, anchor_end):
    wav_path = cache_dir / "analysis-audio.wav"
    extract_audio(path, wav_path)
    sample_rate, samples = wavfile.read(wav_path, mmap=True)
    filters = mel_filterbank(sample_rate=sample_rate)
    segments = [
        segment
        for segment in transcript["segments"]
        if segment["end"] > segment["start"] and segment["text"].strip()
    ]
    features = np.vstack(
        [
            audio_features(samples, sample_rate, segment["start"], segment["end"], filters)
            for segment in segments
        ]
    )
    scaled = StandardScaler().fit_transform(features)
    cluster_count = min(5, max(2, len(segments) // 35))
    model = KMeans(n_clusters=cluster_count, random_state=17, n_init=20).fit(scaled)
    distances = model.transform(scaled)
    anchor_indices = [
        index
        for index, segment in enumerate(segments)
        if segment["start"] < anchor_end and len(segment["text"].split()) >= 4
    ]
    narrator_cluster = Counter(model.labels_[anchor_indices]).most_common(1)[0][0]
    anchor_centroid = scaled[anchor_indices].mean(axis=0)
    anchor_distances = np.linalg.norm(scaled[anchor_indices] - anchor_centroid, axis=1)
    narrator_scale = max(float(np.percentile(anchor_distances, 90)) * 3, 1)

    classified = []
    for index, segment in enumerate(segments):
        similarity = math.exp(
            -float(np.linalg.norm(scaled[index] - anchor_centroid)) / narrator_scale
        )
        ordered_distances = np.sort(distances[index])
        separation = float(
            ordered_distances[1] / max(ordered_distances[0] + ordered_distances[1], 1e-9)
        )
        is_anchor = segment["start"] < anchor_end
        is_narrator_cluster = model.labels_[index] == narrator_cluster
        if is_anchor:
            source_type = "editor_voiceover"
            confidence = max(0.9, similarity)
        elif is_narrator_cluster and similarity >= 0.35:
            source_type = "editor_voiceover"
            confidence = min(0.95, (similarity + separation) / 2)
        elif similarity <= 0.15:
            source_type = "source_audio"
            confidence = min(0.95, 1 - similarity)
        else:
            source_type = "uncertain"
            confidence = max(0.5, separation)
        classified.append(
            {
                **segment,
                "source_type": source_type,
                "classification_confidence": round(confidence, 3),
                "classification_basis": "intro narrator acoustic fingerprint",
            }
        )
    for index, segment in enumerate(classified):
        if segment["source_type"] != "editor_voiceover" or segment["start"] < anchor_end:
            continue
        previous_editor = (
            index > 0
            and classified[index - 1]["source_type"] == "editor_voiceover"
            and segment["start"] - classified[index - 1]["end"] <= 3
        )
        next_editor = (
            index + 1 < len(classified)
            and classified[index + 1]["source_type"] == "editor_voiceover"
            and classified[index + 1]["start"] - segment["end"] <= 3
        )
        isolated_short_line = (
            segment["end"] - segment["start"] < 4
            or len(segment["text"].split()) < 7
            or segment["text"].lstrip().startswith("-")
        )
        if isolated_short_line and not previous_editor and not next_editor:
            segment["source_type"] = "uncertain"
            segment["classification_confidence"] = 0.5
            segment["classification_basis"] += "; isolated short line excluded"
    return classified


def merge_voiceover_intervals(segments):
    voiceover = [
        segment for segment in segments if segment["source_type"] == "editor_voiceover"
    ]
    intervals = []
    for segment in voiceover:
        if intervals and segment["start"] <= intervals[-1]["end"] + 1.25:
            intervals[-1]["end"] = max(intervals[-1]["end"], segment["end"])
            intervals[-1]["text"] += " " + segment["text"]
            intervals[-1]["confidence"] = min(
                intervals[-1]["confidence"], segment["classification_confidence"]
            )
        else:
            intervals.append(
                {
                    "start": segment["start"],
                    "end": segment["end"],
                    "text": segment["text"],
                    "confidence": segment["classification_confidence"],
                }
            )
    for interval in intervals:
        interval["duration"] = interval["end"] - interval["start"]
    return intervals


def enrich_voiceover(intervals, silences, cuts):
    previous_end = 0
    for interval in intervals:
        interval["speech_gap_before"] = max(0, interval["start"] - previous_end)
        preceding = [
            silence
            for silence in silences
            if silence["end"] <= interval["start"]
            and interval["start"] - silence["end"] <= 0.75
        ]
        interval["dead_silence_before"] = preceding[-1]["duration"] if preceding else 0
        nearby_cuts = sorted(cuts, key=lambda cut: abs(cut["time"] - interval["start"]))
        nearest = nearby_cuts[0] if nearby_cuts else None
        interval["nearest_cut_time"] = nearest["time"] if nearest else None
        interval["voice_after_cut_seconds"] = (
            interval["start"] - nearest["time"]
            if nearest and abs(nearest["time"] - interval["start"]) <= 2
            else None
        )
        interval["cut_count"] = sum(
            interval["start"] <= cut["time"] <= interval["end"] for cut in cuts
        )
        previous_end = interval["end"]


def merge_ranges(ranges):
    merged = []
    for item in sorted(ranges, key=lambda value: value["start"]):
        if merged and item["start"] <= merged[-1]["end"]:
            merged[-1]["end"] = max(merged[-1]["end"], item["end"])
        else:
            merged.append({"start": item["start"], "end": item["end"]})
    for item in merged:
        item["duration"] = item["end"] - item["start"]
    return merged


def source_play_windows(intervals, duration):
    windows = []
    previous_end = 0
    for interval in intervals:
        if interval["start"] > previous_end:
            windows.append({"start": previous_end, "end": interval["start"]})
        previous_end = max(previous_end, interval["end"])
    if previous_end < duration:
        windows.append({"start": previous_end, "end": duration})
    for window in windows:
        window["duration"] = window["end"] - window["start"]
    return windows


def editorial_cues(intervals):
    patterns = {
        "replay_or_slow_motion": re.compile(
            r"\b(slow motion|see that again|watch that again|replay|another angle|other officer.?s perspective)\b",
            re.IGNORECASE,
        ),
        "attention_direction": re.compile(
            r"\b(keep your eye|watch closely|look at|notice|pay attention)\b",
            re.IGNORECASE,
        ),
        "story_setup": re.compile(
            r"\b(on (january|february|march|april|may|june|july|august|september|october|november|december)|it was .*20\d\d|was on patrol)\b",
            re.IGNORECASE,
        ),
        "outcome_summary": re.compile(
            r"\b(was arrested|were arrested|was charged|were charged|identified as|booked into|taken to)\b",
            re.IGNORECASE,
        ),
    }
    cues = []
    for interval in intervals:
        for cue_type, pattern in patterns.items():
            if pattern.search(interval["text"]):
                cues.append(
                    {
                        "time": interval["start"],
                        "type": cue_type,
                        "text": interval["text"][:240],
                    }
                )
    return cues


def in_voiceover(time, intervals, padding=0):
    return any(
        interval["start"] - padding <= time <= interval["end"] + padding
        for interval in intervals
    )


def format_time(seconds):
    minutes, seconds = divmod(seconds, 60)
    hours, minutes = divmod(int(minutes), 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:05.2f}"


def extract_contact_sheets(path, cuts, intervals, output_dir):
    frame_times = sorted(
        {
            round(cut["time"], 3)
            for cut in cuts
            if in_voiceover(cut["time"], intervals, padding=1)
        }
        | {round(interval["start"], 3) for interval in intervals}
    )
    frames_dir = output_dir / "editor-frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    for old_frame in frames_dir.glob("*.jpg"):
        old_frame.unlink()
    for old_sheet in output_dir.glob("contact-sheet-*.jpg"):
        old_sheet.unlink()
    capture = cv2.VideoCapture(str(path))
    frames = []
    for index, time in enumerate(frame_times):
        capture.set(cv2.CAP_PROP_POS_MSEC, time * 1000)
        success, frame = capture.read()
        if not success:
            continue
        width = 320
        height = round(frame.shape[0] * width / frame.shape[1])
        frame = cv2.resize(frame, (width, height))
        cv2.putText(
            frame,
            format_time(time),
            (8, height - 10),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.55,
            (255, 255, 255),
            2,
            cv2.LINE_AA,
        )
        frame_path = frames_dir / f"{index:04d}_{time:010.3f}.jpg"
        cv2.imwrite(str(frame_path), frame)
        frames.append((time, frame, frame_path))
    capture.release()

    sheets = []
    for sheet_index in range(0, len(frames), 16):
        batch = frames[sheet_index : sheet_index + 16]
        cell_height = max(frame.shape[0] for _, frame, _ in batch)
        sheet = np.zeros((cell_height * 4, 320 * 4, 3), dtype=np.uint8)
        for cell_index, (_, frame, _) in enumerate(batch):
            row, column = divmod(cell_index, 4)
            sheet[
                row * cell_height : row * cell_height + frame.shape[0],
                column * 320 : (column + 1) * 320,
            ] = frame
        sheet_path = output_dir / f"contact-sheet-{sheet_index // 16 + 1:03d}.jpg"
        cv2.imwrite(str(sheet_path), sheet)
        sheets.append(sheet_path.relative_to(ROOT).as_posix())
    return sheets


def write_report(analysis, destination):
    summary = analysis["summary"]
    cue_counts = Counter(cue["type"] for cue in analysis["editorial_cues"])
    lines = [
        "# Editorial Breakdown",
        "",
        "This report analyzes editor-added structure and excludes likely source/body-cam audio from the qualitative breakdown.",
        "",
        "## Overview",
        "",
        f"- Runtime: {format_time(analysis['duration_seconds'])}",
        f"- Detected cuts: {summary['total_cuts']}",
        f"- Cuts during editor-added narration: {summary['editorial_cuts']}",
        f"- Voice-over coverage: {summary['voiceover_duration_seconds']:.1f} seconds",
        f"- Non-editor speech excluded: {summary['source_audio_excluded_seconds']:.1f} seconds",
        f"- Editing pace during voice-over: {summary['cuts_per_minute_during_voiceover']:.1f} cuts/minute",
        f"- Overall editing pace: {summary['overall_cuts_per_minute']:.1f} cuts/minute",
        f"- Voice-over share of runtime: {summary['voiceover_coverage_ratio']:.1%}",
        f"- Cuts occurring during voice-over: {summary['editorial_cut_ratio']:.1%}",
        f"- Hook cuts in first 20 seconds: {summary['hook_cuts_first_20_seconds']}",
        f"- Median uninterrupted source-footage window: {summary['median_source_play_seconds']:.1f} seconds",
        f"- Longest uninterrupted source-footage window: {summary['longest_source_play_seconds']:.1f} seconds",
        "",
        "## Editing pattern",
        "",
        "The repeatable structure is: narrated setup -> extended source-footage run -> narrated explanation/outcome -> next setup.",
        "",
        f"- Story-setup cues: {cue_counts['story_setup']}",
        f"- Outcome-summary cues: {cue_counts['outcome_summary']}",
        f"- Replay or alternate-angle cues: {cue_counts['replay_or_slow_motion']}",
        f"- Attention-direction cues: {cue_counts['attention_direction']}",
        f"- Voice-over entrances with detected true silence immediately before them: "
        f"{sum(interval['dead_silence_before'] > 0 for interval in analysis['voiceover_intervals'])}",
        "",
        "## Voice-over entrances",
        "",
        "| Start | End | Source play before | True silence before | Cut relationship | Narration |",
        "|---|---|---:|---:|---|---|",
    ]
    for interval in analysis["voiceover_intervals"]:
        cut_relationship = (
            f"{interval['voice_after_cut_seconds']:+.2f}s from cut"
            if interval["voice_after_cut_seconds"] is not None
            else "no cut within 2s"
        )
        excerpt = interval["text"].replace("|", "\\|")[:140]
        lines.append(
            f"| {format_time(interval['start'])} | {format_time(interval['end'])} | "
            f"{interval['speech_gap_before']:.2f}s | {interval['dead_silence_before']:.2f}s | "
            f"{cut_relationship} | {excerpt} |"
        )
    lines.extend(
        [
            "",
            "## Explicit editorial cues",
            "",
        ]
    )
    for cue in analysis["editorial_cues"]:
        lines.append(
            f"- {format_time(cue['time'])} — **{cue['type'].replace('_', ' ')}**: "
            f"{cue['text']}"
        )
    lines.extend(
        [
            "",
            "## Source footage exclusion",
            "",
            "Likely body-cam, dash-cam, radio, and spontaneous source dialogue is retained in the machine-readable JSON for timing evidence but is excluded from the editorial interpretation.",
            "",
            f"- Excluded non-editor regions: {len(analysis['excluded_source_audio'])}",
            f"- Uncertain speech regions: {sum(s['source_type'] == 'uncertain' for s in analysis['speech_segments'])}",
            "",
            "## Visual review",
            "",
            "Contact sheets contain only cuts occurring during or immediately around likely editor narration. They are the visual evidence for title cards, montage choices, reframes, and other editor-added elements.",
            "",
        ]
    )
    lines.extend(f"- `{path}`" for path in analysis["contact_sheets"])
    destination.write_text("\n".join(lines), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description="Analyze editor-added choices in a finished video.")
    parser.add_argument("--asset-id", required=True)
    parser.add_argument("--adaptive-threshold", type=float, default=3.2)
    parser.add_argument("--minimum-content", type=float, default=20)
    parser.add_argument("--minimum-scene-seconds", type=float, default=0.75)
    parser.add_argument("--silence-db", type=float, default=-35)
    parser.add_argument("--silence-duration", type=float, default=0.25)
    parser.add_argument("--narrator-anchor-end", type=float, default=20)
    args = parser.parse_args()

    inventory = json.loads(INVENTORY.read_text(encoding="utf-8"))
    asset = next(asset for asset in inventory["assets"] if asset["asset_id"] == args.asset_id)
    if not asset["video"]:
        raise SystemExit("Editorial visual analysis requires a real video stream.")
    transcript_path = TRANSCRIPT_DIR / f"{asset['asset_id']}.json"
    transcript = json.loads(transcript_path.read_text(encoding="utf-8"))
    if not transcript["segments"] or transcript["segments"][-1]["end"] < asset["duration_seconds"] * 0.9:
        raise SystemExit("A full transcript is required before editorial analysis.")

    output_dir = OUTPUT_ROOT / asset["asset_id"]
    cache_dir = output_dir / "cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    media_path = Path(asset["relative_path"])
    cuts_cache = cache_dir / "adaptive-cuts.json"
    silence_cache = cache_dir / "silences.json"
    previous_analysis_path = output_dir / "editorial-analysis.json"
    previous_analysis = (
        json.loads(previous_analysis_path.read_text(encoding="utf-8"))
        if previous_analysis_path.exists()
        else {}
    )
    if cuts_cache.exists():
        cuts = json.loads(cuts_cache.read_text(encoding="utf-8"))
    else:
        cuts = detect_cuts(
            media_path,
            args.adaptive_threshold,
            args.minimum_content,
            args.minimum_scene_seconds,
        )
        cuts_cache.write_text(json.dumps(cuts, indent=2), encoding="utf-8")
    if silence_cache.exists():
        silences = json.loads(silence_cache.read_text(encoding="utf-8"))
    elif previous_analysis.get("silences"):
        silences = previous_analysis["silences"]
        silence_cache.write_text(json.dumps(silences, indent=2), encoding="utf-8")
    else:
        silences = detect_silences(media_path, args.silence_db, args.silence_duration)
        silence_cache.write_text(json.dumps(silences, indent=2), encoding="utf-8")
    speech = classify_speech(
        media_path,
        transcript,
        cache_dir,
        args.narrator_anchor_end,
    )
    voiceover = merge_voiceover_intervals(speech)
    enrich_voiceover(voiceover, silences, cuts)
    excluded_segments = [
        {
            "start": segment["start"],
            "end": segment["end"],
            "confidence": segment["classification_confidence"],
            "classification": segment["source_type"],
        }
        for segment in speech
        if segment["source_type"] != "editor_voiceover"
    ]
    source_audio = merge_ranges(excluded_segments)
    play_windows = source_play_windows(voiceover, asset["duration_seconds"])
    cues = editorial_cues(voiceover)
    voiceover_duration = sum(interval["duration"] for interval in voiceover)
    editorial_cuts = [cut for cut in cuts if in_voiceover(cut["time"], voiceover)]
    source_duration = sum(segment["end"] - segment["start"] for segment in source_audio)
    play_durations = [window["duration"] for window in play_windows]
    contact_sheets = extract_contact_sheets(media_path, cuts, voiceover, output_dir)
    analysis = {
        "version": "0.1",
        "asset_id": asset["asset_id"],
        "duration_seconds": asset["duration_seconds"],
        "classification_note": "Voice-over is inferred from the opening narrator's acoustic fingerprint. Uncertain regions require review.",
        "summary": {
            "total_cuts": len(cuts),
            "editorial_cuts": len(editorial_cuts),
            "cuts_per_minute_during_voiceover": (
                len(editorial_cuts) / voiceover_duration * 60 if voiceover_duration else 0
            ),
            "voiceover_duration_seconds": voiceover_duration,
            "source_audio_excluded_seconds": source_duration,
            "overall_cuts_per_minute": (
                len(cuts) / asset["duration_seconds"] * 60
                if asset["duration_seconds"]
                else 0
            ),
            "voiceover_coverage_ratio": (
                voiceover_duration / asset["duration_seconds"]
                if asset["duration_seconds"]
                else 0
            ),
            "editorial_cut_ratio": len(editorial_cuts) / len(cuts) if cuts else 0,
            "hook_cuts_first_20_seconds": sum(cut["time"] <= 20 for cut in cuts),
            "median_source_play_seconds": (
                float(np.median(play_durations)) if play_durations else 0
            ),
            "longest_source_play_seconds": max(play_durations, default=0),
        },
        "cuts": cuts,
        "silences": silences,
        "speech_segments": speech,
        "voiceover_intervals": voiceover,
        "excluded_source_audio": source_audio,
        "source_play_windows": play_windows,
        "editorial_cues": cues,
        "contact_sheets": contact_sheets,
    }
    json_path = output_dir / "editorial-analysis.json"
    report_path = output_dir / "EDITORIAL_REPORT.md"
    json_path.write_text(json.dumps(analysis, indent=2), encoding="utf-8")
    write_report(analysis, report_path)
    print(f"Editorial analysis -> {json_path}")
    print(f"Editor report -> {report_path}")


if __name__ == "__main__":
    main()
