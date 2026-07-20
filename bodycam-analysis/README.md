# Body-Cam Video Analysis Corpus

This workspace turns reference videos into structured evidence that an AI editor
can use before the existing After Effects MCP builds a composition.

The system keeps three things separate:

1. `reference-data/` contains local source videos, audio, and human labels.
2. `analysis/` contains generated transcripts, timelines, style profiles, and edit plans.
3. `schemas/` defines the JSON contract between analysis and the After Effects MCP.

Source media is ignored by Git and should remain unchanged.

## Add reference videos

Drop files into the folder that describes what they teach:

```text
reference-data/
  incoming/          Unsorted downloads
  finished-good/     Finished edits whose style should be learned
  finished-bad/      Finished edits whose decisions should be avoided
  raw/               Unedited body-cam recordings
  raw-final-pairs/   Raw and finished versions of the same story
  narration/         Narration or voice-over recordings
```

For a raw/final pair, use one folder per story:

```text
reference-data/raw-final-pairs/story-001/
  raw.mp4
  final.mp4
  narration.wav
  notes.txt
```

## Build the media inventory

Python and `ffprobe` are the only requirements for the first stage:

```powershell
python scripts/inventory.py
```

This writes `analysis/inventory/media.json`. The command does not modify the
source files.

Specific files can be tested before they are organized:

```powershell
python scripts/inventory.py "C:\path\video.mp4" "C:\path\audio.mp3"
```

## Transcribe inventoried media

The transcript stage uses FFmpeg's local GPU-accelerated Whisper filter:

```powershell
python scripts/transcribe.py
```

For a short pipeline test:

```powershell
python scripts/transcribe.py --limit-seconds 90
```

Transcripts are written to `analysis/transcripts/` as structured JSON and plain
text. Existing transcripts are skipped unless `--force` is supplied.

## Analyze the editor's choices

After a full transcript exists, run:

```powershell
python scripts/analyze_editorial.py --asset-id <asset-id>
```

The editorial pass uses adaptive cut detection to reduce false cuts caused by
body-cam motion, then detects true audio silence, fingerprints the opening
narrator, separates likely voice-over from source/body-cam speech, and creates
editor-only contact sheets. It writes:

```text
analysis/editorial/<asset-id>/
  editorial-analysis.json
  EDITORIAL_REPORT.md
  contact-sheet-*.jpg
```

The report intentionally excludes likely body-cam, dash-cam, radio, and
spontaneous source dialogue. Uncertain speaker classifications remain flagged
for review.

## Run the complete pipeline

For media already organized in `reference-data/`:

```powershell
python scripts/full_analysis.py
```

Files can also be analyzed directly from Downloads:

```powershell
python scripts/full_analysis.py "C:\path\reference-video.mp4" "C:\path\reference-audio.mp3"
```

The runner inventories every input, creates full transcripts, skips visual
analysis for audio-only files, and produces one editorial report per real video.

## Evaluate a finished render

After After Effects renders an edit, generate its YouTube-readiness score and
editorial review packet:

```powershell
python scripts/evaluate_output.py "C:\path\finished-edit.mp4"
```

The first pass measures 55 points automatically: technical delivery, audio,
dead time, pacing, and opening structure. It also creates opening and overview
contact sheets plus `REVIEW_PACKET.md`. The remaining 45 points require an AI
editorial review of the hook, story clarity, editorial polish, and documentary
context. Privacy, graphic violence, factual grounding, and media rights remain
hard publish gates.

After completing the JSON template in the review packet, finalize the score:

```powershell
python scripts/evaluate_output.py "C:\path\finished-edit.mp4" --review "C:\path\editorial-review.json"
```

Each content revision receives a new evaluation ID, so an overwritten render
cannot accidentally reuse the previous transcript or score. Results are written
to `analysis/evaluations/<evaluation-id>/`.

## Analysis stages

The next analyzers will enrich the inventory in this order:

```text
inventory
  -> transcript
  -> visual timeline
  -> raw/final comparison
  -> style profile
  -> edit plan
  -> After Effects MCP
  -> rendered output
  -> evaluation
  -> revision or publish
```

An edit plan must reference real source timestamps and include a reason and
confidence score for every selection. Low-confidence transcription, privacy
detection, and editorial decisions remain reviewable.
