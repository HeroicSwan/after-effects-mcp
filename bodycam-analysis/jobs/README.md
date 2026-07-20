# Body-Cam Jobs

Each local job is created with:

```powershell
python scripts/create_job.py incident-001 --video "C:\path\raw-bodycam.mp4"
```

The generated folder is:

```text
jobs/incident-001/
  job.json
  inputs/
    bodycam/
    narration/
    case-info/
  analysis/
    evidence/
  edit/
  renders/
  review/
  work/
  logs/
```

The video may be referenced with `--video` or dropped into `inputs/bodycam/`.
Run the raw analyzer from `bodycam-analysis/`:

```powershell
python scripts/analyze_raw.py jobs/incident-001
```

It writes `analysis/transcript.json` and `analysis/raw-timeline.json`. The job
remains locked from edit building until the timeline is reviewed.
