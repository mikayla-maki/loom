export class LoomError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = this.constructor.name;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export class ManifestError extends LoomError {}

export class ResolutionError extends LoomError {}

export class CapabilityError extends LoomError {
  constructor(
    message: string,
    public readonly required: Record<string, unknown>,
    public readonly ceiling: Record<string, unknown>,
  ) {
    super(message);
  }
}

export class SecretError extends LoomError {}

export class ToolInputError extends LoomError {}

export class ToolExecutionError extends LoomError {
  constructor(
    message: string,
    public readonly toolName: string,
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    super(message);
  }
}

export class TurnCancelledError extends LoomError {}
