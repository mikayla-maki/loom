import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { installManifest } from "../src/cli/install.js";
import { runAgent } from "../src/sdk/run-agent.js";
import { useTmpDir } from "./helpers/tmp.js";

const NO_LOG = { log: () => {} };

async function buildFixturePackage(
  root: string,
  pkgRelDir = "pkg-a",
  pkgName = "fixture-pkg-a",
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

// Every manifest needs the same agent + harness preamble; callers supply
// only the lines that differ (name, tools, capabilities).
async function writeManifest(
  manifestPath: string,
  name: string,
  rest: string[],
) {
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  const lines = [
    "[agent]",
    `name = ${JSON.stringify(name)}`,
    'system_prompt = "x"',
    "[harness]",
    'provider = "test"',
    ...rest,
  ];
  await fs.writeFile(manifestPath, lines.join("\n"), "utf8");
}

describe("loom install", () => {
  const tmp = useTmpDir("loom-install-");

  it("does nothing for a builtin-only manifest but still writes a lockfile and .gitignore", async () => {
    const manifest = path.join(tmp(), "agent.toml");
    await writeManifest(manifest, "builtin-only", [
      "[tools]",
      'read_file = "builtin"',
    ]);

    const result = await installManifest(manifest, NO_LOG);
    expect(result.sources).toEqual([]);
    expect(result.ranNpmInstall).toBe(false);

    const lock = await fs.readFile(
      path.join(tmp(), ".loom", "lock.toml"),
      "utf8",
    );
    expect(lock).toContain("manifest_hash");

    const gitignore = await fs.readFile(
      path.join(tmp(), ".loom", ".gitignore"),
      "utf8",
    );
    expect(gitignore).toContain("node_modules/");
    expect(gitignore).toContain("package.json");
  });

  it("records path sources in lock.toml without copying anything", async () => {
    await buildFixturePackage(tmp());
    const manifest = path.join(tmp(), "agent", "agent.toml");
    await writeManifest(manifest, "path-source", [
      "[tools.fixture_tool]",
      'provider = { path = "../pkg-a" }',
      'greeting = "hello"',
    ]);

    const result = await installManifest(manifest, NO_LOG);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.spec).toBe("path:../pkg-a");
    expect(result.ranNpmInstall).toBe(false);

    const lock = await fs.readFile(
      path.join(tmp(), "agent", ".loom", "lock.toml"),
      "utf8",
    );
    expect(lock).toContain('spec = "path:../pkg-a"');
    expect(lock).toContain('location = "../pkg-a"');
  });

  it("rejects path sources that aren't loom provider packages", async () => {
    await fs.mkdir(path.join(tmp(), "not-a-package"), { recursive: true });
    const manifest = path.join(tmp(), "agent.toml");
    await writeManifest(manifest, "bad-path", [
      "[tools.x]",
      'provider = { path = "./not-a-package" }',
    ]);

    await expect(installManifest(manifest, NO_LOG)).rejects.toThrow(
      /does not contain a package.json/,
    );
  });

  it("--frozen errors when the lockfile is missing or the manifest has drifted", async () => {
    await buildFixturePackage(tmp());
    const manifest = path.join(tmp(), "agent", "agent.toml");
    await writeManifest(manifest, "frozen", [
      "[tools.fixture_tool]",
      'provider = { path = "../pkg-a" }',
    ]);

    await expect(
      installManifest(manifest, { ...NO_LOG, frozen: true }),
    ).rejects.toThrow(/lock\.toml.* missing/);

    await installManifest(manifest, NO_LOG);
    await fs.appendFile(manifest, "\n# drift\n", "utf8");
    await expect(
      installManifest(manifest, { ...NO_LOG, frozen: true }),
    ).rejects.toThrow(/manifest has changed/);
  });

  it("end-to-end: install a path source, then runAgent resolves the tool", async () => {
    await buildFixturePackage(tmp());
    const manifest = path.join(tmp(), "agent", "agent.toml");
    await writeManifest(manifest, "e2e", [
      'script = [[{ stop = "end_turn" }]]',
      "[tools.fixture_tool]",
      'provider = { path = "../pkg-a" }',
      'greeting = "yo"',
      "[capabilities]",
      'fixture_tool = "*"',
    ]);

    await installManifest(manifest, NO_LOG);
    const agent = await runAgent(manifest);
    try {
      const tools = agent.agentState.toolTable.list();
      expect(tools.find((x) => x.name === "fixture_tool")).toBeDefined();
    } finally {
      await agent.close();
    }
  });
});
