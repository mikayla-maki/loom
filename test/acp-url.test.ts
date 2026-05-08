import { describe, expect, it } from "vitest";

import { parseAcpUrl } from "../src/acp/client.js";

// The acp:// resolution path is preserved in the parser, resolver, runtime,
// and broker (LoomServer.embed). Hosting an actual ACP server to test the
// remote-subagent flow is deferred until `loom serve` exists; for now we
// only assert URL parsing, which is what every other code path depends on.
describe("acp URL parsing", () => {
  it("parses acp:// host:port/name", () => {
    expect(parseAcpUrl("acp://192.168.1.5:8910/search")).toEqual({
      scheme: "acp",
      host: "192.168.1.5",
      port: 8910,
      agentName: "search",
    });
    expect(parseAcpUrl("acp://example.com:9000")).toEqual({
      scheme: "acp",
      host: "example.com",
      port: 9000,
    });
  });

  it("parses acp+unix:// path with optional name", () => {
    expect(parseAcpUrl("acp+unix:///run/loom.sock")).toEqual({
      scheme: "acp+unix",
      socketPath: "/run/loom.sock",
    });
    expect(parseAcpUrl("acp+unix:///run/loom.sock:helper")).toEqual({
      scheme: "acp+unix",
      socketPath: "/run/loom.sock",
      agentName: "helper",
    });
  });
});
