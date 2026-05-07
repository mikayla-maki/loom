/**
 * Loom error hierarchy.
 *
 * Errors thrown by the resolver, runtime, and SDK are instances of LoomError
 * so callers can catch them by class. Specific subclasses help with reporting.
 */

export class LoomError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = this.constructor.name;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** Raised when a manifest fails to parse or fails schema validation. */
export class ManifestError extends LoomError {}

/** Raised when a referenced extension / skill / tool can't be found. */
export class ResolutionError extends LoomError {}

/** Raised when tool capabilities exceed the agent's [capabilities] ceiling. */
export class CapabilityError extends LoomError {
  constructor(
    message: string,
    public readonly required: Record<string, unknown>,
    public readonly ceiling: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Raised when a required secret can't be resolved. */
export class SecretError extends LoomError {}

/** Raised when tool input fails JSON-schema validation. */
export class ToolInputError extends LoomError {}

/** Raised when a tool process exits non-zero. */
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

/** Raised when a turn is cancelled. */
export class TurnCancelledError extends LoomError {}
