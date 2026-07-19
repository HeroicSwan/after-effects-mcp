/**
 * Blender ↔ After Effects exchange helpers.
 *
 * AE does not load .blend meshes natively. The reliable free pipeline is:
 *   Blender (model + animate) → transparent PNG sequence / ProRes → AE import
 *
 * Optional: also export .obj/.fbx for Cinema 4D Lite / third-party plugins.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import os from "node:os";
import { getDataRoot, ensureDataDirs } from "../util/paths.js";

export function exchangeRoot(): string {
  ensureDataDirs();
  const root = path.join(getDataRoot(), "blender-exchange");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

export interface BlenderJobPaths {
  jobId: string;
  jobDir: string;
  /** PNG sequence: frame_0001.png … */
  framesDir: string;
  /** First frame path pattern for docs */
  framePattern: string;
  /** Optional rendered movie */
  moviePath: string;
  /** Optional mesh export */
  objPath: string;
  fbxPath: string;
  glbPath: string;
  /** Manifest written after Blender export */
  manifestPath: string;
}

export function createBlenderJob(jobName?: string): BlenderJobPaths {
  const safe =
    (jobName || "job")
      .replace(/[^\w\-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "job";
  const jobId = `${safe}_${Date.now().toString(36)}`;
  const jobDir = path.join(exchangeRoot(), jobId);
  const framesDir = path.join(jobDir, "frames");
  fs.mkdirSync(framesDir, { recursive: true });

  const paths: BlenderJobPaths = {
    jobId,
    jobDir,
    framesDir,
    framePattern: path.join(framesDir, "frame_####.png").replace(/\\/g, "/"),
    moviePath: path.join(jobDir, "render.mov").replace(/\\/g, "/"),
    objPath: path.join(jobDir, "model.obj").replace(/\\/g, "/"),
    fbxPath: path.join(jobDir, "model.fbx").replace(/\\/g, "/"),
    glbPath: path.join(jobDir, "model.glb").replace(/\\/g, "/"),
    manifestPath: path.join(jobDir, "manifest.json").replace(/\\/g, "/"),
  };

  fs.writeFileSync(
    path.join(jobDir, "README.txt"),
    `Blender → AE exchange job: ${jobId}

1) In Blender (via blender MCP execute_blender_code), render PNG sequence to:
   ${framesDir}
   Naming: frame_0001.png, frame_0002.png, ...

2) Or export mesh:
   OBJ: ${paths.objPath}
   FBX: ${paths.fbxPath}
   GLB: ${paths.glbPath}

3) In AE: ae_import_3d_from_blender with jobId "${jobId}"
`,
    "utf8",
  );

  return paths;
}

export function readManifest(jobId: string): Record<string, unknown> | null {
  const p = path.join(exchangeRoot(), jobId, "manifest.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function listFrameSequence(framesDir: string): {
  files: string[];
  first: string | null;
  count: number;
} {
  if (!fs.existsSync(framesDir)) return { files: [], first: null, count: 0 };
  const files = fs
    .readdirSync(framesDir)
    .filter((f) => /\.(png|exr|tif|tiff|jpg|jpeg)$/i.test(f))
    .sort();
  const abs = files.map((f) => path.join(framesDir, f));
  return { files: abs, first: abs[0] ?? null, count: abs.length };
}

export function resolveJob(jobId: string): BlenderJobPaths | null {
  const jobDir = path.join(exchangeRoot(), jobId);
  if (!fs.existsSync(jobDir)) return null;
  const framesDir = path.join(jobDir, "frames");
  return {
    jobId,
    jobDir,
    framesDir,
    framePattern: path.join(framesDir, "frame_####.png").replace(/\\/g, "/"),
    moviePath: path.join(jobDir, "render.mov").replace(/\\/g, "/"),
    objPath: path.join(jobDir, "model.obj").replace(/\\/g, "/"),
    fbxPath: path.join(jobDir, "model.fbx").replace(/\\/g, "/"),
    glbPath: path.join(jobDir, "model.glb").replace(/\\/g, "/"),
    manifestPath: path.join(jobDir, "manifest.json").replace(/\\/g, "/"),
  };
}

export function listJobs(): string[] {
  const root = exchangeRoot();
  return fs
    .readdirSync(root)
    .filter((n) => fs.statSync(path.join(root, n)).isDirectory())
    .sort()
    .reverse();
}

export interface BlenderJobVerification {
  jobId: string;
  ok: boolean;
  frameCount: number;
  expectedFrames: number | null;
  uniqueSampleHashes: number;
  sampleCount: number;
  framesDiffer: boolean;
  hasGlb: boolean;
  hasObj: boolean;
  glbBytes: number;
  objBytes: number;
  hasManifest: boolean;
  firstFrame: string | null;
  errors: string[];
  warnings: string[];
}

/** Verify Blender export is real before AE import. */
export function verifyBlenderJob(
  jobId: string,
  options?: { minFrames?: number },
): BlenderJobVerification {
  const minFrames = options?.minFrames ?? 2;
  const job = resolveJob(jobId);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!job) {
    return {
      jobId,
      ok: false,
      frameCount: 0,
      expectedFrames: null,
      uniqueSampleHashes: 0,
      sampleCount: 0,
      framesDiffer: false,
      hasGlb: false,
      hasObj: false,
      glbBytes: 0,
      objBytes: 0,
      hasManifest: false,
      firstFrame: null,
      errors: [`Job not found: ${jobId}`],
      warnings: [],
    };
  }

  const seq = listFrameSequence(job.framesDir);
  const sampleEvery = Math.max(1, Math.floor(seq.files.length / 12));
  const hashes = new Set<string>();
  let sampleCount = 0;
  for (let i = 0; i < seq.files.length; i += sampleEvery) {
    const buf = fs.readFileSync(seq.files[i]!);
    hashes.add(createHash("md5").update(buf).digest("hex").slice(0, 12));
    sampleCount++;
  }

  let expectedFrames: number | null = null;
  const man = readManifest(jobId);
  if (man && typeof man.frames === "number") expectedFrames = man.frames as number;

  if (seq.count < minFrames) {
    errors.push(`Need at least ${minFrames} frames, found ${seq.count}`);
  }
  if (sampleCount >= 2 && hashes.size < 2) {
    errors.push(
      "Sampled frames are identical — 3D animation likely did not render (frozen model).",
    );
  } else if (sampleCount >= 4 && hashes.size < 3) {
    warnings.push("Low frame diversity — spin may be too subtle.");
  }

  const glbBytes = fs.existsSync(job.glbPath) ? fs.statSync(job.glbPath).size : 0;
  const objBytes = fs.existsSync(job.objPath) ? fs.statSync(job.objPath).size : 0;
  const hasGlb = glbBytes >= 1_024;
  const hasObj = objBytes >= 256;
  if (glbBytes > 0 && !hasGlb) errors.push(`GLB export is empty or invalid (${glbBytes} bytes).`);
  if (objBytes > 0 && !hasObj) errors.push(`OBJ export is empty or invalid (${objBytes} bytes).`);
  if (!hasGlb && !hasObj) {
    warnings.push("No GLB/OBJ mesh export (OK if using PNG sequence only).");
  }

  return {
    jobId,
    ok: errors.length === 0,
    frameCount: seq.count,
    expectedFrames,
    uniqueSampleHashes: hashes.size,
    sampleCount,
    framesDiffer: hashes.size >= 2,
    hasGlb,
    hasObj,
    glbBytes,
    objBytes,
    hasManifest: !!man,
    firstFrame: seq.first,
    errors,
    warnings,
  };
}

/**
 * Python snippet for Blender MCP execute_blender_code.
 * Renders a spinning object to PNG sequence + exports GLB/OBJ.
 */
export function blenderExportScript(paths: BlenderJobPaths, options?: {
  frames?: number;
  fps?: number;
  resolution?: number;
  objectName?: string;
}): string {
  const frames = options?.frames ?? 90;
  const fps = options?.fps ?? 30;
  const res = options?.resolution ?? 1080;
  const objName = options?.objectName ?? "";

  // Generate Python without template literal issues for Blender
  return `
import bpy, os, math

job_dir = r${JSON.stringify(paths.jobDir.replace(/\//g, path.sep))}
frames_dir = r${JSON.stringify(paths.framesDir.replace(/\//g, path.sep))}
os.makedirs(frames_dir, exist_ok=True)

# Scene setup
scene = bpy.context.scene
scene.render.engine = 'BLENDER_EEVEE_NEXT' if hasattr(bpy.types, 'BLENDER_EEVEE_NEXT') else 'BLENDER_EEVEE'
try:
    scene.render.engine = 'BLENDER_EEVEE'
except Exception:
    pass
scene.render.resolution_x = ${res}
scene.render.resolution_y = ${res}
scene.render.resolution_percentage = 100
scene.render.fps = ${fps}
scene.frame_start = 1
scene.frame_end = ${frames}
scene.render.film_transparent = True
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.render.filepath = os.path.join(frames_dir, 'frame_')

# Prefer named object, else active, else first mesh
obj = None
name = ${JSON.stringify(objName)}
if name and name in bpy.data.objects:
    obj = bpy.data.objects[name]
elif bpy.context.view_layer.objects.active:
    obj = bpy.context.view_layer.objects.active
else:
    for o in bpy.data.objects:
        if o.type == 'MESH':
            obj = o
            break

if obj is None:
    # Create a UV sphere as fallback "earth-like" stand-in
    bpy.ops.mesh.primitive_uv_sphere_add(segments=64, ring_count=32, radius=1.2, location=(0,0,0))
    obj = bpy.context.active_object
    obj.name = 'EarthProxy'
    bpy.ops.object.shade_smooth()

# Clear prior anim
obj.animation_data_clear()
obj.rotation_mode = 'XYZ'
obj.rotation_euler = (math.radians(15), 0, 0)
obj.keyframe_insert(data_path='rotation_euler', frame=1)
obj.rotation_euler = (math.radians(15), math.radians(360), math.radians(40))
obj.keyframe_insert(data_path='rotation_euler', frame=${frames})
if obj.animation_data and obj.animation_data.action:
    for fc in obj.animation_data.action.fcurves:
        for kp in fc.keyframe_points:
            kp.interpolation = 'LINEAR'

# Camera
cam = None
for o in bpy.data.objects:
    if o.type == 'CAMERA':
        cam = o
        break
if cam is None:
    bpy.ops.object.camera_add(location=(0, -4.5, 1.8))
    cam = bpy.context.active_object
    cam.rotation_euler = (math.radians(72), 0, 0)
scene.camera = cam

# Light
has_light = any(o.type == 'LIGHT' for o in bpy.data.objects)
if not has_light:
    bpy.ops.object.light_add(type='SUN', location=(3, -2, 5))
    sun = bpy.context.active_object
    sun.data.energy = 3.0
    bpy.ops.object.light_add(type='AREA', location=(-3, 2, 2))
    bpy.context.active_object.data.energy = 50

# Export meshes for optional C4D / plugins
try:
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.export_scene.gltf(filepath=r${JSON.stringify(paths.glbPath.replace(/\//g, path.sep))}, use_selection=True, export_animations=True)
except Exception as e:
    print('gltf export skip', e)
try:
    bpy.ops.wm.obj_export(filepath=r${JSON.stringify(paths.objPath.replace(/\//g, path.sep))}, export_selected_objects=True)
except Exception:
    try:
        bpy.ops.export_scene.obj(filepath=r${JSON.stringify(paths.objPath.replace(/\//g, path.sep))}, use_selection=True)
    except Exception as e:
        print('obj export skip', e)

# Render sequence
bpy.ops.render.render(animation=True)

import json
manifest = {
    'jobId': ${JSON.stringify(paths.jobId)},
    'object': obj.name,
    'frames': ${frames},
    'fps': ${fps},
    'framesDir': frames_dir,
    'glb': r${JSON.stringify(paths.glbPath.replace(/\//g, path.sep))},
    'obj': r${JSON.stringify(paths.objPath.replace(/\//g, path.sep))},
}
with open(r${JSON.stringify(paths.manifestPath.replace(/\//g, path.sep))}, 'w') as f:
    json.dump(manifest, f, indent=2)
print('AE_MCP_BLENDER_EXPORT_OK', ${JSON.stringify(paths.jobId)})
`.trim();
}
