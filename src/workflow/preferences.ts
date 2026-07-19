import fs from "node:fs";
import path from "node:path";
import { ensureDataDirs, getDataRoot } from "../util/paths.js";

export type WorkflowMode = "autonomous" | "approval";
export type EditMode = "clean" | "retention" | "story";

export interface BrandConfig {
  primaryColor: [number, number, number];
  secondaryColor: [number, number, number];
  accentColor: [number, number, number];
  fontFamily: string;
  captionFontSize: number;
  safeMargin: number;
  aspectRatio: "16:9" | "9:16" | "1:1";
}

export interface WorkflowPreferences {
  workflowMode: WorkflowMode;
  editMode: EditMode;
  brand: BrandConfig;
}

const DEFAULTS: WorkflowPreferences = {
  workflowMode: "approval",
  editMode: "clean",
  brand: {
    primaryColor: [0.08, 0.08, 0.1],
    secondaryColor: [1, 1, 1],
    accentColor: [0.2, 0.65, 1],
    fontFamily: "Arial",
    captionFontSize: 54,
    safeMargin: 100,
    aspectRatio: "16:9",
  },
};

function preferencesPath(): string {
  return path.join(getDataRoot(), "preferences.json");
}

export function getWorkflowPreferences(): WorkflowPreferences {
  ensureDataDirs();
  const file = preferencesPath();
  if (!fs.existsSync(file)) return DEFAULTS;
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<WorkflowPreferences>;
    return {
      ...DEFAULTS,
      ...value,
      brand: { ...DEFAULTS.brand, ...(value.brand || {}) },
    };
  } catch {
    return DEFAULTS;
  }
}

export function saveWorkflowPreferences(next: Partial<WorkflowPreferences>): WorkflowPreferences {
  const current = getWorkflowPreferences();
  const merged: WorkflowPreferences = {
    ...current,
    ...next,
    brand: { ...current.brand, ...(next.brand || {}) },
  };
  ensureDataDirs();
  fs.writeFileSync(preferencesPath(), JSON.stringify(merged, null, 2), "utf8");
  return merged;
}
