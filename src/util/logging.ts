type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function currentLevel(): Level {
  const raw = (process.env.AE_MCP_LOG_LEVEL ?? "info").toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "info";
}

function shouldLog(level: Level): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel()];
}

/** MCP stdio servers must not write to stdout — log to stderr only. */
export const log = {
  debug(msg: string, extra?: unknown) {
    if (!shouldLog("debug")) return;
    write("debug", msg, extra);
  },
  info(msg: string, extra?: unknown) {
    if (!shouldLog("info")) return;
    write("info", msg, extra);
  },
  warn(msg: string, extra?: unknown) {
    if (!shouldLog("warn")) return;
    write("warn", msg, extra);
  },
  error(msg: string, extra?: unknown) {
    if (!shouldLog("error")) return;
    write("error", msg, extra);
  },
};

function write(level: Level, msg: string, extra?: unknown) {
  const line =
    extra === undefined
      ? `[ae-mcp] ${level}: ${msg}`
      : `[ae-mcp] ${level}: ${msg} ${safeJson(extra)}`;
  process.stderr.write(line + "\n");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
