import { describe, expect, it } from "vitest";

import {
  applyToolGroups,
  ceilingEntryFor,
  collectToolGroups,
  containsDeclaration,
  toolGroupQualifies,
  underlyingNameOfEntry,
} from "../src/manifest/tool-groups.js";
import type { Session, Tool } from "../src/types/interfaces.js";
import type { Capabilities, ToolGroup } from "../src/types/manifest.js";

function stubTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: "stub",
    description: "",
    inputSchema: { type: "object" },
    async execute() {
      return { content: "" };
    },
    ...overrides,
  };
}

describe("ceilingEntryFor", () => {
  const ceiling: Capabilities = {
    bash: { commands: "*" },
    gcalcli: { commands: ["gcalcli"], network: "*" },
  };

  it("prefers the instance-name entry over the underlying-name entry", () => {
    expect(ceilingEntryFor(ceiling, "gcalcli", "bash")).toEqual({
      key: "gcalcli",
      grant: { commands: ["gcalcli"], network: "*" },
    });
  });

  it("falls back to the underlying-name entry", () => {
    expect(ceilingEntryFor(ceiling, "my_shell", "bash")).toEqual({
      key: "bash",
      grant: { commands: "*" },
    });
  });

  it("returns undefined when neither name is in the ceiling", () => {
    expect(ceilingEntryFor(ceiling, "jq", "python")).toBeUndefined();
  });
});

describe("underlyingNameOfEntry", () => {
  it("is the instance name for string entries and untagged tables", () => {
    expect(underlyingNameOfEntry("bash", "builtin")).toBe("bash");
    expect(underlyingNameOfEntry("bash", { provider: "builtin" })).toBe("bash");
  });

  it("is the tool key when renamed", () => {
    expect(
      underlyingNameOfEntry("gcalcli", { provider: "builtin", tool: "bash" }),
    ).toBe("bash");
  });
});

describe("containsDeclaration", () => {
  const ceiling: Capabilities = {
    bash: [
      { commands: "*", paths: ["./"] },
      { commands: ["gcalcli"], network: "*" },
    ],
  };

  it("grants a request fitting one ceiling row", () => {
    expect(
      containsDeclaration({
        ceiling,
        instance: "bash",
        underlying: "bash",
        request: { commands: ["gcalcli"], network: "*" },
      }),
    ).toEqual({
      instance: "bash",
      underlying: "bash",
      ok: true,
      against: "bash",
    });
  });

  it("denies a request spanning rows, with a paste-ready remediation", () => {
    expect(
      containsDeclaration({
        ceiling,
        instance: "bash",
        underlying: "bash",
        request: { commands: "*", network: "*" },
      }),
    ).toEqual({
      instance: "bash",
      underlying: "bash",
      ok: false,
      against: "bash",
      reason: "request exceeds [capabilities].bash",
      remediation: 'bash = { commands = "*", network = "*" }',
    });
  });

  it("denies when nothing in the ceiling names the tool", () => {
    const verdict = containsDeclaration({
      ceiling,
      instance: "curl",
      underlying: "curl",
      request: { commands: ["curl"] },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe(
      "nothing in the capability ceiling grants 'curl' (or 'curl')",
    );
    expect(verdict.remediation).toBe('curl = { commands = ["curl"] }');
  });

  it("an undefined request asks for nothing and is always granted", () => {
    expect(
      containsDeclaration({
        ceiling,
        instance: "bash",
        underlying: "bash",
        request: undefined,
      }),
    ).toEqual({
      instance: "bash",
      underlying: "bash",
      ok: true,
      against: "bash",
    });
    expect(
      containsDeclaration({
        ceiling,
        instance: "send_dm",
        underlying: "send_dm",
        request: undefined,
      }),
    ).toEqual({ instance: "send_dm", underlying: "send_dm", ok: true });
  });

  it("judges with the tool's algebra when provided", () => {
    const generous = stubTool({ containsGrant: () => true });
    expect(
      containsDeclaration({
        ceiling,
        instance: "bash",
        underlying: "bash",
        request: { commands: "*", network: "*", env: "*" },
        tool: generous,
      }).ok,
    ).toBe(true);
  });
});

describe("applyToolGroups", () => {
  it("root inline declarations are self-authorizing and widen the ceiling", () => {
    const applied = applyToolGroups({
      manifestTools: {
        bash: {
          provider: "builtin",
          capabilities: { commands: "*", network: "*" },
        },
      },
      capabilities: {},
      groups: [],
    });
    expect(applied.ceiling).toEqual({
      bash: { commands: "*", network: "*" },
    });
  });

  it("the effective ceiling is [capabilities] unioned with inline declarations", () => {
    const applied = applyToolGroups({
      manifestTools: {
        bash: {
          provider: "builtin",
          capabilities: { commands: ["gcalcli"], network: "*" },
        },
      },
      capabilities: { bash: { commands: "*", paths: ["./"] } },
      groups: [],
    });
    expect(applied.ceiling).toEqual({
      bash: [
        { commands: "*", paths: ["./"] },
        { commands: ["gcalcli"], network: "*" },
      ],
    });
  });

  it("a contribution is judged against the widened ceiling", () => {
    const applied = applyToolGroups({
      manifestTools: {
        bash: {
          provider: "builtin",
          capabilities: { commands: ["gcalcli"], network: "*" },
        },
      },
      capabilities: {},
      groups: [
        {
          label: "skill 'calendar'",
          tools: {
            bash: { capabilities: { commands: ["gcalcli"], network: "*" } },
          },
        },
      ],
    });
    expect(applied.verdicts).toEqual([
      {
        label: "skill 'calendar'",
        accepted: true,
        declarations: [
          { instance: "bash", underlying: "bash", ok: true, against: "bash" },
        ],
      },
    ]);
  });

  it("merges a matching provider-less contribution into the instance's request", () => {
    const applied = applyToolGroups({
      manifestTools: {
        bash: { provider: "builtin", capabilities: { commands: "*" } },
      },
      capabilities: {
        bash: [{ commands: "*" }, { commands: ["gcalcli"], network: "*" }],
      },
      groups: [
        {
          label: "skill 'calendar'",
          tools: {
            bash: { capabilities: { commands: ["gcalcli"], network: "*" } },
          },
        },
      ],
    });
    expect(applied.tools).toEqual({
      bash: {
        provider: "builtin",
        capabilities: [
          { commands: "*" },
          { commands: ["gcalcli"], network: "*" },
        ],
      },
    });
    expect(applied.verdicts[0]?.accepted).toBe(true);
  });

  it("a contribution to a BARE entry extends the ceiling request, never narrows it", () => {
    const applied = applyToolGroups({
      manifestTools: { bash: "builtin", read_file: "builtin" },
      capabilities: {
        bash: [
          { commands: "*", paths: ["./"] },
          { commands: ["gcalcli"], network: "*" },
        ],
        read_file: { paths: ["./", "./skills"] },
      },
      groups: [
        {
          label: "skill 'calendar'",
          tools: {
            bash: { capabilities: { commands: ["gcalcli"], network: "*" } },
            read_file: { capabilities: { paths: ["./skills"] } },
          },
        },
      ],
    });
    expect(applied.verdicts[0]?.accepted).toBe(true);
    expect(applied.tools).toEqual({
      bash: {
        provider: "builtin",
        capabilities: [
          { commands: "*", paths: ["./"] },
          { commands: ["gcalcli"], network: "*" },
        ],
      },
      read_file: {
        provider: "builtin",
        capabilities: [{ paths: ["./", "./skills"] }, { paths: ["./skills"] }],
      },
    });
  });

  it("adds a qualifying new instance from a contribution", () => {
    const applied = applyToolGroups({
      manifestTools: { read_file: "builtin" },
      capabilities: {
        read_file: { paths: ["./"] },
        jq: { commands: ["jq"] },
      },
      groups: [
        {
          label: "skill 'jq'",
          tools: {
            jq: {
              provider: "builtin",
              tool: "bash",
              capabilities: { commands: ["jq"] },
            },
          },
        },
      ],
    });
    expect(applied.tools).toEqual({
      read_file: { provider: "builtin" },
      jq: {
        provider: "builtin",
        tool: "bash",
        capabilities: { commands: ["jq"] },
      },
    });
    expect(applied.verdicts[0]?.accepted).toBe(true);
  });

  it("accepts a session-implemented bare entry that requests nothing", () => {
    const applied = applyToolGroups({
      manifestTools: {},
      capabilities: {},
      groups: [
        {
          label: "companion session",
          tools: { send_dm: { provider: "session" } },
        },
      ],
    });
    expect(applied.tools).toEqual({
      send_dm: { provider: "session" },
    });
    expect(applied.verdicts).toEqual([
      {
        label: "companion session",
        accepted: true,
        declarations: [
          { instance: "send_dm", underlying: "send_dm", ok: true },
        ],
      },
    ]);
  });

  it("rejects a group atomically when any declaration fails", () => {
    const applied = applyToolGroups({
      manifestTools: { bash: "builtin", read_file: "builtin" },
      capabilities: {
        bash: { commands: "*" },
        read_file: { paths: ["./"] },
      },
      groups: [
        {
          label: "skill 'greedy'",
          tools: {
            read_file: { capabilities: { paths: ["./"] } },
            bash: { capabilities: { commands: "*", network: "*" } },
          },
        },
      ],
    });
    expect(applied.tools).toEqual({
      bash: { provider: "builtin" },
      read_file: { provider: "builtin" },
    });
    const verdict = applied.verdicts[0]!;
    expect(verdict.accepted).toBe(false);
    expect(verdict.declarations.map((d) => [d.instance, d.ok])).toEqual([
      ["read_file", true],
      ["bash", false],
    ]);
  });

  it("rejects an implementation collision but accepts a matching one", () => {
    const applied = applyToolGroups({
      manifestTools: {
        search: { provider: "google", capabilities: { queries: "*" } },
      },
      capabilities: { search: { queries: "*" } },
      groups: [
        {
          label: "group 'imposter'",
          tools: {
            search: { provider: "bing", capabilities: { queries: "*" } },
          },
        },
        {
          label: "group 'friendly'",
          tools: {
            search: { provider: "google", capabilities: { queries: "*" } },
          },
        },
      ],
    });
    expect(applied.verdicts.map((v) => [v.label, v.accepted])).toEqual([
      ["group 'imposter'", false],
      ["group 'friendly'", true],
    ]);
    const imposter = applied.verdicts[0]!.declarations[0]!;
    expect(imposter.reason).toContain("different implementation");
  });

  it("rejects a contributed implementation source without instance-name acceptance", () => {
    const applied = applyToolGroups({
      manifestTools: {},
      capabilities: { bash: "*" },
      groups: [
        {
          label: "skill 'trojan'",
          tools: {
            payload: {
              provider: { path: "./payload" },
              tool: "bash",
              capabilities: {},
            },
          },
        },
      ],
    });
    // ceiling.bash exists, but the underlying-name fallback must not widen
    // acceptance for contributed code — only `payload = ...` would.
    const verdict = applied.verdicts[0]!;
    expect(verdict.accepted).toBe(false);
    expect(verdict.declarations[0]?.reason).toContain(
      "ships its own implementation",
    );
    expect(verdict.declarations[0]?.remediation).toBe("payload = { }");
    expect(applied.tools).toEqual({});
  });

  it("accepts a contributed implementation source named in the ceiling", () => {
    const applied = applyToolGroups({
      manifestTools: {},
      capabilities: { echo: { args: "*" } },
      groups: [
        {
          label: "skill 'echo'",
          tools: {
            echo: {
              provider: { provider: "mcp-server", command: "node" },
              capabilities: { args: "*" },
            },
          },
        },
      ],
    });
    expect(applied.verdicts[0]).toEqual({
      label: "skill 'echo'",
      accepted: true,
      declarations: [
        { instance: "echo", underlying: "echo", ok: true, against: "echo" },
      ],
    });
    expect(applied.tools).toEqual({
      echo: {
        provider: { provider: "mcp-server", command: "node" },
        capabilities: { args: "*" },
      },
    });
  });

  it("substitutes group-local provider handles with their values", () => {
    const applied = applyToolGroups({
      manifestTools: {},
      capabilities: { echo: "*" },
      groups: [
        {
          label: "skill 'echo'",
          providers: {
            server: { provider: "mcp-server", command: "node" },
          },
          tools: {
            echo: { provider: "server", capabilities: "*" },
          },
        },
      ],
    });
    expect(applied.verdicts[0]?.accepted).toBe(true);
    expect(applied.tools).toEqual({
      echo: {
        provider: { provider: "mcp-server", command: "node" },
        capabilities: "*",
      },
    });
  });

  it("rejects a provider-less declaration with no instance to match", () => {
    const applied = applyToolGroups({
      manifestTools: {},
      capabilities: { bash: { commands: "*" } },
      groups: [
        {
          label: "group 'orphan'",
          tools: { bash: { capabilities: { commands: ["jq"] } } },
        },
      ],
    });
    expect(applied.verdicts[0]?.accepted).toBe(false);
    expect(applied.verdicts[0]?.declarations[0]?.reason).toContain(
      "matches no existing tool instance",
    );
  });

  it("a group with no declarations is rejected rather than vacuously accepted", () => {
    const applied = applyToolGroups({
      manifestTools: {},
      capabilities: {},
      groups: [{ label: "group 'empty'", tools: {} }],
    });
    expect(applied.verdicts).toEqual([
      { label: "group 'empty'", accepted: false, declarations: [] },
    ]);
  });

  it("uses the tool algebra for matched-instance merges and asserts the law", () => {
    const lawBreaker = stubTool({
      name: "bash",
      mergeGrants: () => ({}),
    });
    expect(() =>
      applyToolGroups({
        manifestTools: {
          bash: { provider: "builtin", capabilities: { commands: ["a"] } },
        },
        capabilities: { bash: { commands: "*" } },
        groups: [
          {
            label: "group 'x'",
            tools: { bash: { capabilities: { commands: ["b"] } } },
          },
        ],
        toolFor: () => lawBreaker,
      }),
    ).toThrow(/merge law violated/);
  });
});

describe("collectToolGroups", () => {
  it("collects from a session and drops malformed entries", async () => {
    const session: Session = {
      tools: () => [
        { label: "good", tools: {} },
        { label: "", tools: {} },
        null as unknown as ToolGroup,
      ],
    };
    expect(await collectToolGroups(session)).toEqual([
      { label: "good", tools: {} },
    ]);
  });

  it("runs groups through the manifest parser: bad grammar drops the group", async () => {
    const groups: ToolGroup[] = [
      {
        label: "smuggler",
        tools: {
          x: { provider: "builtin", api_key: "hunter2" },
        } as unknown as ToolGroup["tools"],
      },
      {
        label: "reserved-handle",
        providers: { builtin: { provider: "mcp-server" } },
        tools: { x: { provider: "builtin" } },
      },
      {
        label: "fine",
        providers: { server: { provider: "mcp-server", command: "node" } },
        tools: { x: { provider: "server" } },
      },
    ];
    const session: Session = { tools: () => groups };
    const collected = await collectToolGroups(session);
    expect(collected.map((g) => g.label)).toEqual(["fine"]);
  });

  it("returns empty for sessions without the hook", async () => {
    expect(await collectToolGroups({})).toEqual([]);
  });
});

describe("toolGroupQualifies", () => {
  const ceiling: Capabilities = {
    read_file: { paths: ["./"] },
  };

  it("passes a contained declaration and fails an exceeding one", () => {
    expect(
      toolGroupQualifies(
        {
          label: "x",
          tools: { read_file: { capabilities: { paths: ["./"] } } },
        },
        ceiling,
      ),
    ).toBe(true);
    expect(
      toolGroupQualifies(
        {
          label: "x",
          tools: { read_file: { capabilities: { paths: ["/etc"] } } },
        },
        ceiling,
      ),
    ).toBe(false);
  });

  it("bare entries qualify without a ceiling entry", () => {
    expect(
      toolGroupQualifies(
        { label: "x", tools: { send_dm: { provider: "session" } } },
        ceiling,
      ),
    ).toBe(true);
  });

  it("consults the tool algebra for refinement (path prefixes)", () => {
    const prefixAware = stubTool({
      containsGrant: (sup, sub) =>
        JSON.stringify(sup).includes("./") &&
        JSON.stringify(sub).includes("./sub"),
    });
    expect(
      toolGroupQualifies(
        {
          label: "x",
          tools: { read_file: { capabilities: { paths: ["./sub"] } } },
        },
        ceiling,
        () => prefixAware,
      ),
    ).toBe(true);
  });
});
