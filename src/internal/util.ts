import * as os from "node:os";
import * as path from "node:path";

export function assertNever(value: never): never {
  throw new Error(
    `assertNever: unexpected value ${JSON.stringify(value)} (this should be unreachable)`,
  );
}

export interface Ref<T> {
  current: T;
}

export function ref<T>(initial: T): Ref<T> {
  return { current: initial };
}

export function stripProvider<T extends { provider?: unknown }>(
  obj: T,
): Omit<T, "provider"> {
  const { provider: _p, ...rest } = obj;
  void _p;
  return rest;
}

export function expandHome(p: string): string {
  if (p === "~") return os.homedir() || p;
  if (p.startsWith("~/") || p.startsWith("~" + path.sep)) {
    const home = os.homedir();
    if (!home) return p;
    return path.join(home, p.slice(2));
  }
  return p;
}
