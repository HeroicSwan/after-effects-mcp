import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDataRoot, ensureDataDirs, instanceDir, getHostScriptsDir } from "../src/util/paths.js";

describe("paths", () => {
  const prev = process.env.AE_MCP_DATA_DIR;
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ae-mcp-test-"));
    process.env.AE_MCP_DATA_DIR = tmp;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.AE_MCP_DATA_DIR;
    else process.env.AE_MCP_DATA_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("uses AE_MCP_DATA_DIR override", () => {
    expect(getDataRoot()).toBe(tmp);
  });

  it("ensures data dirs", () => {
    ensureDataDirs();
    expect(fs.existsSync(path.join(tmp, "instances"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "previews"))).toBe(true);
  });

  it("rejects path traversal in instance id", () => {
    expect(() => instanceDir("../evil")).toThrow();
  });

  it("finds host-scripts directory", () => {
    const dir = getHostScriptsDir();
    expect(fs.existsSync(path.join(dir, "ae-mcp-bootstrap.jsx"))).toBe(true);
  });
});
