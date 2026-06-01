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
  plain?: boolean;
}

export function renderMarkdown(src: string, opts: RenderOptions = {}): string {
  const lines = src.split("\n");
  const out: string[] = [];
  let inFence = false;
  for (const raw of lines) {
    if (/^```/.test(raw)) {
      inFence = !inFence;
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

export function renderLine(line: string, opts: RenderOptions = {}): string {
  if (opts.plain) return stripMd(line);
  let m = /^(#{1,6})\s+(.*)$/.exec(line);
  if (m) {
    const level = m[1]!.length;
    const text = inlineMd(m[2]!, opts);
    const color =
      level === 1 ? ANSI.magenta : level === 2 ? ANSI.cyan : ANSI.yellow;
    return `${color}${ANSI.bold}${text}${ANSI.reset}`;
  }
  m = /^>\s?(.*)$/.exec(line);
  if (m) {
    return `${ANSI.gray}│${ANSI.reset} ${inlineMd(m[1]!, opts)}`;
  }
  m = /^(\s*)[-*]\s+(.*)$/.exec(line);
  if (m) {
    return `${m[1]!}${ANSI.cyan}•${ANSI.reset} ${inlineMd(m[2]!, opts)}`;
  }
  m = /^(\s*\d+\.\s+)(.*)$/.exec(line);
  if (m) {
    return `${m[1]!}${inlineMd(m[2]!, opts)}`;
  }
  return inlineMd(line, opts);
}

function inlineMd(s: string, opts: RenderOptions): string {
  if (opts.plain) return stripMd(s);
  s = s.replace(/`([^`\n]+)`/g, `${ANSI.inverse}$1${ANSI.reset}`);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, `${ANSI.bold}$1${ANSI.reset}`);
  s = s.replace(/__([^_\n]+)__/g, `${ANSI.bold}$1${ANSI.reset}`);
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

export const ansi = ANSI;
