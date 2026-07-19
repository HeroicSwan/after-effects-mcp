---
name: after-effects-mcp
description: Control Adobe After Effects via the ae-mcp server. Use for mograph, editing, subtitles, and Blender-to-AE 3D. Enforces verification gates so work is not marked done without proof.
---

# After Effects MCP Skill

## Prerequisites

1. AE open → **Window → ae-mcp-status → CONNECT BRIDGE**
2. Real 3D: **Blender open** + blender MCP
3. Scripting file/network access enabled

## Definition of done (non-negotiable)

A task is **NOT done** until:

1. Tools returned success **and**
2. **`ae_capture_frame`** shows the expected subject on screen **and**
3. For 3D: **`ae_verify_blender_job`** was `ok: true` **before** import **and**
4. For 3D: RAW import comp exists with sequence duration ≈ frames/fps

If capture is empty/black/wrong → **STOP**, report failure, fix. Never invent success.

---

## CRITICAL: Real 3D (Blender → AE)

### Pipeline (always)

```
0. Write a 5–10 line style brief if a reference URL/video was given
1. ae_prepare_blender_3d_job
2. blender execute_blender_code — build model (screenshot via blender get_viewport_screenshot)
3. blender render export (PNG sequence, transparent)
4. ae_verify_blender_job  → must ok:true (frames differ, enough frames)
5. ae_import_3d_from_blender → dedicated RAW comp first
6. ae_capture_frame on RAW at 0.5s and mid  → Earth/object MUST be visible
7. Build design comp that PRECOMPS the RAW layer
8. ae_capture_frame on design vs style brief checklist
```

### Never

- Claim Blender 3D is in AE without steps 4–6
- Only use CC Sphere when user asked for Blender/real 3D (fallback only if Blender fails **and** user accepts)
- Skip verify because "render probably worked"

### Why PNG sequence

AE does not load live `.blend` meshes. Transparent PNG sequence = production path. GLB/OBJ are sidecars.

---

## CRITICAL: Japanese / Alight-style kinetic mograph

When given a reference (e.g. Alight Motion JP kinetic):

1. **Style brief first** (palette, type scale, cut rate, wipes, grid)
2. **Shot list** (6–12 beats) before building
3. Prefer: hard color wipes, kinetic type hits, mask reveals, short holds — not random floating circles
4. No music unless asked
5. Subtitles: stroke only, **no black bars** unless asked

---

## CRITICAL: Subtitles

- **`ae_create_subtitle`** only
- **NEVER** default black bar / plate

## CRITICAL: Video cutting

- Never random/even cuts
- **Silence only:** `ae_analyze_cuts` → `ae_build_smart_edit`
- **Speech cleanup (fillers/stutters + pad):**  
  **`ae_transcribe_video`** → **`ae_transcript_to_cuts`** → **`ae_build_smart_edit`**
- `pad_before` / `pad_after` on transcript cuts leave handles for clean edits (defaults ~0.12 / 0.18s)
- Captions from cleaned text: `ae_create_subtitle` (no black bars)

### Talk-track edit recipe

```
1. ae_transcribe_video({ path: "C:/video.mp4", model: "base" })
   → timed JSON + words under ~/.ae-mcp/transcripts/ (+ SRT/VTT)
2. ae_transcript_to_cuts({
     transcript: result.full_transcript,   // or transcript_path
     pad_before: 0.12,   // handle before speech
     pad_after: 0.18,    // handle after speech (room for clean cuts)
     remove_fillers: true,      // um/uh/…
     remove_stutters: true,     // repeated words
     aggressive_fillers: false  // true = also strip like/basically/actually
   })
3. ae_build_smart_edit({ path, segments: keep, comp_name: "Talk Edit" })
4. Optional: ae_create_subtitle per keep cue (text / inPoint / outPoint) — no black bars
5. ae_capture_frame to verify
```

CLI: `ae-mcp transcribe "C:/video.mp4" --model base --language en`

---

## Tool map

| Goal | Tool |
|------|------|
| 3D job | `ae_prepare_blender_3d_job` |
| 3D verify | **`ae_verify_blender_job`** |
| 3D import | **`ae_import_3d_from_blender`** |
| Jobs list | `ae_list_blender_jobs` |
| Captions | `ae_create_subtitle` |
| Silence cuts | `ae_analyze_cuts` → `ae_build_smart_edit` |
| **Transcript + cleanup cuts** | **`ae_transcribe_video`** → **`ae_transcript_to_cuts`** → `ae_build_smart_edit` |
| Proof | **`ae_capture_frame`** |

See `docs/lessons-3d-mograph.md` for postmortem on Earth job failures.
