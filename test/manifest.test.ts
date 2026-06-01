import { describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { parseAgentManifest } from "../src/manifest/parser.js";
import { ManifestError } from "../src/errors.js";
import { useTmpDir } from "./helpers/tmp.js";

const FIXTURES = path.resolve("test/fixtures");

type Layers = Array<{ provider: unknown; [k: string]: unknown }>;

describe("agent.toml parser", () => {
  const tmp = useTmpDir("loom-manifest-");

  async function writeManifest(body: string): Promise<string> {
    const p = path.join(tmp(), "agent.toml");
    await fs.writeFile(p, body, "utf8");
    return p;
  }

  it("parses the sample agent.toml", async () => {
    const m = await parseAgentManifest(
      path.join(FIXTURES, "sample-agent/agent.toml"),
    );
    expect(m.name).toBe("sample-agent");
    if ("provider" in m.harness) expect(m.harness.provider).toBe("test");
    if (m.session && "provider" in m.session)
      expect(m.session.provider).toBe("file");
    expect(m.secrets).toEqual(["sample_user_name"]);
    expect(m.capabilities?.read_file).toEqual({ paths: ["./"] });
    expect(m.capabilities?.write_file).toEqual({ paths: ["./"] });
    expect(m.capabilities?.edit_file).toEqual({ paths: ["./"] });
    expect(m.capabilities?.find).toEqual({ paths: ["./"] });
    expect(m.tools).toEqual({
      read_file: "builtin",
      write_file: "builtin",
      edit_file: "builtin",
      find: "builtin",
    });
  });

  it("rejects manifests missing required sections", async () => {
    const p = await writeManifest('[agent]\nname = "x"\n[harness]\n');
    await expect(parseAgentManifest(p)).rejects.toThrow(ManifestError);
  });

  it("parses [tools] string shorthand as bare provider refs", async () => {
    const p = await writeManifest(`[agent]
name = "with-tools"
system_prompt = "x"

[harness]
provider = "test"
[tools]
bash = "builtin"
my_thing = "./local-tool"
`);
    const m = await parseAgentManifest(p);
    expect(m.tools).toEqual({
      bash: "builtin",
      my_thing: "./local-tool",
    });
  });

  it("parses tool entries with inline SourceSpec table providers", async () => {
    const p = await writeManifest(`[agent]
name = "with-tools-tbl"
system_prompt = "x"

[harness]
provider = "test"

[tools.fs_read]
provider = { npm = "@my-org/mcp" }
server = "stdio"

[tools.local_grep]
provider = { path = "../my-fast-grep" }
flags = ["-i"]
`);
    const m = await parseAgentManifest(p);
    expect(m.tools).toEqual({
      fs_read: {
        provider: { npm: "@my-org/mcp" },
        server: "stdio",
      },
      local_grep: {
        provider: { path: "../my-fast-grep" },
        flags: ["-i"],
      },
    });
  });

  it("rejects [tools.X] entries with an empty table", async () => {
    const p = await writeManifest(`[agent]
name = "empty-entry"
system_prompt = "x"
[harness]
provider = "test"
[tools]
bash = {}
`);
    await expect(parseAgentManifest(p)).rejects.toThrow(
      /\[tools\]\.bash is missing required 'provider' field/,
    );
  });

  it("rejects stray keys in a SourceSpec table", async () => {
    const p = await writeManifest(`[agent]
name = "stray"
system_prompt = "x"
[harness]
provider = { npm = "@my-org/harness", greeting = "hi" }
`);
    await expect(parseAgentManifest(p)).rejects.toThrow(/is not a known key/);
  });

  it("distinguishes absent [tools] (defaults) from empty [tools] (opt-out)", async () => {
    const absent = path.join(tmp(), "absent.toml");
    await fs.writeFile(
      absent,
      `[agent]
name = "absent"
system_prompt = "x"
[harness]
provider = "test"
`,
      "utf8",
    );
    expect((await parseAgentManifest(absent)).tools).toBeUndefined();

    const empty = path.join(tmp(), "empty.toml");
    await fs.writeFile(
      empty,
      `[agent]
name = "empty"
system_prompt = "x"
[harness]
provider = "test"
[tools]
`,
      "utf8",
    );
    expect((await parseAgentManifest(empty)).tools).toEqual({});
  });

  it("parses system_prompt as a literal string (inline or path-like)", async () => {
    const inline = await parseAgentManifest(
      await writeManifest(`[agent]
name = "x"
system_prompt = "You are a friendly demo agent."
[harness]
provider = "test"
`),
    );
    expect(inline.systemPrompt).toBe("You are a friendly demo agent.");

    const pathLike = await parseAgentManifest(
      await writeManifest(`[agent]
name = "x"
system_prompt = "./prompt.md"
[harness]
provider = "test"
`),
    );
    expect(pathLike.systemPrompt).toBe("./prompt.md");
  });

  describe("[session] layers", () => {
    it("parses [[session.layers]] array-of-tables", async () => {
      const p = await writeManifest(`[agent]
name = "layered"
system_prompt = "x"
[harness]
provider = "test"

[[session.layers]]
provider = "compacting"
threshold = 60

[[session.layers]]
provider = "in-memory"
`);
      const m = await parseAgentManifest(p);
      expect(Array.isArray(m.session)).toBe(true);
      const layers = m.session as Layers;
      expect(layers).toHaveLength(2);
      expect(layers[0]).toMatchObject({ provider: "compacting", threshold: 60 });
      expect(layers[1]).toMatchObject({ provider: "in-memory" });
    });

    it("parses inline layers in string, table, and mixed forms", async () => {
      const strings = (await parseAgentManifest(
        await writeManifest(`[agent]
name = "inline-strings"
system_prompt = "x"
[harness]
provider = "test"

[session]
layers = ["skills", "compacting", "in-memory"]
`),
      )).session as Layers;
      expect(strings).toEqual([
        { provider: "skills" },
        { provider: "compacting" },
        { provider: "in-memory" },
      ]);

      const tables = (await parseAgentManifest(
        await writeManifest(`[agent]
name = "inline-tables"
system_prompt = "x"
[harness]
provider = "test"

[session]
layers = [
  { provider = "compacting", threshold = 60 },
  { provider = "file", path = "./s.jsonl" },
]
`),
      )).session as Layers;
      expect(tables).toEqual([
        { provider: "compacting", threshold: 60 },
        { provider: "file", path: "./s.jsonl" },
      ]);

      const mixed = (await parseAgentManifest(
        await writeManifest(`[agent]
name = "mixed"
system_prompt = "x"
[harness]
provider = "test"

[session]
layers = [
  "compacting",
  { provider = "identity", vault_path = "/vault" },
  "dms",
]
`),
      )).session as Layers;
      expect(mixed).toEqual([
        { provider: "compacting" },
        { provider: "identity", vault_path: "/vault" },
        { provider: "dms" },
      ]);
    });

    it("merges [session.<name>] sibling tables into matching string layers", async () => {
      const p = await writeManifest(`[agent]
name = "siblings"
system_prompt = "x"
[harness]
provider = "test"

[session]
layers = ["compacting", "identity", "dms"]

[session.identity]
vault_path = "/some/vault"

[session.compacting]
keep = 50
persist = true
`);
      const layers = (await parseAgentManifest(p)).session as Layers;
      expect(layers).toEqual([
        { provider: "compacting", keep: 50, persist: true },
        { provider: "identity", vault_path: "/some/vault" },
        { provider: "dms" },
      ]);
    });

    it("rejects [session.<name>] with no matching string layer", async () => {
      const p = await writeManifest(`[agent]
name = "typo"
system_prompt = "x"
[harness]
provider = "test"

[session]
layers = ["compacting", "in-memory"]

[session.identitiy]
vault_path = "/v"
`);
      await expect(parseAgentManifest(p)).rejects.toThrow(
        /no matching string entry/,
      );
    });

    it("rejects [session.<name>] conflicting with an inline-table layer", async () => {
      const p = await writeManifest(`[agent]
name = "split"
system_prompt = "x"
[harness]
provider = "test"

[session]
layers = [
  { provider = "identity", inline_key = "a" },
]

[session.identity]
vault_path = "/v"
`);
      await expect(parseAgentManifest(p)).rejects.toThrow(
        /conflicts with an inline-table entry/,
      );
    });

    it("rejects [session.<name>] that overrides the provider field", async () => {
      const p = await writeManifest(`[agent]
name = "override"
system_prompt = "x"
[harness]
provider = "test"

[session]
layers = ["identity"]

[session.identity]
provider = "something_else"
`);
      await expect(parseAgentManifest(p)).rejects.toThrow(
        /\.provider is not allowed/,
      );
    });

    it("rejects stray scalar keys on [session] outside meta fields", async () => {
      const p = await writeManifest(`[agent]
name = "stray"
system_prompt = "x"
[harness]
provider = "test"

[session]
layers = ["in-memory"]
timeout = 30
`);
      await expect(parseAgentManifest(p)).rejects.toThrow(
        /not a recognised meta key/,
      );
    });

    it("rejects empty [session].layers", async () => {
      const p = await writeManifest(`[agent]
name = "empty"
system_prompt = "x"
[harness]
provider = "test"
[session]
layers = []
`);
      await expect(parseAgentManifest(p)).rejects.toThrow(
        /\[session\]\.layers is empty/,
      );
    });

    it("rejects the old top-level [[session]] form", async () => {
      const p = await writeManifest(`[agent]
name = "old-chain"
system_prompt = "x"
[harness]
provider = "test"

[[session]]
provider = "compacting"

[[session]]
provider = "in-memory"
`);
      await expect(parseAgentManifest(p)).rejects.toThrow(
        /\[session\] with a 'layers' array/,
      );
    });
  });

  it("parses a singleton [session] (provider only) as a single SessionSpec", async () => {
    const p = await writeManifest(`[agent]
name = "single"
system_prompt = "x"
[harness]
provider = "test"

[session]
provider = "in-memory"
`);
    const m = await parseAgentManifest(p);
    expect(Array.isArray(m.session)).toBe(false);
    if (m.session && "provider" in m.session) {
      expect(m.session.provider).toBe("in-memory");
    } else {
      throw new Error("expected SessionSpec");
    }
  });

  it("rejects [session] with both 'provider' and 'layers'", async () => {
    const p = await writeManifest(`[agent]
name = "both"
system_prompt = "x"
[harness]
provider = "test"
[session]
provider = "in-memory"
layers = ["compacting", "in-memory"]
`);
    await expect(parseAgentManifest(p)).rejects.toThrow(
      /has both 'provider' and 'layers'/,
    );
  });

  it("rejects [session] with neither 'provider' nor 'layers'", async () => {
    const p = await writeManifest(`[agent]
name = "neither"
system_prompt = "x"
[harness]
provider = "test"
[session]
`);
    await expect(parseAgentManifest(p)).rejects.toThrow(
      /missing both 'provider' and 'layers'/,
    );
  });

  describe("[providers]", () => {
    it("parses configured-factory and SourceSpec forms together", async () => {
      const p = await writeManifest(`[agent]
name = "prov-mixed"
system_prompt = "x"
[harness]
provider = "test"

[providers]
fs_mcp = { provider = "test-meta", npm = "@example/mcp-fs" }
linear = { provider = "test-meta", command = "npx", args = ["@linear/mcp"] }
local = { path = "./my-tools" }
npm_thing = "@scope/pkg"
`);
      const m = await parseAgentManifest(p);
      expect(m.providers).toEqual({
        fs_mcp: { provider: "test-meta", npm: "@example/mcp-fs" },
        linear: { provider: "test-meta", command: "npx", args: ["@linear/mcp"] },
        local: { path: "./my-tools" },
        npm_thing: "@scope/pkg",
      });
    });

    it("rejects bare-handle strings as entries", async () => {
      const p = await writeManifest(`[agent]
name = "prov-bare"
system_prompt = "x"
[harness]
provider = "test"

[providers]
oops = "some_handle"
`);
      await expect(parseAgentManifest(p)).rejects.toThrow(
        /Bare handles aren't allowed at this layer/,
      );
    });
  });

  describe("[agent].storage_id", () => {
    it("parses an override", async () => {
      const p = await writeManifest(`[agent]
name = "x"
storage_id = "pinned-id"
[harness]
provider = "test"
`);
      expect((await parseAgentManifest(p)).storageId).toBe("pinned-id");
    });

    it("rejects path separators", async () => {
      const p = await writeManifest(`[agent]
name = "x"
storage_id = "../escape"
[harness]
provider = "test"
`);
      await expect(parseAgentManifest(p)).rejects.toThrow(
        /storage_id.*path separator/,
      );
    });
  });

  describe("[agent.metadata]", () => {
    it("parses tables as opaque passthrough and omits when absent", async () => {
      const withMeta = await parseAgentManifest(
        await writeManifest(`[agent]
name = "meta"

[agent.metadata]
team = "platform-eng"
release_channel = "canary"
owners = ["alice", "bob"]
rollout = { region = "us-east-1", percent = 25 }

[harness]
provider = "test"
`),
      );
      expect(withMeta.metadata).toEqual({
        team: "platform-eng",
        release_channel: "canary",
        owners: ["alice", "bob"],
        rollout: { region: "us-east-1", percent: 25 },
      });

      const noMeta = await parseAgentManifest(
        await writeManifest(`[agent]
name = "no-meta"
[harness]
provider = "test"
`),
      );
      expect(noMeta.metadata).toBeUndefined();
    });

    it("rejects scalar values", async () => {
      const p = await writeManifest(`[agent]
name = "bad-meta"
metadata = "not-a-table"
[harness]
provider = "test"
`);
      await expect(parseAgentManifest(p)).rejects.toThrow(
        /\[agent\.metadata\] must be a table/,
      );
    });
  });

  describe("env-var substitution", () => {
    async function withEnv(
      vars: Record<string, string | undefined>,
      fn: () => Promise<void>,
    ): Promise<void> {
      const prev: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(vars)) {
        prev[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      try {
        await fn();
      } finally {
        for (const [k, v] of Object.entries(prev)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    }

    it("substitutes ${VAR} in string values, arrays, and nested tables", async () => {
      await withEnv(
        { LOOM_TEST_VAULT_PATH: "/tmp/glass-vault", LOOM_TEST_PATH: "/tmp/loom-test" },
        async () => {
          const m = await parseAgentManifest(
            await writeManifest(`[agent]
name = "env-sub"
system_prompt = "vault: \${LOOM_TEST_VAULT_PATH}"
[harness]
provider = "test"
[capabilities]
read_file = { paths = ["\${LOOM_TEST_PATH}", "./local"] }
`),
          );
          expect(m.systemPrompt).toBe("vault: /tmp/glass-vault");
          expect(m.capabilities?.read_file).toEqual({
            paths: ["/tmp/loom-test", "./local"],
          });
        },
      );
    });

    it("resolves ${VAR:-default} to the env value or the fallback", async () => {
      await withEnv(
        { LOOM_TEST_SET: "real", LOOM_TEST_UNSET: undefined },
        async () => {
          const set = await parseAgentManifest(
            await writeManifest(`[agent]
name = "env-set"
system_prompt = "\${LOOM_TEST_SET:-fallback}"
[harness]
provider = "test"
`),
          );
          expect(set.systemPrompt).toBe("real");

          const unset = await parseAgentManifest(
            await writeManifest(`[agent]
name = "env-default"
system_prompt = "\${LOOM_TEST_UNSET:-fallback text}"
[harness]
provider = "test"
`),
          );
          expect(unset.systemPrompt).toBe("fallback text");
        },
      );
    });

    it("throws ManifestError when a required ${VAR} is unset", async () => {
      await withEnv({ LOOM_TEST_MISSING: undefined }, async () => {
        const p = await writeManifest(`[agent]
name = "env-missing"
system_prompt = "\${LOOM_TEST_MISSING}"
[harness]
provider = "test"
`);
        await expect(parseAgentManifest(p)).rejects.toThrow(
          /undefined env var 'LOOM_TEST_MISSING'/,
        );
      });
    });

    it("substitutes values only, leaving ${VAR}-shaped keys literal", async () => {
      await withEnv({ LOOM_TEST_KEY: "oops" }, async () => {
        const m = await parseAgentManifest(
          await writeManifest(`[agent]
name = "env-keys"
[harness]
provider = "test"
[agent.metadata]
"\${LOOM_TEST_KEY}" = "value"
`),
        );
        expect(Object.keys(m.metadata ?? {})).toContain("${LOOM_TEST_KEY}");
      });
    });
  });
});
