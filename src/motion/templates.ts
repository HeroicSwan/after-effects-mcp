export interface MotionTemplate {
  id: string;
  name: string;
  purpose: string;
  recommendedDuration: string;
  supports: ("16:9" | "9:16" | "1:1")[];
}

export const MOTION_TEMPLATES: MotionTemplate[] = [
  { id: "youtube-hook", name: "YouTube Hook", purpose: "Strong opening statement with kinetic emphasis", recommendedDuration: "3–8s", supports: ["16:9", "9:16", "1:1"] },
  { id: "lower-third", name: "Lower Third", purpose: "Speaker name, role, or source label", recommendedDuration: "4–7s", supports: ["16:9", "9:16"] },
  { id: "chapter-card", name: "Chapter Card", purpose: "Clean section transition and chapter title", recommendedDuration: "1–3s", supports: ["16:9", "9:16", "1:1"] },
  { id: "stat-callout", name: "Statistic Callout", purpose: "Large number with supporting label", recommendedDuration: "2–5s", supports: ["16:9", "9:16", "1:1"] },
  { id: "quote-card", name: "Quote Card", purpose: "Highlighted quote or key takeaway", recommendedDuration: "3–8s", supports: ["16:9", "9:16", "1:1"] },
  { id: "subscribe", name: "Subscribe Prompt", purpose: "Non-disruptive channel CTA", recommendedDuration: "2–4s", supports: ["16:9", "9:16"] },
  { id: "end-screen", name: "End Screen", purpose: "Final CTA and next-video layout", recommendedDuration: "8–20s", supports: ["16:9", "9:16"] },
];
