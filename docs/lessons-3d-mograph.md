# Lessons: Blender 3D + Japanese mograph (Earth job)

## What went wrong (honest)

### 1. "Never finished the 3D model"
- We built a UV sphere + texture in Blender and rendered 120 frames + GLB.
- But we **did not gate quality**: no viewport check, no material polish pass, no "looks like Earth" approval.
- Animation API quirks (Blender 4/5 fcurves) meant we almost shipped a frozen ball.
- **Fix:** `ae_verify_blender_job` — requires multiple unique frame hashes before import.

### 2. "Never brought it into After Effects"
- `ae_import_3d_from_blender` failed with `UNKNOWN_METHOD` because AE still had a **stale methods pack** loaded (or 0-byte methods file).
- Fallback `run_jsx` path claimed success without proving the sequence layer duration/visibility.
- Capture returned **0-byte PNG** — still marked done. That is a process failure.
- **Fix:** engine reloads methods by version; import has JSX fallback; **capture verify is mandatory**.

### 3. "Nothing like the reference" (youtube DH-OtUatk9c — Alight Motion / JP kinetic)
Reference DNA we under-delivered:
| Reference trait | What we did | Needed |
|-----------------|-------------|--------|
| Beat-synced kinetic type | Random labels | Shot list from reference beats |
| Bold color fields / wipes | Sparse blocks | Full-frame color cuts, hard wipes |
| Graphic masks / magnetic transitions | Soft pops only | Mask reveals, track mattes |
| Clean typography hierarchy | Generic English | JP type hierarchy + layout grid |
| Fast edit pacing | Slow 4–6s hero | Cut every 0.3–0.8s on accents |
| No music (user rule) | OK | Keep silent; use visual rhythm only |

---

## How we make this better (system)

### A. Hard quality gates (no "done" without evidence)

```
GATE 0  Reference brief (30s)
        - 5–10 bullet style notes from reference video
        - color palette, type style, cut rate, camera

GATE 1  Blender model
        - viewport screenshot
        - user or self-check: "reads as Earth / subject"

GATE 2  Blender render
        - ae_verify_blender_job → ok:true
        - framesDiffer:true, frameCount matches

GATE 3  AE import
        - ae_import_3d_from_blender
        - ae_get_composition shows layer with duration ≈ frames/fps
        - ae_capture_frame t=0.5 AND t=mid → Earth visible

GATE 4  Mograph match
        - implement shot list (not free-jam)
        - capture 3 frames vs reference traits checklist
```

### B. Two comps always
1. **`_BLENDER_EARTH_RAW`** — only the sequence, full frame, prove import
2. **`JP_MOGRAPH_MASTER`** — design on top (precomp the earth)

Never design until RAW capture proves the 3D is in AE.

### C. Reference-driven mograph (not vibes)
For Alight Motion / JP kinetic refs:
1. Extract or note timestamps of 6–10 key looks
2. Build a **shot list** table: time | visual | type | color
3. Implement shot-by-shot in AE
4. No random decorative circles without a purpose tied to the list

### D. MCP reliability
| Issue | Fix |
|-------|-----|
| Stale methods | Engine methods version + force reload |
| 0-byte methods file | install checks pack.length > 1000 |
| Silent import fail | verify + fallback JSX + capture gate |
| Agent over-claiming | skill: never "done" without capture proof |

### E. Optional future
- `ae_import_precomp` helper
- ffmpeg `palettegen` style boards from reference frames
- Blender turntable presets (product / full-body / globe)
- Template comps: "JP kinetic pack" with placeholders

---

## Minimum bar for next Earth attempt

- [ ] Blender viewport shows textured Earth
- [ ] verify job: 60+ frames, framesDiffer
- [ ] RAW comp capture shows Earth spinning
- [ ] MASTER has ≥6 reference-matched beats
- [ ] No subtitle bars
- [ ] No music (unless asked)
`;