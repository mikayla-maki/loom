import { ansi } from "./markdown.js";

type DelimChar = "*" | "_" | "`";

export interface RenderOptions {
  plain?: boolean;
}

export class StreamingMarkdownRenderer {
  private bold = false;
  private boldDelim: DelimChar | null = null;
  private italic = false;
  private italicDelim: DelimChar | null = null;
  private code = false;

  private fence = false;
  private atLineStart = true;
  private lineStartBuf = "";
  private lineSuffixReset = "";

  private inlinePending = "";

  constructor(private readonly opts: RenderOptions = {}) {}

  feed(chunk: string): string {
    if (this.opts.plain) {
      return this.feedPlain(chunk);
    }
    let out = "";
    for (let i = 0; i < chunk.length; i++) {
      out += this.consume(chunk.charAt(i));
    }
    return out;
  }

  flush(): string {
    let out = "";
    if (this.lineStartBuf) {
      out += this.applyInlineStyles(this.lineStartBuf);
      this.lineStartBuf = "";
    }
    out += this.closePendingOnBoundary();
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

  private closePendingOnBoundary(): string {
    if (!this.inlinePending) return "";
    const p = this.inlinePending;
    this.inlinePending = "";
    if (p === "`" && this.code) {
      this.code = false;
      return ansi.reset + this.reapplyOpenStyles();
    }
    if ((p === "*" || p === "_") && this.italic && this.italicDelim === p) {
      this.italic = false;
      this.italicDelim = null;
      return ansi.reset + this.reapplyOpenStyles();
    }
    return this.applyInlineStyles(p);
  }

  private feedPlain(chunk: string): string {
    let out = "";
    for (const ch of chunk) {
      if (ch === "*" || ch === "_" || ch === "`") continue;
      out += ch;
    }
    return out;
  }

  private consume(ch: string): string {
    if (ch === "\n") {
      let out = "";
      if (this.lineStartBuf) {
        out += this.applyInlineStyles(this.lineStartBuf);
        this.lineStartBuf = "";
      }
      out += this.closePendingOnBoundary();
      if (this.lineSuffixReset) {
        out += ansi.reset;
        this.lineSuffixReset = "";
      }
      out += "\n";
      this.atLineStart = true;
      return out;
    }

    if (this.fence) {
      if (this.atLineStart) {
        this.lineStartBuf += ch;
        if (this.lineStartBuf === "```") {
          this.fence = false;
          this.atLineStart = false;
          this.lineStartBuf = "";
          return "";
        }
        if (this.lineStartBuf.length >= 3 && this.lineStartBuf !== "```") {
          const flushed = this.lineStartBuf;
          this.lineStartBuf = "";
          this.atLineStart = false;
          return ansi.dim + "    " + flushed + ansi.reset;
        }
        return "";
      }
      return ch;
    }

    if (this.atLineStart) {
      const decision = this.tryClassifyLineStart(ch);
      if (decision === "buffer") return "";
      if (decision === "committed") return "";
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
    const p: string = this.inlinePending;

    if (p === "``") {
      this.inlinePending = "";
      if (ch === "`") {
        return this.applyInlineStyles("```");
      }
      return this.applyInlineStyles("``") + this.consumeInline(ch);
    }

    if (ch === p) {
      this.inlinePending = "";
      if (p === "`") {
        this.inlinePending = "``";
        return "";
      }
      return this.toggleBold(p as DelimChar);
    }

    if (p === "*" || p === "_") {
      this.inlinePending = "";
      const result = this.toggleItalic(p);
      return result + this.consumeInline(ch);
    }

    if (p === "`") {
      this.inlinePending = "";
      return this.toggleCode() + this.consumeInline(ch);
    }

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

  private reapplyOpenStyles(): string {
    let out = "";
    if (this.lineSuffixReset) out += this.lineSuffixReset;
    if (this.bold) out += ansi.bold;
    if (this.italic) out += ansi.italic;
    if (this.code) out += ansi.inverse;
    return out;
  }

  private applyInlineStyles(chunk: string): string {
    const prefix = this.reapplyOpenStyles();
    return prefix ? prefix + chunk : chunk;
  }

  private tryClassifyLineStart(ch: string): "buffer" | "committed" | string {
    if (this.lineStartBuf === "") {
      const isBlockPrefix =
        ch === "#" ||
        ch === ">" ||
        ch === "-" ||
        ch === "`" ||
        ch === " " ||
        ch === "\t";
      if (!isBlockPrefix) {
        this.atLineStart = false;
        return this.consumeInline(ch);
      }
      this.lineStartBuf = ch;
      return "buffer";
    }

    this.lineStartBuf += ch;
    const buf = this.lineStartBuf;

    if (buf === "``") return "buffer";
    if (buf === "```") {
      this.fence = true;
      this.atLineStart = false;
      this.lineStartBuf = "";
      return "committed";
    }
    if (buf.length === 2 && buf[0] === "`" && buf[1] !== "`") {
      this.atLineStart = false;
      this.lineStartBuf = "";
      const opened = this.toggleCode();
      return opened + this.consumeInline(ch);
    }
    if (
      buf.length === 3 &&
      buf[0] === "`" &&
      buf[1] === "`" &&
      buf[2] !== "`"
    ) {
      this.atLineStart = false;
      this.lineStartBuf = "";
      return this.applyInlineStyles("``") + this.consumeInline(ch);
    }

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
    if (/^#{1,6}$/.test(buf)) return "buffer";
    if (/^#{1,6}[^ ]/.test(buf)) {
      this.atLineStart = false;
      const prefix = buf.slice(0, -1);
      this.lineStartBuf = "";
      return this.applyInlineStyles(prefix) + this.consumeInline(ch);
    }

    if (buf === "> ") {
      this.atLineStart = false;
      this.lineStartBuf = "";
      this.lineSuffixReset = ansi.gray;
      return ansi.gray + "│ " + ansi.reset + this.lineSuffixReset;
    }
    if (buf.length >= 2 && buf[0] === ">" && buf[1] !== " ") {
      this.atLineStart = false;
      this.lineStartBuf = "";
      return this.applyInlineStyles(">") + this.consumeInline(ch);
    }

    const bulletMatch = /^(\s*)- $/.exec(buf);
    if (bulletMatch) {
      this.atLineStart = false;
      this.lineStartBuf = "";
      return `${bulletMatch[1]}${ansi.cyan}•${ansi.reset} `;
    }
    if (/^\s*-$/.test(buf)) return "buffer";
    if (/^\s*-[^ ]$/.test(buf)) {
      const indent = /^(\s*)/.exec(buf)?.[1] ?? "";
      this.atLineStart = false;
      this.lineStartBuf = "";
      return indent + "-" + this.consumeInline(ch);
    }

    if (/^\s+$/.test(buf)) return "buffer";

    this.atLineStart = false;
    const flush = buf.slice(0, -1);
    this.lineStartBuf = "";
    let out = "";
    if (flush) out += this.applyInlineStyles(flush);
    out += this.consumeInline(ch);
    return out;
  }
}
