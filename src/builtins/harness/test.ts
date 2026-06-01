import { randomUUID } from "node:crypto";

import type {
  FactoryContext,
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
          rawInput: step.call.input,
        });
        const result = await runtime.executeTool({
          id,
          name: step.call.tool,
          input: step.call.input,
        });
        await runtime.emitToolResult({
          toolCallId: id,
          status: result.isError ? "failed" : "completed",
          modelContent: result.content,
          ...(result.display ? { display: result.display } : {}),
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
    _ctx: FactoryContext,
    _secrets: Record<string, string>,
  ): Harness {
    return new TestHarness(config as TestHarnessConfig);
  },
};
