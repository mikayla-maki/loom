/**
 * Streaming markdown renderer.
 *
 * Token-by-token state machine. Unlike `markdown.ts`'s `renderMarkdown`
 * (which expects a complete string and renders line-by-line), this
 * processes input incrementally and emits ANSI codes as soon as
 * delimiters are recognised. Bold/italic/code styles flip on at the
 * opening delimiter, off at the closing one — same shape as ANSI:
 * `\x1b[1m bold \x1b[0m` corresponds to `**bold**`.
 *
 * Design:
 *   - Inline constructs (bold, italic, inline-code) emit immediately.
 *     Delimiters never appear in the output.
 *   - Line-start constructs (headings, blockquotes, bullet lists,
 *     code fences) are detected by buffering a small prefix at line
 *     start until we know which one we have. Worst case ~5 chars of
 *     latency at the very start of a line.
 *   - Code fences (```) toggle a mode where inline rendering is
 *     skipped and content is dimmed; the fence delimiter line itself
 *     is dropped from output.
 *
 * Supported subset (matches markdown.ts):
 *   **bold** / __bold__
 *   *italic* / _italic_
 *   `code`
 *   # / ## / ### / .. / ###### headings
 *   > blockquote
 *   - / * bullet list
 *   ```fence```  (multi-line)
 *   1. ordered list (passthrough; numbers stay)
 */

import { ansi } from "./markdown.js";

type DelimChar = "*" | "_" | "`";

export interface RenderOptions {
  plain?: boolean;
}

export class StreamingMarkdownRenderer {
  // Inline style state.
  private bold = false;
  private boldDelim: DelimChar | null = null;
  private italic = false;
  private italicDelim: DelimChar | null = null;
  private code = false;

  // Block-level state.
  private fence = false;
  private atLineStart = true;
  /** Buffer of pending chars at line-start, until we know what kind of line this is. */
  private lineStartBuf = "";
  /** ANSI prefix to apply for the rest of the current line (heading color, blockquote bar). */
  private lineSuffixReset = "";

  /**
   * One char of inline-delimiter buffering: when we see `*` or `_` or
   * `` ` ``, we wait for the next char to disambiguate
   * `*` (italic open) vs `**` (bold open) vs ``` ``` ``` (fence vs inline code).
   */
  private inlinePending = "";

  constructor(private readonly opts: RenderOptions = {}) {}

  /** Feed a chunk of markdown text; return the styled output. */
  feed(chunk: string): string {
    if (this.opts.plain) {
      // Strip markdown to plain text streamingly. Cheap approach: pass
      // through, the tokenizer below skips ANSI when plain, but we
      // still want the structural collapse. Simpler: plain mode just
      // passes through the raw input minus delimiters.
      return this.feedPlain(chunk);
    }
    let out = "";
    for (let i = 0; i < chunk.length; i++) {
      out += this.consume(chunk.charAt(i));
    }
    return out;
  }

  /**
   * Close any open styles and flush pending buffers. Call at the end
   * of a stream of related chunks (e.g. on `agent_message_chunk`'s
   * boundary event) to make sure ANSI state doesn't leak.
   */
  flush(): string {
    let out = "";
    if (this.lineStartBuf) {
      // Emit the buffered line-start chars as plain — never made it
      // to a block-level decision.
      out += this.applyInlineStyles(this.lineStartBuf);
      this.lineStartBuf = "";
    }
    if (this.inlinePending) {
      out += this.applyInlineStyles(this.inlinePending);
      this.inlinePending = "";
    }
    if (this.lineSuffixReset) {
      out += ansi.reset;
      this.lineSuffixReset = "";
    }
    if (this.bold || this.italic || this.code) {
      out += ansi.reset;
      this.bold = this.italic = this.code = false;
      this.boldDelim = this.italicDelim = null;
    }
    return out;
  }

  // ───────────────────────── plain mode ──────────────────────────

  private feedPlain(chunk: string): string {
    // Strip the most common delimiters; keep code fence and inline
    // code passthrough since their content matters.
    let out = "";
    for (const ch of chunk) {
      if (ch === "*" || ch === "_" || ch === "`") continue;
      out += ch;
    }
    return out;
  }

  // ───────────────────────── core consume ─────────────────────────

  private consume(ch: string): string {
    // Newline: end any line-suffix style, reset to line-start state.
    if (ch === "\n") {
      let out = "";
      // Flush any incomplete line-start buffer as literal.
      if (this.lineStartBuf) {
        out += this.applyInlineStyles(this.lineStartBuf);
        this.lineStartBuf = "";
      }
      if (this.inlinePending) {
        out += this.applyInlineStyles(this.inlinePending);
        this.inlinePending = "";
      }
      if (this.lineSuffixReset) {
        out += ansi.reset;
        this.lineSuffixReset = "";
      }
      out += "\n";
      this.atLineStart = true;
      return out;
    }

    // Inside a fenced code block: dump everything dim, looking only
    // for the closing fence at line start.
    if (this.fence) {
      if (this.atLineStart) {
        this.lineStartBuf += ch;
        // Detect closing ``` at line start.
        if (this.lineStartBuf === "```") {
          // Closing fence — drop the delimiter line entirely.
          this.fence = false;
          this.atLineStart = false; // we'll see \n next
          this.lineStartBuf = "";
          return ""; // nothing to write; the \n that follows resets state
        }
        if (this.lineStartBuf.length >= 3 && this.lineStartBuf !== "```") {
          // Not a closing fence — flush as fence body
          const flushed = this.lineStartBuf;
          this.lineStartBuf = "";
          this.atLineStart = false;
          return ansi.dim + "    " + flushed + ansi.reset;
        }
        return "";
      }
      // Mid-fence content: just dim it. Caller wraps each line; we
      // already injected the dim+indent at line start, so for now
      // emit raw — the line-start path will indent fresh on \n.
      return ch;
    }

    // Line-start: buffer chars until we recognise the line type.
    if (this.atLineStart) {
      const decision = this.tryClassifyLineStart(ch);
      if (decision === "buffer") return "";
      if (decision === "committed") return "";
      // decision is the styled-prefix string; line-start mode is
      // exited inside tryClassifyLineStart. The current `ch` was
      // consumed there too.
      return decision;
    }

    return this.consumeInline(ch);
  }

  private consumeInline(ch: string): string {
    if (this.inlinePending) {
      return this.disambiguatePending(ch);
    }
    if (ch === "*" || ch === "_" || ch === "`") {
      this.inlinePending = ch;
      return "";
    }
    return ch;
  }

  private disambiguatePending(ch: string): string {
    // `inlinePending` is one of: "*", "_", "`", or "``". Use a string
    // type so all four cases are reachable.
    const p: string = this.inlinePending;

    // Two-backtick state: we saw ``; the next char tells us if it's
    // ``` (mid-line, treat as literal) or `` followed by something
    // (empty inline code span).
    if (p === "``") {
      this.inlinePending = "";
      if (ch === "`") {
        return this.applyInlineStyles("```");
      }
      return this.applyInlineStyles("``") + this.consumeInline(ch);
    }

    // Same-char repeat → bold/double-backtick territory
    if (ch === p) {
      this.inlinePending = "";
      if (p === "`") {
        // We have ``; could be start of ``` (fence) or empty inline code.
        // Buffer one more char to tell.
        this.inlinePending = "``";
        return "";
      }
      // ** or __ → bold toggle
      return this.toggleBold(p as DelimChar);
    }

    // p is `*` or `_` followed by non-same → italic
    if (p === "*" || p === "_") {
      this.inlinePending = "";
      const result = this.toggleItalic(p);
      return result + this.consumeInline(ch);
    }

    // p is a single backtick followed by non-backtick → inline code toggle
    if (p === "`") {
      this.inlinePending = "";
      return this.toggleCode() + this.consumeInline(ch);
    }

    // Shouldn't reach here.
    this.inlinePending = "";
    return p + ch;
  }

  private toggleBold(delim: DelimChar): string {
    if (this.bold && this.boldDelim === delim) {
      this.bold = false;
      this.boldDelim = null;
      return ansi.reset + this.reapplyOpenStyles();
    }
    this.bold = true;
    this.boldDelim = delim;
    return ansi.bold;
  }

  private toggleItalic(delim: DelimChar): string {
    if (this.italic && this.italicDelim === delim) {
      this.italic = false;
      this.italicDelim = null;
      return ansi.reset + this.reapplyOpenStyles();
    }
    this.italic = true;
    this.italicDelim = delim;
    return ansi.italic;
  }

  private toggleCode(): string {
    if (this.code) {
      this.code = false;
      return ansi.reset + this.reapplyOpenStyles();
    }
    this.code = true;
    return ansi.inverse;
  }

  /**
   * After emitting a reset (because we closed one style), other
   * still-open styles need to be re-applied so the rendering stays
   * consistent. Plus the line-suffix style (heading colour, etc.).
   */
  private reapplyOpenStyles(): string {
    let out = "";
    if (this.lineSuffixReset) out += this.lineSuffixReset;
    if (this.bold) out += ansi.bold;
    if (this.italic) out += ansi.italic;
    if (this.code) out += ansi.inverse;
    return out;
  }

  /** Apply the current open inline styles to a literal chunk and emit it. */
  private applyInlineStyles(chunk: string): string {
    const prefix = this.reapplyOpenStyles();
    return prefix ? prefix + chunk : chunk;
  }

  // ─────────────────────── line-start dispatch ─────────────────────

  /**
   * Returns:
   *   "buffer"     — keep buffering, no output yet
   *   "committed"  — line type decided, output suppressed (delimiter consumed)
   *   string       — line type decided; here's the styled prefix to emit;
   *                  inline mode is entered for the rest of the line
   */
  private tryClassifyLineStart(ch: string): "buffer" | "committed" | string {
    this.lineStartBuf += ch;
    const buf = this.lineStartBuf;

    // Code fence at line start: ```
    if (buf === "`" || buf === "``") return "buffer";
    if (buf === "```") {
      this.fence = true;
      this.atLineStart = false;
      this.lineStartBuf = "";
      return "committed"; // drop the fence delimiter line
    }
    if (buf === "``" + ch && buf.length === 3 && ch !== "`") {
      // Two backticks then non-backtick: was empty inline code, pass through.
      this.atLineStart = false;
      this.lineStartBuf = "";
      return this.applyInlineStyles("``") + this.consumeInline(ch);
    }

    // Heading: # ... ###### + space
    const headingMatch = /^(#{1,6}) $/.exec(buf);
    if (headingMatch) {
      this.atLineStart = false;
      this.lineStartBuf = "";
      const level = headingMatch[1]!.length;
      const color =
        level === 1 ? ansi.magenta : level === 2 ? ansi.cyan : ansi.yellow;
      this.lineSuffixReset = color + ansi.bold;
      return color + ansi.bold;
    }
    // Heading hashes still being collected
    if (/^#{1,6}$/.test(buf)) return "buffer";
    // Hashes followed by non-space → not a heading; flush as literal
    if (/^#{1,6}[^ ]/.test(buf)) {
      this.atLineStart = false;
      const flush = buf;
      this.lineStartBuf = "";
      return this.applyInlineStyles(flush);
    }

    // Blockquote: > or > <space>
    if (buf === ">") return "buffer";
    if (buf === "> ") {
      this.atLineStart = false;
      this.lineStartBuf = "";
      this.lineSuffixReset = ansi.gray;
      return ansi.gray + "│ " + ansi.reset + this.lineSuffixReset;
    }
    if (buf === ">" + ch && ch !== " ") {
      this.atLineStart = false;
      this.lineStartBuf = "";
      return this.applyInlineStyles(">") + this.consumeInline(ch);
    }

    // Bullet: `- ` or `* ` (with optional leading whitespace)
    const bulletMatch = /^(\s*)([-*]) $/.exec(buf);
    if (bulletMatch) {
      this.atLineStart = false;
      this.lineStartBuf = "";
      return `${bulletMatch[1]}${ansi.cyan}•${ansi.reset} `;
    }
    if (/^\s*[-*]$/.test(buf)) return "buffer";
    if (/^\s+$/.test(buf)) return "buffer";

    // Anything else: this is a normal line. Flush the buffer literally
    // and switch to inline mode.
    this.atLineStart = false;
    const flush = buf.slice(0, -1);
    this.lineStartBuf = "";
    let out = "";
    if (flush) out += this.applyInlineStyles(flush);
    out += this.consumeInline(ch);
    return out;
  }
}
