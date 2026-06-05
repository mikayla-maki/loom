import { describe, expect, it } from "vitest";

import { runAgent } from "../src/sdk/run-agent.js";
import { registerHarness, registerSession } from "../src/builtins/index.js";
import type {
  Agent,
  Harness,
  HarnessFactory,
  Tools,
  Session,
  SessionFactory,
  Tool,
  ToolContext,
  ToolResult,
} from "../src/types/interfaces.js";
import type { SessionUpdate } from "../src/types/acp.js";
import type { AgentManifest } from "../src/types/manifest.js";

class RecordingHarness implements Harness {
  constructor(public readonly seenParent: Agent | undefined) {}
  async run(): Promise<{ stopReason: "end_turn" }> {
    return { stopReason: "end_turn" };
  }
}

const recordingHarnessFactory: HarnessFactory = {
  name: "recording-harness",
  create(_config, _ctx, _secrets, parent) {
    return new RecordingHarness(parent);
  },
};
registerHarness(recordingHarnessFactory);

class RecordingSession implements Session {
  public readonly seenParent: Agent | undefined;
  private events: SessionUpdate[] = [];
  constructor(parent: Agent | undefined) {
    this.seenParent = parent;
  }
  async push(u: SessionUpdate): Promise<SessionUpdate[]> {
    this.events.push(u);
    return [u];
  }
  async pull(_below: SessionUpdate[]): Promise<SessionUpdate[]> {
    return [...this.events];
  }
}

const recordingSessionFactory: SessionFactory = {
  name: "recording-session",
  create(_config, _ctx, _secrets, parent) {
    return new RecordingSession(parent);
  },
};
registerSession(recordingSessionFactory);

const harnessRequiringParentFactory: HarnessFactory = {
  name: "needs-parent-harness",
  requiresParent: true,
  create(_config, _ctx, _secrets, parent) {
    if (!parent) throw new Error("should have been guarded");
    return parent.harness;
  },
};
registerHarness(harnessRequiringParentFactory);

const sessionRequiringParentFactory: SessionFactory = {
  name: "needs-parent-session",
  requiresParent: true,
  create(_config, _ctx, _secrets, parent) {
    if (!parent) throw new Error("should have been guarded");
    return parent.session;
  },
};
registerSession(sessionRequiringParentFactory);

function trivialManifest(name: string): AgentManifest {
  return {
    name,
    systemPrompt: "x",
    tools: {},
    harness: { provider: "test" },
  };
}

function firstAgentMessage(events: SessionUpdate[]): string | undefined {
  for (const e of events) {
    if (e.sessionUpdate === "agent_message_chunk" && e.content.type === "text") {
      return e.content.text;
    }
  }
  return undefined;
}

function toolCallText(events: SessionUpdate[]): string {
  for (const e of events) {
    if (
      e.sessionUpdate === "tool_call_update" &&
      e.content?.[0]?.type === "content" &&
      e.content[0].content.type === "text"
    ) {
      return e.content[0].content.text;
    }
  }
  return "";
}

describe("RunAgentOptions.parent", () => {
  it("forwards the parent ref to the session factory and guards requiresParent at the top level", async () => {
    const parentAgent = await runAgent(trivialManifest("parent"));
    try {
      const parentRef: Agent = {
        manifest: { name: "parent", harness: { provider: "test" } },
        harness: parentAgent.session as unknown as Harness,
        session: parentAgent.session,
        systemPromptCore: "x",
      };

      const child = await runAgent(
        {
          name: "child",
          systemPrompt: "x",
          tools: {},
          harness: { provider: "recording-harness" },
          session: { provider: "recording-session" },
        },
        { parent: parentRef },
      );
      try {
        const sess = child.session as unknown as RecordingSession;
        expect(sess.seenParent).toBe(parentRef);
      } finally {
        await child.close();
      }

      await expect(
        runAgent({
          name: "top",
          systemPrompt: "x",
          tools: {},
          harness: { provider: "needs-parent-harness" },
        }),
      ).rejects.toThrow(
        /Harness 'needs-parent-harness' requires a parent agent/i,
      );

      await expect(
        runAgent({
          name: "top",
          systemPrompt: "x",
          tools: {},
          harness: { provider: "test" },
          session: { provider: "needs-parent-session" },
        }),
      ).rejects.toThrow(
        /Session 'needs-parent-session' requires a parent agent/i,
      );

      const requiringParentChild = await runAgent(
        {
          name: "child",
          systemPrompt: "x",
          tools: {},
          harness: { provider: "needs-parent-harness" },
          session: { provider: "needs-parent-session" },
        },
        {
          parent: {
            ...parentRef,
            harness: { run: async () => ({ stopReason: "end_turn" as const }) },
          },
        },
      );
      expect(requiringParentChild.session).toBe(parentAgent.session);
      await requiringParentChild.close();
    } finally {
      await parentAgent.close();
    }
  });
});

describe("ctx.spawnSubagent + ctx.agent", () => {
  const childManifest: AgentManifest = {
    name: "child-by-name",
    systemPrompt: "x",
    tools: {},
    harness: {
      provider: "test",
      script: [[{ say: "hi from child" }, { stop: "end_turn" }]],
    },
  };

  function spawnerProvider(opts: {
    capture: { ctx?: ToolContext; agent?: Agent; childResult?: string };
    deps?: AgentManifest[];
    spawn: "by-name" | "inline" | "missing";
  }): Tools {
    const tool: Tool = {
      name: "spawner",
      description: "Spawns a sub-agent and records ctx.",
      inputSchema: { type: "object" },
      ...(opts.deps ? { dependencies: { subagents: opts.deps } } : {}),
      async execute(_input: unknown, ctx: ToolContext): Promise<ToolResult> {
        opts.capture.ctx = ctx;
        opts.capture.agent = ctx.agent;
        const target: string | AgentManifest =
          opts.spawn === "by-name"
            ? "child-by-name"
            : opts.spawn === "inline"
              ? childManifest
              : "not-declared";
        if (!ctx.agent.spawnSubagent) {
          throw new Error("ctx.agent.spawnSubagent missing");
        }
        const sub = await ctx.agent.spawnSubagent(target);
        try {
          await sub.prompt("hello");
          const events = (await sub.session.pull?.([])) ?? [];
          opts.capture.childResult = firstAgentMessage(events);
        } finally {
          await sub.close();
        }
        return { content: opts.capture.childResult ?? "" };
      },
    };
    return {
      resolveTool(name) {
        return name === "spawner" ? tool : null;
      },
      close: () => {},
    };
  }

  function spawningParentManifest(): AgentManifest {
    return {
      name: "parent",
      systemPrompt: "x",
      tools: { spawner: "builtin" },
      harness: {
        provider: "test",
        script: [
          [{ call: { tool: "spawner", input: {} } }, { stop: "end_turn" }],
        ],
      },
    };
  }

  it("looks up sub-agents by name in the calling tool's deps, exposing the owning agent as ctx.agent", async () => {
    const captured: { ctx?: ToolContext; agent?: Agent; childResult?: string } =
      {};
    const provider = spawnerProvider({
      capture: captured,
      deps: [childManifest],
      spawn: "by-name",
    });

    const agent = await runAgent(spawningParentManifest(), {
      providers: [provider],
    });
    try {
      await agent.prompt("go");
      expect(captured.childResult).toBe("hi from child");
      expect(captured.agent?.manifest.name).toBe("parent");
      expect(captured.agent?.session).toBe(agent.session);
    } finally {
      await agent.close();
    }
  });

  it("accepts an inline manifest with no declared deps", async () => {
    const captured: { childResult?: string } = {};
    const provider = spawnerProvider({ capture: captured, spawn: "inline" });

    const agent = await runAgent(spawningParentManifest(), {
      providers: [provider],
    });
    try {
      await agent.prompt("go");
      expect(captured.childResult).toBe("hi from child");
    } finally {
      await agent.close();
    }
  });

  it("throws a helpful error when the name isn't in deps.subagents", async () => {
    const provider = spawnerProvider({
      capture: {},
      deps: [childManifest],
      spawn: "missing",
    });

    const agent = await runAgent(spawningParentManifest(), {
      providers: [provider],
    });
    try {
      let caughtMsg = "";
      try {
        await agent.prompt("go");
        const events = (await agent.session.pull?.([])) ?? [];
        const tu = events.find((e) => e.sessionUpdate === "tool_call_update");
        if (tu && tu.sessionUpdate === "tool_call_update") {
          caughtMsg =
            tu.content?.[0]?.type === "content" &&
            tu.content[0].content.type === "text"
              ? tu.content[0].content.text
              : "";
        }
      } catch (e) {
        caughtMsg = (e as Error).message;
      }
      expect(caughtMsg).toMatch(/not-declared/);
      expect(caughtMsg).toMatch(/dependencies\.subagents/);
    } finally {
      await agent.close();
    }
  });
});

describe("Tools.resolveTool receives the owning Agent", () => {
  it("passes a data-only owning agent so providers can capture it at construction", async () => {
    let captured: Agent | undefined;
    const provider: Tools = {
      resolveTool: (name, _config, agent) => {
        captured = agent;
        if (name === "noop") {
          return {
            name: "noop",
            description: "noop",
            inputSchema: { type: "object" },
            execute: async () => ({ content: "" }),
          };
        }
        return null;
      },
      close: () => {},
    };

    const agent = await runAgent(
      {
        name: "self-aware",
        systemPrompt: "x",
        tools: { noop: "builtin" },
        harness: { provider: "test" },
      },
      { providers: [provider] },
    );
    try {
      expect(captured).toBeDefined();
      expect(captured?.manifest.name).toBe("self-aware");
      expect(captured?.session).toBe(agent.session);
      expect(captured?.spawnSubagent).toBeUndefined();
    } finally {
      await agent.close();
    }
  });
});

describe("agent.spawnSubagent on session hooks", () => {
  it("the session hook's Agent ref looks up sub-agents by name in the session's deps", async () => {
    const subManifest: AgentManifest = {
      name: "session-child",
      systemPrompt: "x",
      tools: {},
      harness: {
        provider: "test",
        script: [[{ say: "from-session-child" }, { stop: "end_turn" }]],
      },
    };

    let childResult = "";
    const events: SessionUpdate[] = [];
    const session = {
      dependencies: { subagents: [subManifest] },
      async push(u: SessionUpdate) {
        events.push(u);
        return [u];
      },
      async pull(_below: SessionUpdate[]) {
        return [...events];
      },
      async prepareTurn(agent: Agent) {
        if (!agent.spawnSubagent) throw new Error("missing spawnSubagent");
        const sub = await agent.spawnSubagent("session-child");
        try {
          await sub.prompt("go");
          const evs = (await sub.session.pull?.([])) ?? [];
          childResult = firstAgentMessage(evs) ?? "";
        } finally {
          await sub.close();
        }
      },
    } satisfies Session;

    const agent = await runAgent({
      name: "parent-with-session-spawn",
      systemPrompt: "x",
      tools: {},
      harness: { provider: "test" },
      session,
    });
    try {
      await agent.prompt("hi");
      expect(childResult).toBe("from-session-child");
    } finally {
      await agent.close();
    }
  });
});
