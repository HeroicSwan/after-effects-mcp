import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const name = process.argv[2];
let args = {};
if (process.argv[3]?.startsWith("@")) {
  const fileValue = fs.readFileSync(path.resolve(process.argv[3].slice(1)), "utf8");
  args = JSON.parse(fileValue);
} else if (process.argv[3]?.startsWith("{")) {
  args = JSON.parse(process.argv[3]);
} else {
  for (const pair of process.argv.slice(3)) {
    const [key, ...parts] = pair.split("=");
    const raw = parts.join("=");
    args[key] =
      raw.startsWith("@") ? (() => { const value = fs.readFileSync(path.resolve(raw.slice(1)), "utf8"); try { return JSON.parse(value); } catch { return value; } })() :
      raw === "true" ? true :
      raw === "false" ? false :
      raw !== "" && !Number.isNaN(Number(raw)) ? Number(raw) :
      raw;
  }
}
const client = new Client({ name: "ae-mcp-local-runner", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "dist", "index.js"), "serve"],
  stderr: "pipe",
});

await client.connect(transport);
const result = await client.callTool({ name, arguments: args });
for (const item of result.content || []) {
  if (item.type === "image" && item.data) item.data = `<base64 image omitted: ${item.data.length} chars>`;
}
process.stdout.write(JSON.stringify(result, null, 2));
await client.close();
