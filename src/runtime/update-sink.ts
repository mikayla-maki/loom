import type { SessionUpdate } from "../types/acp.js";

interface Subscription {
  queue: SessionUpdate[];
  resolveNext: ((value: IteratorResult<SessionUpdate>) => void) | null;
  closed: boolean;
  cap: number;
}

export class UpdateSink {
  private readonly subs = new Set<Subscription>();
  private closed = false;

  emit(update: SessionUpdate): void {
    if (this.closed) return;
    for (const sub of this.subs) {
      if (sub.closed) continue;
      if (sub.resolveNext) {
        const r = sub.resolveNext;
        sub.resolveNext = null;
        r({ value: update, done: false });
      } else {
        sub.queue.push(update);
        if (sub.queue.length > sub.cap) sub.queue.shift();
      }
    }
  }

  close(): void {
    this.closed = true;
    for (const sub of this.subs) {
      sub.closed = true;
      if (sub.resolveNext) {
        sub.resolveNext({ value: undefined, done: true });
        sub.resolveNext = null;
      }
    }
    this.subs.clear();
  }

  subscribe(opts: { capacity?: number } = {}): AsyncIterableIterator<SessionUpdate> {
    const sub: Subscription = {
      queue: [],
      resolveNext: null,
      closed: false,
      cap: opts.capacity ?? 1024,
    };
    this.subs.add(sub);
    const subs = this.subs;

    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next(): Promise<IteratorResult<SessionUpdate>> {
        if (sub.queue.length > 0) {
          const value = sub.queue.shift()!;
          return Promise.resolve({ value, done: false });
        }
        if (sub.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          sub.resolveNext = resolve;
        });
      },
      return(): Promise<IteratorResult<SessionUpdate>> {
        sub.closed = true;
        if (sub.resolveNext) {
          sub.resolveNext({ value: undefined, done: true });
          sub.resolveNext = null;
        }
        subs.delete(sub);
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
