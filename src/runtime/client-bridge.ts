/**
 * `ClientBridge` — the tool-facing surface for outbound ACP calls.
 *
 * When Loom is driven over ACP (`loom acp serve`), tools can reach
 * back into the client to:
 *
 *   - Read files through the editor (`fs/readTextFile`) so they see
 *     unsaved-buffer contents and language-server views, not just
 *     what's on disk.
 *   - Write files through the editor (`fs/writeTextFile`) so the
 *     edit surfaces as an in-editor change with diff + approval UI.
 *   - Spawn commands as proper terminals in the editor's terminal
 *     pane (`terminal/create`), with live streaming output the user
 *     can read as the command runs.
 *
 * When Loom is driven any other way (CLI / SDK-direct / tests), the
 * bridge is absent and tools fall back to `node:fs` / `child_process`
 * paths.
 *
 * Capability gating is structural: a method on the bridge is
 * `undefined` when the client doesn't advertise the corresponding
 * `ClientCapabilities` flag. Tools either pattern-match on presence
 * (`if (ctx.client?.createTerminal)`) or skip the bridge entirely.
 * There is no separate "is supported?" boolean to forget.
 *
 * Loom's own built-in tools (`bash`, `read_file`, `write_file`,
 * `edit_file`) consult the bridge when available. Third-party tools may, but
 * absolutely don't have to. The bridge is part of `ToolContext`; if
 * it's there, you can use it. If you ignore it, your tool still
 * works in all four execution modes (CLI, SDK, ACP, tests) \u2014 you
 * just won't get the IDE-aware behavior.
 */
import type {
  ClientCapabilities,
  EnvVariable,
  ReadTextFileRequest,
  TerminalHandle,
  WriteTextFileRequest,
} from "@agentclientprotocol/sdk";

/** Parameters for `ClientBridge.createTerminal`, sans `sessionId`. */
export interface CreateTerminalParams {
  /** Executable to run. */
  command: string;
  /** Arguments. */
  args?: string[];
  /** Working directory (absolute). */
  cwd?: string;
  /** Environment overrides; merged on top of the client's defaults. */
  env?: EnvVariable[];
  /**
   * Maximum number of output bytes the client retains. The client
   * truncates from the beginning of the output once exceeded, at a
   * character boundary.
   */
  outputByteLimit?: number;
}

export interface ClientBridge {
  /**
   * What the connected client said it supports at `initialize` time.
   * Tools that want to dispatch on multiple capabilities at once can
   * inspect this directly; the structural-typing pattern below
   * (`if (bridge.readTextFile)`) is the more common shape.
   */
  readonly capabilities: ClientCapabilities;

  /**
   * Read a text file through the client's filesystem.
   *
   * Present iff `capabilities.fs?.readTextFile === true`. Returns
   * just the file content as a string \u2014 the SDK's
   * `ReadTextFileResponse` envelope is unwrapped here for the common
   * case. Pass `line` to start at a 1-based line; `limit` caps how
   * many lines come back.
   */
  readonly readTextFile?: (
    params: Omit<ReadTextFileRequest, "sessionId">,
  ) => Promise<string>;

  /**
   * Write a text file through the client's filesystem. The client
   * may render this as an in-editor change, with diff + approval UI.
   *
   * Present iff `capabilities.fs?.writeTextFile === true`.
   */
  readonly writeTextFile?: (
    params: Omit<WriteTextFileRequest, "sessionId">,
  ) => Promise<void>;

  /**
   * Create a terminal in the client and start a command running in
   * it. Returns a {@link TerminalHandle} the tool uses to wait for
   * exit, peek at output, kill the process, and (always, when done)
   * release the terminal. Pass `handle.id` in a `ToolCallContent`
   * with `type: "terminal"` to embed the live terminal pane in the
   * tool-call UI.
   *
   * Present iff `capabilities.terminal === true`.
   *
   * Lifecycle (typical):
   *
   * ```ts
   * const term = await ctx.client.createTerminal({ command, args });
   * try {
   *   await term.waitForExit();   // race against ctx.abortSignal in practice
   *   const { output } = await term.currentOutput();
   *   return { content: output, display: { ... } };
   * } finally {
   *   await term.release().catch(() => undefined);
   * }
   * ```
   *
   * `release` is idempotent and the tool-call UI keeps rendering the
   * terminal after release \u2014 it's an agent-side resource hint, not
   * a client-side delete.
   */
  readonly createTerminal?: (
    params: CreateTerminalParams,
  ) => Promise<TerminalHandle>;
}

/**
 * Convenience: await a promise but unblock it with an abort. The
 * `onAbort` callback runs when the signal fires; for a terminal that
 * means calling `handle.kill()` to wake `waitForExit()` so we can
 * resolve and clean up.
 */
export async function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  onAbort: () => void | Promise<void>,
): Promise<T> {
  if (signal.aborted) {
    await Promise.resolve(onAbort());
    return promise;
  }
  const listener = (): void => {
    void Promise.resolve(onAbort()).catch(() => undefined);
  };
  signal.addEventListener("abort", listener, { once: true });
  try {
    return await promise;
  } finally {
    signal.removeEventListener("abort", listener);
  }
}
