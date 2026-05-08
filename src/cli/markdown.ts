/**
 * Tiny terminal markdown renderer.
 *
 * Handles the subset that's worth rendering inline:
 *   - # / ## / ### headings        (bold + colored)
 *   - **bold** / __bold__          (ANSI bold)
 *   - *italic* / _italic_          (ANSI italic — many terms render dim)
 *   - `inline code`                (ANSI inverse for legibility)
 *   - ``` fenced blocks            (indent + dim)
 *   - - / * bullets                (replaced with •)
 *   - 1. ordered lists             (left as-is)
 *   - > blockquotes                (vertical bar prefix)
 *
 * Streamed input is fine: render() is pure (string in, string out). For
 * incremental output we render line-by-line; partial fences pass through
 * with a best-effort indent.
 */

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  inverse: "\x1b[7m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
};

export interface RenderOptions {
  /** Disable ANSI styling (e.g. when stdout isn't a TTY). */
  plain?: boolean;
}

/** Render a complete markdown string into a styled terminal string. */
export function renderMarkdown(src: string, opts: RenderOptions = {}): string {
  const lines = src.split("\n");
  const out: string[] = [];
  let inFence = false;
  for (const raw of lines) {
    if (/^```/.test(raw)) {
      inFence = !inFence;
      // Drop the fence delimiter from the rendered output.
      continue;
    }
    if (inFence) {
      out.push(
        opts.plain ? `    ${raw}` : `${ANSI.dim}    ${raw}${ANSI.reset}`,
      );
      continue;
    }
    out.push(renderLine(raw, opts));
  }
  return out.join("\n");
}

/** Render a single line. Used for incremental output. */
export function renderLine(line: string, opts: RenderOptions = {}): string {
  if (opts.plain) return stripMd(line);
  // Headings
  let m = /^(#{1,6})\s+(.*)$/.exec(line);
  if (m) {
    const level = m[1]!.length;
    const text = inlineMd(m[2]!, opts);
    const color =
      level === 1 ? ANSI.magenta : level === 2 ? ANSI.cyan : ANSI.yellow;
    return `${color}${ANSI.bold}${text}${ANSI.reset}`;
  }
  // Blockquote
  m = /^>\s?(.*)$/.exec(line);
  if (m) {
    return `${ANSI.gray}│${ANSI.reset} ${inlineMd(m[1]!, opts)}`;
  }
  // Bullet list
  m = /^(\s*)[-*]\s+(.*)$/.exec(line);
  if (m) {
    return `${m[1]!}${ANSI.cyan}•${ANSI.reset} ${inlineMd(m[2]!, opts)}`;
  }
  // Numbered list — leave the prefix, render the body
  m = /^(\s*\d+\.\s+)(.*)$/.exec(line);
  if (m) {
    return `${m[1]!}${inlineMd(m[2]!, opts)}`;
  }
  return inlineMd(line, opts);
}

function inlineMd(s: string, opts: RenderOptions): string {
  if (opts.plain) return stripMd(s);
  // Inline code: `…`
  s = s.replace(/`([^`\n]+)`/g, `${ANSI.inverse}$1${ANSI.reset}`);
  // Bold: **…** or __…__
  s = s.replace(/\*\*([^*\n]+)\*\*/g, `${ANSI.bold}$1${ANSI.reset}`);
  s = s.replace(/__([^_\n]+)__/g, `${ANSI.bold}$1${ANSI.reset}`);
  // Italic: *…* or _…_  (avoid matching ** or __)
  s = s.replace(
    /(^|[^*])\*([^*\n]+)\*(?!\*)/g,
    `$1${ANSI.italic}$2${ANSI.reset}`,
  );
  s = s.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, `$1${ANSI.italic}$2${ANSI.reset}`);
  return s;
}

function stripMd(s: string): string {
  return s
    .replace(/^#{1,6}\s+/, "")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1$2")
    .replace(/(^|[^_])_([^_\n]+)_(?!_)/g, "$1$2");
}

/** ANSI helper used by callers for non-markdown chrome (banners, etc.). */
export const ansi = ANSI;
