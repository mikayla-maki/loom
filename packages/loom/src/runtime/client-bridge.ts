import type {
  ClientCapabilities,
  EnvVariable,
  ReadTextFileRequest,
  TerminalHandle,
  WriteTextFileRequest,
} from "@agentclientprotocol/sdk";

export interface CreateTerminalParams {
  command: string;
  args?: string[];
  cwd?: string;
  env?: EnvVariable[];
  outputByteLimit?: number;
}

export interface ClientBridge {
  readonly capabilities: ClientCapabilities;

  // Present iff capabilities.fs?.readTextFile === true.
  readonly readTextFile?: (
    params: Omit<ReadTextFileRequest, "sessionId">,
  ) => Promise<string>;

  // Present iff capabilities.fs?.writeTextFile === true.
  readonly writeTextFile?: (
    params: Omit<WriteTextFileRequest, "sessionId">,
  ) => Promise<void>;

  // Present iff capabilities.terminal === true.
  readonly createTerminal?: (
    params: CreateTerminalParams,
  ) => Promise<TerminalHandle>;
}

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
