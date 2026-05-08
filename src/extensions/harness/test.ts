/**
 * Test harness — a deterministic, scripted harness for testing the runtime
 * and tool plumbing without an LLM.
 *
 * Two modes:
 *
 * 1. Scripted (default): config holds a `script: TurnScript[]`. Each call to
 *    run() consumes one TurnScript. A TurnScript is a list of "steps":
 *      - { say: "..." }                   -> emit agent_message_chunk
 *      - { call: { tool, input } }        -> dispatch the tool, surface result
 *      - { think: "..." }                 -> emit agent_thought_chunk
 *      - { stop: "end_turn" }             -> finish the turn
 *    Tool-call steps record the result back as an agent_message_chunk by default;
 *    add `surface: false` to omit that.
 *
 * 2. Echo: config { echo: true } — replays the most recent user message back
 *    as an agent message and ends the turn. Useful for smoke tests.
 *
 * The harness is also useful as a *programmatic driver* — you can pass a
 * function in `script` that returns the next step given the runtime, which
 * lets tests express logic.
 */

import { randomUUID } from "node:crypto";

import type {
  ExtensionContext,
  Harness,
  HarnessFactory,
  RunParameters,
  Runtime,
  TurnResult,
} from "../../types/interfaces.js";
import type { SessionUpdate, StopReason } from "../../types/acp.js";

export type TurnStep =
  | { say: string }
  | { think: string }
  | {
      call: { tool: string; input: unknown };
      surface?: boolean;
    }
  | { stop: StopReason };

export type TurnScript =
  | TurnStep[]
  | ((runtime: Runtime) => Promise<TurnStep[]> | TurnStep[]);

export interface TestHarnessConfig {
  script?:
    | TurnScript[]
    | ((
        runtime: Runtime,
        turnIndex: number,
      ) => Promise<TurnStep[]> | TurnStep[]);
  echo?: boolean;
}

export class TestHarness implements Harness {
  private turnIndex = 0;

  constructor(private readonly config: TestHarnessConfig) {}

  /** Most-recent params seen by `run()`. Lets tests assert what loom forwarded. */
  public lastParams: RunParameters | undefined;

  async run(runtime: Runtime, params?: RunParameters): Promise<TurnResult> {
    this.lastParams = params;
    if (this.config.echo) {
      return this.runEcho(runtime);
    }
    const steps = await this.nextSteps(runtime);
    return this.executeSteps(runtime, steps);
  }

  private async nextSteps(runtime: Runtime): Promise<TurnStep[]> {
    const script = this.config.script;
    if (!script) {
      return [{ stop: "end_turn" }];
    }
    if (typeof script === "function") {
      const steps = await script(runtime, this.turnIndex);
      this.turnIndex += 1;
      return steps;
    }
    const turn = script[this.turnIndex];
    this.turnIndex += 1;
    if (turn === undefined) {
      return [{ stop: "end_turn" }];
    }
    if (typeof turn === "function") {
      return await turn(runtime);
    }
    return turn;
  }

  private async runEcho(runtime: Runtime): Promise<TurnResult> {
    const events = await runtime.getEvents();
    const lastUser = [...events]
      .reverse()
      .find((e) => e.sessionUpdate === "user_message_chunk") as
      | (SessionUpdate & { sessionUpdate: "user_message_chunk" })
      | undefined;
    const text =
      lastUser && lastUser.content.type === "text"
        ? lastUser.content.text
        : "(no user message)";
    await runtime.update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `echo: ${text}` },
    });
    await runtime.update({ sessionUpdate: "stop", stopReason: "end_turn" });
    return { stopReason: "end_turn" };
  }

  private async executeSteps(
    runtime: Runtime,
    steps: TurnStep[],
  ): Promise<TurnResult> {
    let stopReason: StopReason = "end_turn";
    for (const step of steps) {
      if (runtime.abortSignal.aborted) {
        stopReason = "cancelled";
        break;
      }
      if ("say" in step) {
        await runtime.update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: step.say },
        });
      } else if ("think" in step) {
        await runtime.update({
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: step.think },
        });
      } else if ("call" in step) {
        const id = randomUUID();
        await runtime.update({
          sessionUpdate: "tool_call",
          toolCallId: id,
          title: step.call.tool,
          status: "in_progress",
          input: step.call.input,
        });
        const result = await runtime.executeTool({
          id,
          name: step.call.tool,
          input: step.call.input,
        });
        await runtime.update({
          sessionUpdate: "tool_call_update",
          toolCallId: id,
          status: result.isError ? "failed" : "completed",
          content: [
            {
              type: "content",
              content: { type: "text", text: result.content },
            },
          ],
        });
        if (step.surface !== false) {
          await runtime.update({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: result.content },
          });
        }
      } else if ("stop" in step) {
        stopReason = step.stop;
      }
    }
    await runtime.update({ sessionUpdate: "stop", stopReason });
    return { stopReason };
  }
}

export const testHarnessFactory: HarnessFactory = {
  name: "test",
  create(
    config: Record<string, unknown>,
    _ctx: ExtensionContext,
    _secrets: Record<string, string>,
  ): Harness {
    return new TestHarness(config as TestHarnessConfig);
  },
};
