import { describe, expect, it, beforeAll, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";

import { BashTool, tokenizeSimpleCommand } from "../src/runtime/builtins/bash.js";
import { hasSandboxExec } from "../src/runtime/sandbox/sandbox-exec.js";
import { hasBwrap } from "../src/runtime/sandbox/bwrap.js";
import type { CapabilityGrant, CapabilitySet } from "../src/types/manifest.js";
import { makeCtx } from "./helpers/bash-integration.js";

// Execution tests engage the OS sandbox whenever the grant is structured
// (sandbox-exec on macOS, bwrap on Linux), mirroring bash-sandbox-integration.
let sandboxSupported = false;
beforeAll(async () => {
  if (process.platform === "darwin") sandboxSupported = await hasSandboxExec();
  else if (process.platform === "linux") sandboxSupported = await hasBwrap();
  else sandboxSupported = true;
});
const dit = (name: string, fn: () => void | Promise<void>): void => {
  it(name, async (ctx) => {
    if (!sandboxSupported) ctx.skip();
    await fn();
  });
};

describe("bash rows: strict tokenizer", () => {
  it("accepts plain words", () => {
    expect(tokenizeSimpleCommand("echo hello")).toEqual(["echo", "hello"]);
    expect(tokenizeSimpleCommand("gcalcli agenda --details length")).toEqual([
      "gcalcli",
      "agenda",
      "--details",
      "length",
    ]);
    expect(tokenizeSimpleCommand("ls -la ./src/file.txt")).toEqual([
      "ls",
      "-la",
      "./src/file.txt",
    ]);
    expect(
      tokenizeSimpleCommand("tool --opt=val user@host:90 a,b x+y%20"),
    ).toEqual(["tool", "--opt=val", "user@host:90", "a,b", "x+y%20"]);
  });

  it("collapses runs of spaces and tabs", () => {
    expect(tokenizeSimpleCommand("  echo \t hello  ")).toEqual([
      "echo",
      "hello",
    ]);
  });

  it("accepts single-quoted strings with metacharacters as literal data", () => {
    expect(tokenizeSimpleCommand("echo 'hello world'")).toEqual([
      "echo",
      "hello world",
    ]);
    expect(tokenizeSimpleCommand("echo '$HOME | ; > *'")).toEqual([
      "echo",
      "$HOME | ; > *",
    ]);
    expect(tokenizeSimpleCommand("echo ''")).toEqual(["echo", ""]);
  });

  it("accepts double-quoted strings without $, backtick, or backslash", () => {
    expect(tokenizeSimpleCommand('echo "hi there"')).toEqual([
      "echo",
      "hi there",
    ]);
    expect(tokenizeSimpleCommand('echo "a;b|c"')).toEqual(["echo", "a;b|c"]);
  });

  it("concatenates adjacent segments into one word", () => {
    expect(tokenizeSimpleCommand("echo a'b c'd")).toEqual(["echo", "ab cd"]);
    expect(tokenizeSimpleCommand('echo pre"mid dle"post')).toEqual([
      "echo",
      "premid dlepost",
    ]);
  });

  it("refuses empty and blank commands", () => {
    expect(tokenizeSimpleCommand("")).toBeNull();
    expect(tokenizeSimpleCommand("   \t ")).toBeNull();
  });

  it("refuses metacharacters outside quotes", () => {
    const refused = [
      "echo hi | wc -l",
      "a; b",
      "a && b",
      "a & b",
      "cat < x",
      "echo hi > x",
      "(ls)",
      "echo $(date)",
      "echo $HOME",
      "echo `date`",
      "echo *",
      "ls ?",
      "echo ~",
      "echo {a,b}",
      "echo \\n",
      "echo hi\nls",
      "echo a#b",
      "echo [abc]",
      "echo a!b",
    ];
    for (const command of refused) {
      expect(tokenizeSimpleCommand(command), command).toBeNull();
    }
  });

  it("refuses unsafe content inside double quotes", () => {
    expect(tokenizeSimpleCommand('echo "hi $USER"')).toBeNull();
    expect(tokenizeSimpleCommand('echo "tick `date`"')).toBeNull();
    expect(tokenizeSimpleCommand('echo "back\\slash"')).toBeNull();
  });

  it("refuses unterminated quotes", () => {
    expect(tokenizeSimpleCommand("echo 'open")).toBeNull();
    expect(tokenizeSimpleCommand('echo "open')).toBeNull();
  });

  it("refuses env-assignment prefixes", () => {
    expect(tokenizeSimpleCommand("FOO=bar echo hi")).toBeNull();
    expect(tokenizeSimpleCommand("FOO=bar")).toBeNull();
    expect(tokenizeSimpleCommand("_X9=1 ls")).toBeNull();
  });
});

describe("bash rows: dispatch", () => {
  const PROBE = "BASH_ROWS_PROBE";

  beforeEach(() => {
    process.env[PROBE] = "row-grant-env";
  });
  afterEach(() => {
    delete process.env[PROBE];
  });

  dit("promotion runs argv[0] under the matching row's env", async () => {
    const tool = new BashTool({}, [
      { commands: "*", paths: "*", env: [] },
      { commands: ["/usr/bin/printenv"], paths: "*", env: [PROBE] },
    ]);
    const r = await tool.execute(
      { command: `/usr/bin/printenv ${PROBE}` },
      makeCtx(),
    );
    expect(r.isError).toBeFalsy();
    expect((r.content as string).trim()).toBe("row-grant-env");
  });

  dit(
    "the same command inside a pipeline runs under the general row instead",
    async () => {
      const tool = new BashTool({}, [
        { commands: "*", paths: "*", env: [] },
        { commands: ["/usr/bin/printenv"], paths: "*", env: [PROBE] },
      ]);
      const r = await tool.execute(
        { command: `/usr/bin/printenv ${PROBE} | /bin/cat` },
        makeCtx(),
      );
      expect(r.isError).toBeFalsy();
      expect((r.content as string).trim()).toBe("");
    },
  );

  dit("promoted quoting is passed through literally (no shell)", async () => {
    const tool = new BashTool({}, [
      { commands: ["echo"], paths: "*", env: "*" },
      { commands: ["true"], paths: "*", env: "*" },
    ]);
    const r = await tool.execute(
      { command: `echo 'a b' "c d" e` },
      makeCtx(),
    );
    expect(r.isError).toBeFalsy();
    expect((r.content as string).trim()).toBe("a b c d e");
  });

  dit("complex commands fall back to the general row's shell", async () => {
    const tool = new BashTool({}, [
      { commands: "*", paths: "*", env: "*" },
      { commands: ["echo"], paths: "*", env: "*" },
    ]);
    const r = await tool.execute(
      { command: "echo loud | tr a-z A-Z" },
      makeCtx(),
    );
    expect(r.isError).toBeFalsy();
    expect((r.content as string).trim()).toBe("LOUD");
  });

  dit("promoted command works with no general row present", async () => {
    const tool = new BashTool({}, [
      { commands: ["echo"], paths: "*", env: "*" },
      { commands: ["true"], paths: "*", env: "*" },
    ]);
    const r = await tool.execute({ command: "echo hi" }, makeCtx());
    expect(r.isError).toBeFalsy();
    expect((r.content as string).trim()).toBe("hi");
  });

  it("refuses complex commands when no general row exists", async () => {
    const tool = new BashTool({}, [
      { commands: ["true"], paths: "*" },
      { commands: ["gcalcli"], network: "*", paths: ["~/.gcalcli"] },
    ]);
    const r = await tool.execute({ command: "ls | wc" }, makeCtx());
    expect(r.isError).toBe(true);
    expect(r.content).toBe(
      "bash: this grant only allows direct invocation of: true, gcalcli. " +
        "Call it as a plain command (no pipes, substitutions, or interpreters) to use its grant.",
    );
  });

  it("refuses simple commands not granted by any row when no general row exists", async () => {
    const tool = new BashTool({}, [
      { commands: ["true"], paths: "*" },
      { commands: ["gcalcli"], network: "*", paths: ["~/.gcalcli"] },
    ]);
    const r = await tool.execute({ command: "rm -rf ./x" }, makeCtx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("only allows direct invocation of: true, gcalcli");
  });
});

describe("bash rows: containsGrant", () => {
  const tool = new BashTool({}, { commands: "*" });
  const contains = (
    superset: CapabilitySet | undefined,
    subset: CapabilitySet,
  ): boolean => tool.containsGrant(superset, subset);

  it("'*' contains everything; nothing else contains '*'", () => {
    expect(contains("*", "*")).toBe(true);
    expect(contains("*", { commands: "*", paths: "*", env: "*" })).toBe(true);
    expect(contains({ commands: "*", paths: "*" }, "*")).toBe(false);
    expect(contains(undefined, "*")).toBe(false);
  });

  it("undefined superset contains only empty requests", () => {
    expect(contains(undefined, {})).toBe(true);
    expect(contains(undefined, [{}, {}])).toBe(true);
    expect(contains(undefined, { commands: "*" })).toBe(false);
  });

  it("a row contains itself", () => {
    const row: CapabilityGrant = {
      commands: ["gcalcli"],
      network: "*",
      paths: ["~/.gcalcli"],
    };
    expect(contains(row, row)).toBe(true);
  });

  it("absent kinds in the superset deny, even for empty requests of that kind", () => {
    expect(contains({ commands: "*" }, { commands: "*", network: [] })).toBe(
      false,
    );
    expect(contains({ commands: "*" }, { commands: "*", env: [] })).toBe(false);
    expect(
      contains({ commands: "*", network: [] }, { commands: "*", network: [] }),
    ).toBe(true);
  });

  it("commands compare as '*'-absorbing arrays", () => {
    expect(contains({ commands: ["a", "b"] }, { commands: ["b"] })).toBe(true);
    expect(contains({ commands: ["a", "b"] }, { commands: ["c"] })).toBe(false);
    expect(contains({ commands: "*" }, { commands: ["x"] })).toBe(true);
    expect(contains({ commands: ["x"] }, { commands: "*" })).toBe(false);
  });

  it("network and env follow the default value rules", () => {
    expect(
      contains(
        { commands: "*", network: "*" },
        { commands: "*", network: ["example.com"] },
      ),
    ).toBe(true);
    expect(
      contains(
        { commands: "*", network: ["a", "b"] },
        { commands: "*", network: ["a"] },
      ),
    ).toBe(true);
    expect(
      contains(
        { commands: "*", network: ["a"] },
        { commands: "*", network: ["c"] },
      ),
    ).toBe(false);
    expect(
      contains({ commands: "*", env: ["PATH"] }, { commands: "*", env: "*" }),
    ).toBe(false);
  });

  it("paths compare by filesystem prefix", () => {
    expect(
      contains(
        { commands: "*", paths: ["/tmp/work"] },
        { commands: "*", paths: ["/tmp/work/sub/deep"] },
      ),
    ).toBe(true);
    expect(
      contains(
        { commands: "*", paths: ["/tmp/work"] },
        { commands: "*", paths: ["/tmp/work"] },
      ),
    ).toBe(true);
    expect(
      contains(
        { commands: "*", paths: ["/tmp/work"] },
        { commands: "*", paths: ["/tmp/workother"] },
      ),
    ).toBe(false);
    expect(
      contains(
        { commands: "*", paths: "*" },
        { commands: "*", paths: ["/anywhere"] },
      ),
    ).toBe(true);
    expect(
      contains(
        { commands: "*", paths: ["/tmp"] },
        { commands: "*", paths: "*" },
      ),
    ).toBe(false);
  });

  it("paths expand ~ and resolve relative segments", () => {
    expect(
      contains(
        { commands: "*", paths: ["~"] },
        { commands: "*", paths: [path.join(os.homedir(), "anything")] },
      ),
    ).toBe(true);
    expect(
      contains(
        { commands: "*", paths: ["./"] },
        { commands: "*", paths: ["./src"] },
      ),
    ).toBe(true);
  });

  it("every subset row must fit within a single superset row", () => {
    const supersetRows: CapabilitySet = [
      { commands: "*", paths: ["/a"] },
      { commands: ["x"], network: "*", paths: ["/b"] },
    ];
    expect(
      contains(supersetRows, {
        commands: ["x"],
        network: "*",
        paths: ["/b/sub"],
      }),
    ).toBe(true);
    // Needs row 1's path and row 2's network — rows never combine.
    expect(
      contains(supersetRows, { commands: ["x"], network: "*", paths: ["/a"] }),
    ).toBe(false);
    expect(contains(supersetRows, supersetRows)).toBe(true);
  });
});

describe("bash rows: mergeGrants", () => {
  const tool = new BashTool({}, { commands: "*" });
  const rowA: CapabilityGrant = { commands: "*", paths: ["./"] };
  const rowB: CapabilityGrant = {
    commands: ["gcalcli"],
    network: "*",
    paths: ["~/.gcalcli"],
  };

  it("unions distinct rows", () => {
    expect(tool.mergeGrants(rowA, rowB)).toEqual([rowA, rowB]);
  });

  it("deduplicates identical rows back to a single grant", () => {
    expect(tool.mergeGrants(rowA, { ...rowA })).toEqual(rowA);
  });

  it("'*' absorbs", () => {
    expect(tool.mergeGrants("*", rowB)).toBe("*");
    expect(tool.mergeGrants(rowA, "*")).toBe("*");
  });

  it("merging a row set with one of its rows is a no-op", () => {
    expect(tool.mergeGrants([rowA, rowB], rowB)).toEqual([rowA, rowB]);
  });

  it("satisfies the merge law under containsGrant", () => {
    const merged = tool.mergeGrants(rowA, rowB);
    expect(tool.containsGrant(merged, rowA)).toBe(true);
    expect(tool.containsGrant(merged, rowB)).toBe(true);
  });
});

describe("bash rows: description and schema", () => {
  it("multi-row grants keep the free-form shell schema", () => {
    const tool = new BashTool({}, [
      { commands: "*", paths: ["./"] },
      { commands: ["gcalcli"], network: "*", paths: ["~/.gcalcli"] },
    ]);
    expect(tool.inputSchema).toMatchObject({
      type: "object",
      required: ["command"],
    });
  });

  it("describes per-command rows after the general row", () => {
    const tool = new BashTool({}, [
      { commands: "*", paths: ["./"] },
      { commands: ["gcalcli"], network: "*", paths: ["~/.gcalcli"] },
    ]);
    expect(tool.description).toContain(
      "Run a bash command in a sandboxed environment.",
    );
    expect(tool.description).toContain(
      "Additionally, these commands may be invoked directly " +
        "(plain `cmd args...` form only) with their own grants: " +
        "`gcalcli` (network access; filesystem: ~/.gcalcli).",
    );
  });

  it("describes a row set with no general row as direct-invocation only", () => {
    const tool = new BashTool({}, [
      { commands: ["true"], paths: "*" },
      { commands: ["gcalcli"], network: "*", paths: ["~/.gcalcli"] },
    ]);
    expect(tool.description).toContain(
      "Run one of these commands directly (plain `cmd args...` form only;",
    );
    expect(tool.description).toContain("`true` (unrestricted filesystem)");
    expect(tool.description).toContain(
      "`gcalcli` (network access; filesystem: ~/.gcalcli)",
    );
  });
});

describe("bash rows: single-grant back-compat", () => {
  it("a plain grant keeps the shell description with no row suffix", () => {
    const tool = new BashTool({}, { commands: "*", paths: ["./"] });
    expect(tool.description).toContain(
      "Run a bash command in a sandboxed environment.",
    );
    expect(tool.description).not.toContain("Additionally");
    expect(tool.inputSchema).toMatchObject({ required: ["command"] });
  });

  it("a single-command grant keeps argv mode", () => {
    const tool = new BashTool({}, { commands: ["pwd"], paths: ["./"] });
    const props = (tool.inputSchema as Record<string, unknown>)
      .properties as Record<string, unknown>;
    expect(props.command).toBeUndefined();
    expect(props.args).toBeDefined();
    expect(tool.description).toContain("`pwd`");
  });

  it("a one-row set behaves exactly like the bare grant", () => {
    const grant: CapabilityGrant = { commands: ["pwd"], paths: ["./"] };
    const bare = new BashTool({}, grant);
    const wrapped = new BashTool({}, [grant]);
    expect(wrapped.description).toBe(bare.description);
    expect(wrapped.inputSchema).toEqual(bare.inputSchema);
  });

  dit("shell mode still evaluates shell syntax under a single grant", async () => {
    const tool = new BashTool(
      {},
      { commands: "*", paths: "*", network: "*", env: "*" },
    );
    const r = await tool.execute({ command: "echo $((1+1))" }, makeCtx());
    expect(r.isError).toBeFalsy();
    expect((r.content as string).trim()).toBe("2");
  });
});

describe("bash rows: audit", () => {
  it("a structured row set does not trigger the unsandboxed warning", async () => {
    const tool = new BashTool({}, [
      { commands: "*", paths: ["./"] },
      { commands: ["gcalcli"], network: "*", paths: ["~/.gcalcli"] },
    ]);
    const findings = await tool.audit();
    expect(
      findings.some((f) => f.message.includes('capabilities = "*"')),
    ).toBe(false);
  });

  it("env = '*' in any row triggers the env warning", async () => {
    const tool = new BashTool({}, [
      { commands: "*", paths: ["./"] },
      { commands: ["gcalcli"], network: "*", env: "*" },
    ]);
    const findings = await tool.audit();
    expect(findings.some((f) => f.message.startsWith('env = "*"'))).toBe(true);
  });
});
