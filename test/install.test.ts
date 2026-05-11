/**
 * `loom install` — the v3 manifest-dep installer.
 *
 * Tests use path sources (no network). The npm flow is exercised by
 * skipping the actual `npm install` step but still writing the
 * generated `.loom/package.json` and `lock.toml`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { installManifest } from "../src/cli/install.js";
import { runAgent } from "../src/sdk/run-agent.js";

let TMP: string;

beforeEach(async () => {
  TMP = await fs.mkdtemp(path.join(os.tmpdir(), "loom-install-"));
});

afterEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

/**
 * Build a minimal Loom provider package at `<root>/<pkgRelDir>`.
 * Mirrors the fixture in extension-loader.test.ts: registers a Tools
 * contribution that claims a single tool by name, configurable via
 * the tool entry's per-tool config.
 */
async function buildFixturePackage(
  root: string,
  pkgRelDir: string,
  pkgName: string,
): Promise<string> {
  const dir = path.join(root, pkgRelDir);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name: pkgName,
        version: "0.1.0",
        type: "module",
        main: "./index.js",
        loom: { provider: "./index.js" },
      },
      null,
      2,
    ),
    "utf8",
  );
  await fs.writeFile(
    path.join(dir, "index.js"),
    `export function register(api) {
  api.registerTools({
    name: ${JSON.stringify(pkgName)},
    create(_cfg, _ctx, _secrets) {
      return {
        resolveTool(name, config) {
          if (name !== "fixture_tool") return null;
          const greeting = (config && config.greeting) || "hi";
          return {
            name: "fixture_tool",
            description: "Test fixture tool",
            inputSchema: { type: "object", properties: {} },
            async execute() { return { content: greeting + ": ok" }; },
          };
        },
        async close() {},
      };
    },
  });
}
`,
    "utf8",
  );
  return dir;
}

describe("loom install", () => {
  it("does nothing for a manifest with only builtin sources", async () => {
    const manifest = path.join(TMP, "agent.toml");
    await fs.writeFile(
      manifest,
      [
        "[agent]",
        'name = "builtin-only"',
        'system_prompt = "x"',
        "[harness]",
        'provider = "test"',
        "[tools]",
        'read_file = "builtin"',
      ].join("\n"),
      "utf8",
    );
    const result = await installManifest(manifest, {
      log: () => {},
    });
    expect(result.sources).toEqual([]);
    expect(result.ranNpmInstall).toBe(false);
    // Empty lockfile is still written so `--frozen` has something to
    // verify against.
    const lock = await fs.readFile(
      path.join(TMP, ".loom", "lock.toml"),
      "utf8",
    );
    expect(lock).toContain("manifest_hash");
  });

  it("records path sources in lock.toml without copying anything", async () => {
    // Fixture package as a sibling to the agent directory.
    await buildFixturePackage(TMP, "pkg-a", "fixture-pkg-a");
    const agentDir = path.join(TMP, "agent");
    await fs.mkdir(agentDir, { recursive: true });
    const manifest = path.join(agentDir, "agent.toml");
    await fs.writeFile(
      manifest,
      [
        "[agent]",
        'name = "path-source"',
        'system_prompt = "x"',
        "[harness]",
        'provider = "test"',
        "[tools.fixture_tool]",
        'provider = { path = "../pkg-a" }',
        'greeting = "hello"',
      ].join("\n"),
      "utf8",
    );
    const result = await installManifest(manifest, {
      log: () => {},
    });
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.spec).toBe("path:../pkg-a");
    expect(result.ranNpmInstall).toBe(false);
    // The lockfile records the resolved location.
    const lock = await fs.readFile(
      path.join(agentDir, ".loom", "lock.toml"),
      "utf8",
    );
    expect(lock).toContain('spec = "path:../pkg-a"');
    expect(lock).toContain('location = "../pkg-a"');
  });

  it("rejects path sources that aren't loom provider packages", async () => {
    // Create a directory without a package.json.
    const bogus = path.join(TMP, "not-a-package");
    await fs.mkdir(bogus, { recursive: true });
    const manifest = path.join(TMP, "agent.toml");
    await fs.writeFile(
      manifest,
      [
        "[agent]",
        'name = "bad-path"',
        'system_prompt = "x"',
        "[harness]",
        'provider = "test"',
        "[tools.x]",
        'provider = { path = "./not-a-package" }',
      ].join("\n"),
      "utf8",
    );
    await expect(installManifest(manifest, { log: () => {} })).rejects.toThrow(
      /does not contain a package.json/,
    );
  });

  it("writes a .gitignore in .loom/ on first install", async () => {
    const manifest = path.join(TMP, "agent.toml");
    await fs.writeFile(
      manifest,
      [
        "[agent]",
        'name = "x"',
        'system_prompt = "x"',
        "[harness]",
        'provider = "test"',
      ].join("\n"),
      "utf8",
    );
    await installManifest(manifest, { log: () => {} });
    const gi = await fs.readFile(path.join(TMP, ".loom", ".gitignore"), "utf8");
    expect(gi).toContain("node_modules/");
    expect(gi).toContain("package.json");
  });

  it("--frozen errors out when the lockfile is missing", async () => {
    await buildFixturePackage(TMP, "pkg-a", "fixture-pkg-a");
    const agentDir = path.join(TMP, "agent");
    await fs.mkdir(agentDir, { recursive: true });
    const manifest = path.join(agentDir, "agent.toml");
    await fs.writeFile(
      manifest,
      [
        "[agent]",
        'name = "frozen-no-lock"',
        'system_prompt = "x"',
        "[harness]",
        'provider = "test"',
        "[tools.fixture_tool]",
        'provider = { path = "../pkg-a" }',
      ].join("\n"),
      "utf8",
    );
    await expect(
      installManifest(manifest, { frozen: true, log: () => {} }),
    ).rejects.toThrow(/lock\.toml.* missing/);
  });

  it("--frozen errors when the manifest has changed since install", async () => {
    await buildFixturePackage(TMP, "pkg-a", "fixture-pkg-a");
    const agentDir = path.join(TMP, "agent");
    await fs.mkdir(agentDir, { recursive: true });
    const manifest = path.join(agentDir, "agent.toml");
    await fs.writeFile(
      manifest,
      [
        "[agent]",
        'name = "drift"',
        'system_prompt = "x"',
        "[harness]",
        'provider = "test"',
        "[tools.fixture_tool]",
        'provider = { path = "../pkg-a" }',
      ].join("\n"),
      "utf8",
    );
    await installManifest(manifest, { log: () => {} }); // initial
    // Append a tweak to the manifest so the hash diverges.
    await fs.appendFile(manifest, "\n# drift\n", "utf8");
    await expect(
      installManifest(manifest, { frozen: true, log: () => {} }),
    ).rejects.toThrow(/manifest has changed/);
  });

  it("end-to-end: install a path source, then runAgent resolves the tool", async () => {
    // The .loom search-path entry is the magic that ties install
    // output to runtime resolution. For path sources we don't even
    // need install — the loader can find the package directly — but
    // we run install anyway to exercise the full flow.
    await buildFixturePackage(TMP, "pkg-a", "fixture-pkg-a");
    const agentDir = path.join(TMP, "agent");
    await fs.mkdir(agentDir, { recursive: true });
    const manifest = path.join(agentDir, "agent.toml");
    await fs.writeFile(
      manifest,
      [
        "[agent]",
        'name = "e2e"',
        'system_prompt = "x"',
        "[harness]",
        'provider = "test"',
        'script = [[{ stop = "end_turn" }]]',
        "[tools.fixture_tool]",
        'provider = { path = "../pkg-a" }',
        'greeting = "yo"',
        "[capabilities]",
        'fixture_tool = "*"',
      ].join("\n"),
      "utf8",
    );
    await installManifest(manifest, { log: () => {} });
    const agent = await runAgent(manifest);
    try {
      const tools = agent.agentState.toolTable.list();
      const t = tools.find((x) => x.name === "fixture_tool");
      expect(t).toBeDefined();
    } finally {
      await agent.close();
    }
  });
});
