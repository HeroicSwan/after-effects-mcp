import fs from "node:fs";
import path from "node:path";
import { ensureDataDirs, getDataRoot } from "../util/paths.js";

export type ReviewDecision = "pending" | "approved" | "rejected";
export interface ReviewItem {
  id: string;
  createdAt: string;
  comp: string;
  planPath?: string;
  frames: { time: number; path: string; bytes?: number }[];
  render?: { path: string; format: string; bytes?: number };
  decision: ReviewDecision;
  notes?: string;
}

function reviewPath(): string { return path.join(getDataRoot(), "reviews.json"); }
function readReviews(): ReviewItem[] {
  ensureDataDirs();
  const p = reviewPath();
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, "utf8")) as ReviewItem[]; } catch { return []; }
}
function writeReviews(items: ReviewItem[]): void { ensureDataDirs(); fs.writeFileSync(reviewPath(), JSON.stringify(items, null, 2), "utf8"); }

export function createReview(item: Omit<ReviewItem, "id" | "createdAt" | "decision">): ReviewItem {
  const review: ReviewItem = { ...item, id: `review_${Date.now().toString(36)}`, createdAt: new Date().toISOString(), decision: "pending" };
  writeReviews([review, ...readReviews()]);
  return review;
}
export function listReviews(): ReviewItem[] { return readReviews(); }
export function decideReview(id: string, decision: Exclude<ReviewDecision, "pending">, notes?: string): ReviewItem {
  const items = readReviews();
  const item = items.find((r) => r.id === id);
  if (!item) throw new Error(`Review not found: ${id}`);
  item.decision = decision;
  item.notes = notes;
  writeReviews(items);
  return item;
}
