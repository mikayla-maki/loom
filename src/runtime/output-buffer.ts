import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Output discipline for terminal-style tools: a process can emit unbounded
// output, but the model context and a live UI both want a bounded, tail-biased
// view. OutputBuffer accumulates bytes in arrival order, retains only the tail
// in memory (so memory stays bounded under a firehose), counts the full totals,
// and optionally streams everything to a temp file so the complete output is
// recoverable when the in-context view is truncated.
//
// This is the embeddable half of a rich bash/terminal tool: pair it with
// `ToolContext.progress` for live streaming and `ToolDisplay`/`ToolResult` for
// the final, possibly-truncated view plus a `fullOutputPath` pointer.

export interface OutputBufferOptions {
  /** Keep at most this many trailing lines in the in-context view. */
  maxLines?: number;
  /** Keep at most this many trailing bytes in the in-context view. */
  maxBytes?: number;
  /**
   * Stream the complete output to a temp file. The path is reported on the
   * snapshot only when the view is actually truncated; `finalize()` removes
   * the file when nothing was dropped.
   */
  spillToFile?: boolean;
  /** Temp-file name prefix when `spillToFile` is set. */
  tempFilePrefix?: string;
}

export interface OutputSnapshot {
  /** Tail-biased text within the line/byte limits. */
  text: string;
  truncated: boolean;
  truncatedBy?: "lines" | "bytes";
  /** Total bytes appended across the whole run. */
  totalBytes: number;
  /** Total lines appended across the whole run (newline count + 1 if non-empty). */
  totalLines: number;
  /** Bytes shown in `text`. */
  shownBytes: number;
  /** Path to the complete output, present only when spilled AND truncated. */
  fullOutputPath?: string;
}

const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50_000;

export class OutputBuffer {
  private readonly maxLines: number;
  private readonly maxBytes: number;
  private readonly spillToFile: boolean;
  private readonly tempFilePrefix: string;

  // Retain a generous tail so the line/byte caps can always be satisfied from
  // memory without holding the whole stream.
  private readonly retainBytes: number;
  private tail = Buffer.alloc(0);
  private totalBytes = 0;
  private newlineCount = 0;
  private endsWithNewline = false;
  private frontTrimmed = false;

  private spillFd: number | null = null;
  private spillPath: string | null = null;
  private finalized = false;

  constructor(options: OutputBufferOptions = {}) {
    this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.spillToFile = options.spillToFile ?? false;
    this.tempFilePrefix = options.tempFilePrefix ?? "loom-output";
    this.retainBytes = this.maxBytes + 64 * 1024;
  }

  append(chunk: Buffer | string): void {
    if (this.finalized) throw new Error("OutputBuffer: append after finalize");
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    if (buf.length === 0) return;

    this.totalBytes += buf.length;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0a) this.newlineCount++;
    }
    this.endsWithNewline = buf[buf.length - 1] === 0x0a;

    if (this.spillToFile) this.writeSpill(buf);

    this.tail =
      this.tail.length === 0
        ? Buffer.from(buf)
        : Buffer.concat([this.tail, buf]);
    if (this.tail.length > this.retainBytes) {
      this.tail = this.tail.subarray(this.tail.length - this.retainBytes);
      this.frontTrimmed = true;
    }
  }

  get byteLength(): number {
    return this.totalBytes;
  }

  snapshot(): OutputSnapshot {
    // A trailing newline ends the final line rather than starting an empty
    // one: "a\nb\n" is two lines, not three.
    const totalLines =
      this.totalBytes === 0
        ? 0
        : this.endsWithNewline
          ? this.newlineCount
          : this.newlineCount + 1;
    let text = this.tail.toString("utf8");
    let truncatedBy: "lines" | "bytes" | undefined;

    // Apply the line cap to the retained tail, preserving a trailing newline.
    if (totalLines > this.maxLines) {
      const hasTrailingNewline = text.endsWith("\n");
      const body = hasTrailingNewline ? text.slice(0, -1) : text;
      const lines = body.split("\n");
      text =
        lines.slice(-this.maxLines).join("\n") +
        (hasTrailingNewline ? "\n" : "");
      truncatedBy = "lines";
    }

    // Then the byte cap, which wins when both fire.
    if (Buffer.byteLength(text, "utf8") > this.maxBytes) {
      const buf = Buffer.from(text, "utf8");
      text = buf.subarray(buf.length - this.maxBytes).toString("utf8");
      truncatedBy = "bytes";
    }

    const shownBytes = Buffer.byteLength(text, "utf8");
    // The tail itself may have been front-trimmed under a firehose even if the
    // line/byte caps didn't fire on the retained window.
    const truncated = shownBytes < this.totalBytes || this.frontTrimmed;
    if (truncated && !truncatedBy) truncatedBy = "bytes";

    return {
      text,
      truncated,
      ...(truncatedBy ? { truncatedBy } : {}),
      totalBytes: this.totalBytes,
      totalLines,
      shownBytes,
      ...(truncated && this.spillPath
        ? { fullOutputPath: this.spillPath }
        : {}),
    };
  }

  /**
   * Close the spill file and return the final snapshot. When the view was not
   * truncated, the spill file is removed (nothing was dropped, so the pointer
   * would be redundant).
   */
  async finalize(): Promise<OutputSnapshot> {
    const snap = this.snapshot();
    if (this.spillFd !== null) {
      try {
        fs.closeSync(this.spillFd);
      } catch {
        // already closed
      }
      this.spillFd = null;
    }
    if (this.spillPath !== null && !snap.truncated) {
      try {
        await fs.promises.unlink(this.spillPath);
      } catch {
        // best effort
      }
      this.spillPath = null;
    }
    this.finalized = true;
    return this.snapshot();
  }

  private writeSpill(buf: Buffer): void {
    if (this.spillFd === null) {
      const dir = fs.mkdtempSync(
        path.join(os.tmpdir(), `${this.tempFilePrefix}-`),
      );
      this.spillPath = path.join(dir, "output.log");
      this.spillFd = fs.openSync(this.spillPath, "w");
    }
    fs.writeSync(this.spillFd, buf);
  }
}
