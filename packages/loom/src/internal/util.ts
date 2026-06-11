export { expandHome } from "@mcmaki/loom-capabilities";

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
