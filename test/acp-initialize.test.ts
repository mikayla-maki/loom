/**
 * ACP `initialize` handshake and capability aggregation.
 *
 * Tests the contract:
 *   - `initialize` round-trip with negotiated capabilities
 *   - aggregation across harness + session + tools (SDK shape)
 *   - client capabilities visible in `FactoryContext` at boot time
 */

import { describe, expect, it } from "vitest";

import { serveOverStream, ACP_PROTOCOL_VERSION } from "../src/acp/server.js";
import { runAgent } from "../src/sdk/run-agent.js";
import {
  aggregateAcpCapabilities,
  DEFAULT_CLIENT_ACP_CAPABILITIES,
} from "../src/runtime/acp-capabilities.js";
import type { AgentManifest, Reference } from "../src/types/manifest.js";
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

// ───────────────────────────────────────────────────────────────────
// Aggregation unit tests (no transport).
// ───────────────────────────────────────────────────────────────────

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

  it("loadSession reflects any contributor saying true", () => {
    expect(aggregateAcpCapabilities([{ loadSession: true }]).loadSession).toBe(
      true,
    );
    expect(aggregateAcpCapabilities([{}]).loadSession).toBeUndefined();
  });

  it("sessionCapabilities propagate from contributors", () => {
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

// ──────────────────────────────────────────────────────────────────────
// `initialize` end-to-end (in-process streams).
// ──────────────────────────────────────────────────────────────────────

describe("ACP initialize handshake", () => {
  it("returns aggregated capabilities + agentInfo", async () => {
    const { serverStream, clientStream } = makeInProcessPipe();

    const spec: AgentManifest = {
      name: "init-test",
      description: "Initialize round-trip",
      systemPrompt: "x",
      tools: {},
      harness: { provider: "test", script: [[{ stop: "end_turn" }]] },
      capabilities: {},
    };
    const agent = await runAgent(spec);

    const { closeAll } = serveOverStream(async () => agent, serverStream);

    const conn = makeClient(clientStream);
    const result = await conn.initialize({
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "test-client", version: "0.0.1" },
    });

    expect(result.protocolVersion).toBe(ACP_PROTOCOL_VERSION);
    expect(result.agentInfo?.name).toBe("init-test");
    // No tools registered, no session.resume — capabilities are empty.
    expect(result.agentCapabilities?.promptCapabilities).toBeUndefined();
    expect(result.agentCapabilities?.loadSession).toBeUndefined();

    await closeAll();
    serverStream.writable.close().catch(() => undefined);
    await agent.close();
  });

  it("rejects unsupported protocolVersion", async () => {
    const { serverStream, clientStream } = makeInProcessPipe();
    const spec: AgentManifest = {
      name: "init-bad-version",
      systemPrompt: "x",
      tools: {},
      harness: { provider: "test", script: [[{ stop: "end_turn" }]] },
      capabilities: {},
    };
    const agent = await runAgent(spec);
    const { closeAll } = serveOverStream(async () => agent, serverStream);
    const conn = makeClient(clientStream);

    await expect(
      conn.initialize({ protocolVersion: 999 } as never),
    ).rejects.toThrow(/protocolVersion/);

    await closeAll();
    serverStream.writable.close().catch(() => undefined);
    await agent.close();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Client capabilities reach the runtime (via DEFAULT for SDK direct).
// ──────────────────────────────────────────────────────────────────────

describe("FactoryContext.clientCapabilities", () => {
  it("defaults to full-local capabilities for SDK-direct runAgent calls", async () => {
    let captured: unknown = null;
    const captureFactory = {
      name: "capture-caps",
      create(
        _cfg: Record<string, unknown>,
        ctx: { clientCapabilities?: unknown },
      ) {
        captured = ctx.clientCapabilities;
        return { push: async () => [], pull: async () => [] };
      },
    };
    const { registerSession } = await import("../src/builtins/index.js");
    registerSession(captureFactory);

    const ref: Reference = "capture-caps";
    const agent = await runAgent({
      name: "ctx-test",
      systemPrompt: "x",
      tools: {},
      harness: { provider: "test", script: [[{ stop: "end_turn" }]] },
      session: { provider: ref },
      capabilities: {},
    });
    try {
      expect(captured).toEqual(DEFAULT_CLIENT_ACP_CAPABILITIES);
    } finally {
      await agent.close();
    }
  });

  it("can be overridden via RunAgentOptions.clientAcpCapabilities", async () => {
    let captured: unknown = null;
    const captureFactory = {
      name: "capture-caps-2",
      create(
        _cfg: Record<string, unknown>,
        ctx: { clientCapabilities?: unknown },
      ) {
        captured = ctx.clientCapabilities;
        return { push: async () => [], pull: async () => [] };
      },
    };
    const { registerSession } = await import("../src/builtins/index.js");
    registerSession(captureFactory);

    const agent = await runAgent(
      {
        name: "override-test",
        systemPrompt: "x",
        tools: {},
        harness: { provider: "test", script: [[{ stop: "end_turn" }]] },
        session: { provider: "capture-caps-2" },
        capabilities: {},
      },
      {
        clientAcpCapabilities: {
          fs: { readTextFile: true },
          terminal: false,
        },
      },
    );
    try {
      expect(captured).toEqual({
        fs: { readTextFile: true },
        terminal: false,
      });
    } finally {
      await agent.close();
    }
  });

  it("surfaces [agent.metadata] to plugins via FactoryContext.metadata", async () => {
    let captured: unknown = null;
    const captureFactory = {
      name: "capture-metadata",
      create(
        _cfg: Record<string, unknown>,
        ctx: { metadata?: Record<string, unknown> },
      ) {
        captured = ctx.metadata;
        return { push: async () => [], pull: async () => [] };
      },
    };
    const { registerSession } = await import("../src/builtins/index.js");
    registerSession(captureFactory);

    const agent = await runAgent({
      name: "metadata-roundtrip",
      systemPrompt: "x",
      tools: {},
      harness: { provider: "test", script: [[{ stop: "end_turn" }]] },
      session: { provider: "capture-metadata" },
      capabilities: {},
      metadata: {
        team: "platform-eng",
        owners: ["alice"],
        rollout: { region: "us-east-1" },
      },
    });
    try {
      expect(captured).toEqual({
        team: "platform-eng",
        owners: ["alice"],
        rollout: { region: "us-east-1" },
      });
    } finally {
      await agent.close();
    }
  });

  it("defaults FactoryContext.metadata to {} when [agent.metadata] is absent", async () => {
    let captured: unknown = null;
    const captureFactory = {
      name: "capture-metadata-default",
      create(
        _cfg: Record<string, unknown>,
        ctx: { metadata?: Record<string, unknown> },
      ) {
        captured = ctx.metadata;
        return { push: async () => [], pull: async () => [] };
      },
    };
    const { registerSession } = await import("../src/builtins/index.js");
    registerSession(captureFactory);

    const agent = await runAgent({
      name: "metadata-default",
      systemPrompt: "x",
      tools: {},
      harness: { provider: "test", script: [[{ stop: "end_turn" }]] },
      session: { provider: "capture-metadata-default" },
      capabilities: {},
      // No metadata field.
    });
    try {
      expect(captured).toEqual({});
    } finally {
      await agent.close();
    }
  });
});
