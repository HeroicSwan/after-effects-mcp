# After Effects MCP usage

## Core workflow

Use this loop for reliable work:

1. Call `ae_health` and inspect the active project.
2. Create or select a composition.
3. Build layers, animation, expressions, and effects.
4. Call `ae_capture_frame` or `ae_capture_frames`.
5. Inspect the returned stills and iterate before rendering.

## YouTube editing

Use `ae_create_editorial_plan` with a transcript and optional duration targets. The planner creates an explainable edit decision list with sentence boundaries, cut-quality scores, pacing, hook coverage, filler handling, chapters, b-roll suggestions, and graphic suggestions.

Choose an editing mode for the desired result:

- `clean`: natural pacing and minimal intervention
- `retention`: faster opening, stronger pattern changes, and tighter pauses
- `story`: continuity and narrative clarity over maximum cut density

Run `ae_audit_editorial_plan` before `ae_build_youtube_edit`. The audit reports pacing, coverage, hook, and quality warnings so a human or approval-aware client can revise the plan.

## Motion graphics

Use `ae_create_motion_template` to create reusable, brand-aware graphics such as hooks, lower thirds, chapter cards, statistics, quotes, subscribe prompts, and end screens. A project brand system keeps colors, type, spacing, logo, and voice consistent across templates.

For a complete coherent motion video, use the blueprint workflow:

1. Call `ae_create_motion_blueprint` with the brief, duration, aspect ratio, and optional scene list.
2. Call `ae_validate_motion_blueprint` to inspect the explainable checks.
3. Call `ae_repair_motion_blueprint` for safe timing, template, and text-density repairs.
4. Call `ae_build_motion_video` with the blueprint or blueprint path.

`ae_build_motion_video` creates a named scene structure (`S01_HOOK`, `S02_SETUP`, `S03_EXPLANATION`, `S04_PAYOFF`, `S05_CTA`), applies one visual grammar across every template, adds scene markers, captures frame QA, renders a preview, and creates a review item. In approval mode it pauses before final delivery; in autonomous mode it completes and approves the workflow after structural QA.

For 3D work, use `ae_prepare_blender_3d_job`, create or animate the scene in Blender, then call `ae_verify_blender_job` before `ae_import_3d_from_blender`. Verification checks frame coverage, frame variation, and exported geometry before import.

## Review and rendering

Use `ae_create_review` to save a preview render and review metadata. Use `ae_decide_review` with `approve` or `reject` plus notes. Keep approval required for client-facing exports; use autonomous mode only for trusted draft iterations.

Call `ae_render_composition` with an explicit preset and output path for MP4, MOV, or PNG exports. Verify the result with the returned metadata and a captured frame before delivery.

## Safety

Destructive layer operations require confirmation. Keep the local bridge private, avoid putting credentials in project files, and review JSX escape-hatch code before running it. The MCP server is an automation layer, not a replacement for saving versions of important AE projects.
