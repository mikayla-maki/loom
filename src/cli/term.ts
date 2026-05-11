/**
 * Terminal capability detection — single source of truth for whether
 * the CLI emits ANSI styling.
 *
 * Policy: colours are enabled iff `COLORTERM` is set to a non-empty
 * value. There is no `--no-colors` flag — invokers that want plain
 * output unset `COLORTERM` (or pipe through something that strips it).
 * This keeps the CLI's behaviour predictable across REPL, ACP, and
 * subprocess invocations without per-command flag plumbing.
 */

export function wantsColor(): boolean {
  const v = process.env.COLORTERM;
  return typeof v === "string" && v.length > 0;
}
