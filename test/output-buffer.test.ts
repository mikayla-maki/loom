import * as fs from "node:fs";
import { describe, expect, it } from "vitest";

import { OutputBuffer } from "../src/runtime/output-buffer.js";

describe("OutputBuffer", () => {
  it("passes small output through untouched", async () => {
    const buf = new OutputBuffer();
    buf.append("hello\nworld\n");
    const snap = await buf.finalize();
    expect(snap.text).toBe("hello\nworld\n");
    expect(snap.truncated).toBe(false);
    expect(snap.totalBytes).toBe(12);
    expect(snap.totalLines).toBe(2); // "hello", "world"
    expect(snap.fullOutputPath).toBeUndefined();
  });

  it("truncates to the trailing lines under the line cap", async () => {
    const buf = new OutputBuffer({ maxLines: 3 });
    for (let i = 1; i <= 10; i++) buf.append(`line ${i}\n`);
    const snap = buf.snapshot();
    expect(snap.truncated).toBe(true);
    expect(snap.truncatedBy).toBe("lines");
    // Last 3 content lines, trailing newline preserved.
    expect(snap.text).toBe("line 8\nline 9\nline 10\n");
    expect(snap.totalLines).toBe(10);
  });

  it("truncates to the trailing bytes under the byte cap", async () => {
    const buf = new OutputBuffer({ maxBytes: 10, maxLines: 1000 });
    buf.append("abcdefghijklmnopqrstuvwxyz");
    const snap = buf.snapshot();
    expect(snap.truncated).toBe(true);
    expect(snap.truncatedBy).toBe("bytes");
    expect(snap.text).toBe("qrstuvwxyz");
    expect(snap.shownBytes).toBe(10);
    expect(snap.totalBytes).toBe(26);
  });

  it("spills the full output to a temp file when truncated, and reports the path", async () => {
    const buf = new OutputBuffer({
      maxBytes: 8,
      spillToFile: true,
      tempFilePrefix: "loom-test",
    });
    buf.append("0123456789abcdef");
    const snap = await buf.finalize();
    expect(snap.truncated).toBe(true);
    expect(snap.fullOutputPath).toBeDefined();
    const full = fs.readFileSync(snap.fullOutputPath!, "utf8");
    expect(full).toBe("0123456789abcdef");
    fs.rmSync(snap.fullOutputPath!, { force: true });
  });

  it("removes the spill file when nothing was dropped", async () => {
    const buf = new OutputBuffer({
      spillToFile: true,
      tempFilePrefix: "loom-test",
    });
    buf.append("short output\n");
    const snap = await buf.finalize();
    expect(snap.truncated).toBe(false);
    expect(snap.fullOutputPath).toBeUndefined();
  });

  it("keeps memory bounded under a firehose while counting full totals", async () => {
    const buf = new OutputBuffer({ maxBytes: 1024, maxLines: 100000 });
    const oneKb = `${"x".repeat(1023)}\n`;
    for (let i = 0; i < 5000; i++) buf.append(oneKb); // ~5 MB total
    const snap = buf.snapshot();
    expect(snap.totalBytes).toBe(5000 * 1024);
    expect(snap.truncated).toBe(true);
    // The retained, shown view stays within the byte cap.
    expect(snap.shownBytes).toBeLessThanOrEqual(1024);
  });
});
