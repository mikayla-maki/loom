// There is no --no-colors flag; invokers unset COLORTERM to disable styling.
export function wantsColor(): boolean {
  const v = process.env.COLORTERM;
  return typeof v === "string" && v.length > 0;
}
