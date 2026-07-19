import { MOTION_TEMPLATES } from "../motion/templates.js";
import type { BrandConfig } from "./preferences.js";

export type MotionAspectRatio = "16:9" | "9:16" | "1:1";
export type MotionScenePurpose = "hook" | "setup" | "explanation" | "payoff" | "cta";
export type MotionIntensity = "low" | "medium" | "high";
export type MotionTransition = "cut" | "fade" | "slide" | "scale";
export type MotionVisualStyle = "japanese-pop" | "kinetic-editorial" | "minimal";

export interface MotionBeat {
  offset: number;
  kind: "impact" | "entrance" | "accent" | "settle" | "transition";
  intensity: number;
}

export interface VisualGrammar {
  easing: "easeOut" | "easeInOut" | "linear";
  transition: MotionTransition;
  motionIntensity: MotionIntensity;
  maxTextLines: number;
  maxWordsPerGraphic: number;
  titleScale: number;
  bodyScale: number;
  cornerRadius: number;
}

export interface MotionSceneBlueprint {
  id: string;
  purpose: MotionScenePurpose;
  start: number;
  end: number;
  title: string;
  subtitle?: string;
  visualGoal: string;
  templateId: string;
  transition: MotionTransition;
  motionIntensity: MotionIntensity;
  beats: MotionBeat[];
}

export interface MotionVideoBlueprint {
  version: 1;
  id: string;
  brief: string;
  visualStyle: MotionVisualStyle;
  energy: number;
  compName: string;
  aspectRatio: MotionAspectRatio;
  width: number;
  height: number;
  duration: number;
  frameRate: number;
  brand: BrandConfig;
  visualGrammar: VisualGrammar;
  scenes: MotionSceneBlueprint[];
  qa: {
    requiredFrameCount: number;
    minimumScore: number;
    requireHookAndCta: boolean;
  };
  render: {
    format: "mp4" | "mov" | "png";
    preset?: string;
  };
  createdAt: string;
}

export interface MotionSceneInput {
  purpose: MotionScenePurpose;
  title: string;
  subtitle?: string;
  visualGoal?: string;
  templateId?: string;
  start?: number;
  end?: number;
  motionIntensity?: MotionIntensity;
  transition?: MotionTransition;
  beats?: MotionBeat[];
}

export interface CreateMotionBlueprintOptions {
  brief: string;
  compName: string;
  duration: number;
  frameRate: number;
  aspectRatio: MotionAspectRatio;
  brand: BrandConfig;
  visualStyle?: MotionVisualStyle;
  energy?: number;
  scenes?: MotionSceneInput[];
  renderFormat?: "mp4" | "mov" | "png";
  renderPreset?: string;
}

const DIMENSIONS: Record<MotionAspectRatio, { width: number; height: number }> = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
};

const DEFAULT_SCENES: Array<{ purpose: MotionScenePurpose; templateId: string; share: number; visualGoal: string }> = [
  { purpose: "hook", templateId: "youtube-hook", share: 0.16, visualGoal: "Make the central idea immediately legible" },
  { purpose: "setup", templateId: "chapter-card", share: 0.18, visualGoal: "Establish context and the viewer promise" },
  { purpose: "explanation", templateId: "stat-callout", share: 0.30, visualGoal: "Give the main idea one strong visual anchor" },
  { purpose: "payoff", templateId: "quote-card", share: 0.22, visualGoal: "Deliver the memorable takeaway" },
  { purpose: "cta", templateId: "end-screen", share: 0.14, visualGoal: "Close with a clear next action" },
];

function cleanText(value: string, fallback: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text || fallback;
}

function shortTitle(brief: string): string {
  const words = cleanText(brief, "Make the idea impossible to miss").split(" ");
  return words.slice(0, 9).join(" ").replace(/[.,!?;:]+$/, "");
}

function defaultBeats(start: number, end: number, energy: number): MotionBeat[] {
  const span = Math.max(0.75, end - start);
  return [
    { offset: 0.02, kind: "impact", intensity: Math.min(1, energy + 0.08) },
    { offset: Number(Math.min(span - 0.08, span * 0.24).toFixed(3)), kind: "entrance", intensity: energy },
    { offset: Number(Math.min(span - 0.06, span * 0.58).toFixed(3)), kind: "accent", intensity: Math.max(0.5, energy - 0.08) },
    { offset: Number(Math.min(span - 0.03, span * 0.86).toFixed(3)), kind: "settle", intensity: Math.max(0.4, energy - 0.18) },
  ];
}

function normalizeBeats(beats: MotionBeat[] | undefined, start: number, end: number, energy: number): MotionBeat[] {
  const span = Math.max(0.75, end - start);
  const defaults = defaultBeats(start, end, energy);
  const source = beats?.length ? beats : defaults;
  const cleaned = source.map((beat) => ({
    offset: Number(Math.max(0.02, Math.min(span - 0.03, beat.offset)).toFixed(3)),
    kind: beat.kind,
    intensity: Number(Math.max(0, Math.min(1, beat.intensity)).toFixed(3)),
  }));
  for (const required of ["impact", "entrance", "accent", "settle"] as const) {
    if (!cleaned.some((beat) => beat.kind === required)) {
      cleaned.push(defaults.find((beat) => beat.kind === required)!);
    }
  }
  return cleaned.sort((a, b) => a.offset - b.offset);
}

function defaultScenes(brief: string, duration: number): MotionSceneInput[] {
  const hook = shortTitle(brief);
  const labels: Record<MotionScenePurpose, string> = {
    hook,
    setup: "Why this matters",
    explanation: "The core idea",
    payoff: "Make it memorable",
    cta: "Build the next frame",
  };
  let cursor = 0;
  return DEFAULT_SCENES.map((scene, index) => {
    const start = cursor;
    const end = index === DEFAULT_SCENES.length - 1 ? duration : Number((cursor + duration * scene.share).toFixed(3));
    cursor = end;
    return {
      purpose: scene.purpose,
      title: labels[scene.purpose],
      subtitle: scene.purpose === "hook" ? "A coherent motion system from one brief" : undefined,
      visualGoal: scene.visualGoal,
      templateId: scene.templateId,
      start,
      end,
      motionIntensity: scene.purpose === "hook" ? "high" : scene.purpose === "cta" ? "low" : "medium",
      transition: scene.purpose === "hook" ? "cut" : "fade",
    };
  });
}

export function createMotionBlueprint(options: CreateMotionBlueprintOptions): MotionVideoBlueprint {
  const dimensions = DIMENSIONS[options.aspectRatio];
  const inputScenes = options.scenes?.length ? options.scenes : defaultScenes(options.brief, options.duration);
  const energy = Math.max(0, Math.min(1, options.energy ?? 0.86));
  const scenes = inputScenes.map((scene, index) => ({
    id: `S${String(index + 1).padStart(2, "0")}_${scene.purpose.toUpperCase()}`,
    purpose: scene.purpose,
    start: scene.start ?? 0,
    end: scene.end ?? options.duration,
    title: cleanText(scene.title, scene.purpose.toUpperCase()),
    subtitle: scene.subtitle ? cleanText(scene.subtitle, "") : undefined,
    visualGoal: cleanText(scene.visualGoal || "Advance the story visually", "Advance the story visually"),
    templateId: scene.templateId || DEFAULT_SCENES.find((item) => item.purpose === scene.purpose)?.templateId || "quote-card",
    transition: scene.transition || "fade",
    motionIntensity: scene.motionIntensity || "medium",
    beats: normalizeBeats(scene.beats, scene.start ?? 0, scene.end ?? options.duration, energy),
  }));
  const grammar: VisualGrammar = {
    easing: "easeOut",
    transition: "fade",
    motionIntensity: "medium",
    maxTextLines: 2,
    maxWordsPerGraphic: 9,
    titleScale: 1,
    bodyScale: 0.5,
    cornerRadius: 24,
  };
  return {
    version: 1,
    id: `motion_${Date.now().toString(36)}`,
    brief: cleanText(options.brief, "Coherent motion graphics video"),
    visualStyle: options.visualStyle || "japanese-pop",
    energy,
    compName: cleanText(options.compName, "Motion Graphics Video"),
    aspectRatio: options.aspectRatio,
    width: dimensions.width,
    height: dimensions.height,
    duration: options.duration,
    frameRate: options.frameRate,
    brand: options.brand,
    visualGrammar: grammar,
    scenes,
    qa: { requiredFrameCount: Math.max(5, scenes.length * 2), minimumScore: 0.8, requireHookAndCta: true },
    render: { format: options.renderFormat || "mp4", preset: options.renderPreset },
    createdAt: new Date().toISOString(),
  };
}

export function repairMotionBlueprint(input: MotionVideoBlueprint): MotionVideoBlueprint {
  const blueprint = structuredClone(input);
  blueprint.visualStyle = blueprint.visualStyle || "japanese-pop";
  blueprint.energy = Math.max(0, Math.min(1, Number(blueprint.energy ?? 0.86)));
  const available = new Set(MOTION_TEMPLATES.map((template) => template.id));
  let cursor = 0;
  blueprint.scenes = blueprint.scenes.map((scene, index) => {
    const remaining = blueprint.scenes.length - index;
    const requested = Math.max(0.75, scene.end - scene.start);
    const end = index === blueprint.scenes.length - 1
      ? blueprint.duration
      : Math.min(blueprint.duration - (remaining - 1) * 0.75, cursor + requested);
    const repaired = {
      ...scene,
      id: `S${String(index + 1).padStart(2, "0")}_${scene.purpose.toUpperCase()}`,
      start: Number(cursor.toFixed(3)),
      end: Number(Math.max(cursor + 0.75, end).toFixed(3)),
      templateId: available.has(scene.templateId) ? scene.templateId : "quote-card",
      title: scene.title.slice(0, 72),
      subtitle: scene.subtitle?.slice(0, 96),
      beats: normalizeBeats(scene.beats, cursor, Math.max(cursor + 0.75, end), blueprint.energy),
    };
    cursor = repaired.end;
    return repaired;
  });
  if (blueprint.scenes.length) blueprint.scenes[blueprint.scenes.length - 1]!.end = blueprint.duration;
  return blueprint;
}
