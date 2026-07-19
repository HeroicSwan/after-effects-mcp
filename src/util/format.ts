export function jsonText(data: unknown, space = 2): string {
  return JSON.stringify(data, null, space);
}

export function toolError(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && "message" in err) {
    const e = err as { code: string; message: string; hint?: string };
    const parts = [`[${e.code}] ${e.message}`];
    if (e.hint) parts.push(`Hint: ${e.hint}`);
    return parts.join("\n");
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
