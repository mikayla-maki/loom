import { describe, expect, it } from "vitest";

import { serveOverStream, ACP_PROTOCOL_VERSION } from "../src/acp/server.js";
import { runAgent, type RunAgentOptions } from "../src/sdk/run-agent.js";
import {
  aggregateAcpCapabilities,
  DEFAULT_CLIENT_ACP_CAPABILITIES,
} from "../src/runtime/acp-capabilities.js";
import type { AgentManifest } from "../src/types/manifest.js";
import type { AcpCapabilityContribution } from "../src/types/interfaces.js";
import {
  ClientSideConnection,
  type Client,
  type Stream,
} from "@agentclientprotocol/sdk";

function makeInProcessPipe(): {
  serverStream: Stream;
  clientStream: Stream;
} {
  const c2s = new TransformStream<unknown, unknown>();
  const s2c = new TransformStream<unknown, unknown>();
  return {
    serverStream: { readable: c2s.readable, writable: s2c.writable },
    clientStream: { readable: s2c.readable, writable: c2s.writable },
  } as never;
}

function makeClient(stream: Stream): ClientSideConnection {
  const noopClient: Client = {
    async sessionUpdate() {},
    async requestPermission() {
      return { outcome: { outcome: "cancelled" as const } };
    },
  };
  return new ClientSideConnection(() => noopClient, stream);
}

describe("aggregateAcpCapabilities", () => {
  it("emits an empty object when no contributor claims anything", () => {
    const caps = aggregateAcpCapabilities([]);
    expect(caps.promptCapabilities).toBeUndefined();
    expect(caps.sessionCapabilities).toBeUndefined();
    expect(caps.loadSession).toBeUndefined();
  });

  it("OR-merges promptCapabilities across contributors", () => {
    const contributions: AcpCapabilityContribution[] = [
      { promptCapabilities: { image: true } },
      { promptCapabilities: { embeddedContext: true } },
      { promptCapabilities: { audio: true } },
    ];
    const caps = aggregateAcpCapabilities(contributions);
    expect(caps.promptCapabilities).toEqual({
      image: true,
      audio: true,
      embeddedContext: true,
    });
  });

  it("propagates loadSession and sessionCapabilities from contributors", () => {
    expect(aggregateAcpCapabilities([{ loadSession: true }]).loadSession).toBe(
      true,
    );
    expect(aggregateAcpCapabilities([{}]).loadSession).toBeUndefined();

    const caps = aggregateAcpCapabilities([
      { sessionCapabilities: { resume: {}, close: {} } },
    ]);
    expect(caps.sessionCapabilities?.resume).toEqual({});
    expect(caps.sessionCapabilities?.close).toEqual({});
    expect(caps.sessionCapabilities?.fork).toBeUndefined();
  });

  it("merges `experimental` into `_meta` across contributors", () => {
    const caps = aggregateAcpCapabilities([
      { experimental: { a: 1, shared: "harness" } },
      { experimental: { b: 2, shared: "session" } },
      { experimental: { c: 3, shared: "tool" } },
    ]);
    expect(caps._meta).toEqual({
      a: 1,
      b: 2,
      c: 3,
      shared: "tool",
    });
  });
});

describe("ACP initialize handshake", () => {
  // Serves `spec` over an in-process pipe and runs `body` against a connected
  // client, tearing everything down afterwards.
  async function withInitializedAgent(
    spec: AgentManifest,
    body: (conn: ClientSideConnection) => Promise<void>,
  ): Promise<void> {
    const { serverStream, clientStream } = makeInProcessPipe();
    const agent = await runAgent(spec);
    const { closeAll } = serveOverStream(async () => agent, serverStream);
    try {
      await body(makeClient(clientStream));
    } finally {
      await closeAll();
      serverStream.writable.close().catch(() => undefined);
      await agent.close();
    }
  }

  const baseSpec = (name: string): AgentManifest => ({
    name,
    systemPrompt: "x",
    tools: {},
    harness: { provider: "test", script: [[{ stop: "end_turn" }]] },
    capabilities: {},
  });

  it("returns aggregated capabilities + agentInfo", async () => {
    await withInitializedAgent(
      { ...baseSpec("init-test"), description: "Initialize round-trip" },
      async (conn) => {
        const result = await conn.initialize({
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: "test-client", version: "0.0.1" },
        });

        expect(result.protocolVersion).toBe(ACP_PROTOCOL_VERSION);
        expect(result.agentInfo?.name).toBe("init-test");
        expect(result.agentCapabilities?.promptCapabilities).toBeUndefined();
        expect(result.agentCapabilities?.loadSession).toBeUndefined();
      },
    );
  });

  it("rejects unsupported protocolVersion", async () => {
    await withInitializedAgent(baseSpec("init-bad-version"), async (conn) => {
      await expect(
        conn.initialize({ protocolVersion: 999 } as never),
      ).rejects.toThrow(/protocolVersion/);
    });
  });
});

describe("FactoryContext", () => {
  async function captureContext(
    name: string,
    spec: Partial<AgentManifest>,
    options?: RunAgentOptions,
  ): Promise<{ clientCapabilities?: unknown; metadata?: unknown }> {
    const captured: { clientCapabilities?: unknown; metadata?: unknown } = {};
    const { registerSession } = await import("../src/builtins/index.js");
    registerSession({
      name,
      create(
        _cfg: Record<string, unknown>,
        ctx: { clientCapabilities?: unknown; metadata?: unknown },
      ) {
        captured.clientCapabilities = ctx.clientCapabilities;
        captured.metadata = ctx.metadata;
        return { push: async () => [], pull: async () => [] };
      },
    });

    const agent = await runAgent(
      {
        name: `${name}-agent`,
        systemPrompt: "x",
        tools: {},
        harness: { provider: "test", script: [[{ stop: "end_turn" }]] },
        session: { provider: name },
        capabilities: {},
        ...spec,
      } as AgentManifest,
      options,
    );
    try {
      return captured;
    } finally {
      await agent.close();
    }
  }

  it("defaults clientCapabilities to full-local for SDK-direct runAgent calls", async () => {
    const { clientCapabilities } = await captureContext("capture-caps", {});
    expect(clientCapabilities).toEqual(DEFAULT_CLIENT_ACP_CAPABILITIES);
  });

  it("overrides clientCapabilities via RunAgentOptions.clientAcpCapabilities", async () => {
    const override = { fs: { readTextFile: true }, terminal: false };
    const { clientCapabilities } = await captureContext(
      "capture-caps-2",
      {},
      { clientAcpCapabilities: override },
    );
    expect(clientCapabilities).toEqual(override);
  });

  it("surfaces [agent.metadata] to plugins and defaults it to {} when absent", async () => {
    const metadata = {
      team: "platform-eng",
      owners: ["alice"],
      rollout: { region: "us-east-1" },
    };
    const present = await captureContext("capture-metadata", { metadata });
    expect(present.metadata).toEqual(metadata);

    const absent = await captureContext("capture-metadata-default", {});
    expect(absent.metadata).toEqual({});
  });
});
