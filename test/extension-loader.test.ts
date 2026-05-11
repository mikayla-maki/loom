import { describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

import {
  listInstalledProviders,
  loadProviderByName,
  locateProviderPackage,
} from "../src/providers/loader.js";
import { runAgent } from "../src/sdk/run-agent.js";
import { parseAgentManifest } from "../src/manifest/parser.js";
import { LoomError } from "../src/errors.js";

/**
 * Build a directory tree that looks like a node_modules folder, containing
 * a single Loom provider package. The package's `loom.provider` field
 * points at an entry that registers a Tools instance supplying a
 * synthetic tool.
 */
async function buildExtensionFixture(opts: {
  rootDir: string;
  packageName: string;
  scope?: string;
}): Promise<{ packageDir: string; nodeModulesDir: string }> {
  const nm = path.join(opts.rootDir, "node_modules");
  const dirName = opts.packageName;
  const packageDir = opts.scope
    ? path.join(nm, opts.scope, dirName)
    : path.join(nm, dirName);
  const fullName = opts.scope ? `${opts.scope}/${dirName}` : dirName;
  await fs.mkdir(packageDir, { recursive: true });
  await fs.writeFile(
    path.join(packageDir, "package.json"),
    JSON.stringify(
      {
        name: fullName,
        version: "0.1.0",
        description: "Synthetic Loom provider for tests",
        type: "module",
        main: "./index.js",
        loom: { provider: "./index.js" },
      },
      null,
      2,
    ),
  );
  // Entry: ESM module exporting register(). Registers a Tools
  // contribution via api.registerTools(); its Tools.resolveTool()
  // returns a synthetic 'fixture.echo' tool by name. v5: per-tool
  // config (`greeting`) flows into `Tools.resolveTool(name, config, …)`.
  await fs.writeFile(
    path.join(packageDir, "index.js"),
    `export function register(api) {
  api.registerTools({
    name: "${fullName}",
    create(_cfg, _ctx, _secrets) {
      return {
        resolveTool(name, config) {
          if (name !== "fixture.echo") return null;
          const greeting = config && typeof config.greeting === "string" ? config.greeting : "hi";
          return {
            name: "fixture.echo",
            description: "Echo with greeting prefix",
            inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
            async execute(input) {
              return { content: greeting + ": " + String((input || {}).text || "") };
            },
          };
        },
        async close() { /* noop */ },
      };
    },
  });
}
`,
  );
  return { packageDir, nodeModulesDir: nm };
}

describe("provider package loader", () => {
  it("locates and imports a package with loom.provider metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "loom-ext-loc-"));
    try {
      await buildExtensionFixture({
        rootDir: root,
        packageName: "fixture-loom-ext",
      });
      const info = await locateProviderPackage("fixture-loom-ext", {
        agentManifestDir: root,
      });
      expect(info.name).toBe("fixture-loom-ext");
      expect(info.entryPath).toMatch(/index\.js$/);
      expect(info.version).toBe("0.1.0");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("throws a clear error for missing packages", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "loom-ext-miss-"));
    try {
      await expect(
        locateProviderPackage("does-not-exist-loom-ext", {
          agentManifestDir: root,
        }),
      ).rejects.toThrow(/Cannot find Loom provider/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects packages without a loom.provider field (treats as 'not a provider')", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "loom-ext-nope-"));
    try {
      const nm = path.join(root, "node_modules", "boring-pkg");
      await fs.mkdir(nm, { recursive: true });
      await fs.writeFile(
        path.join(nm, "package.json"),
        JSON.stringify({
          name: "boring-pkg",
          version: "1.0.0",
          main: "./index.js",
        }),
      );
      await fs.writeFile(path.join(nm, "index.js"), "export const x = 1;");
      await expect(
        locateProviderPackage("boring-pkg", { agentManifestDir: root }),
      ).rejects.toThrow(/Cannot find Loom provider/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("supports scoped package names (@scope/name)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "loom-ext-scope-"));
    try {
      await buildExtensionFixture({
        rootDir: root,
        packageName: "fixture",
        scope: "@my-org",
      });
      const info = await locateProviderPackage("@my-org/fixture", {
        agentManifestDir: root,
      });
      expect(info.name).toBe("@my-org/fixture");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("listInstalledProviders enumerates packages with loom.provider metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "loom-ext-list-"));
    try {
      await buildExtensionFixture({ rootDir: root, packageName: "fixture-a" });
      await buildExtensionFixture({ rootDir: root, packageName: "fixture-b" });
      // A non-provider package alongside.
      const boring = path.join(root, "node_modules", "boring");
      await fs.mkdir(boring, { recursive: true });
      await fs.writeFile(
        path.join(boring, "package.json"),
        JSON.stringify({ name: "boring", version: "1.0.0" }),
      );
      const items = await listInstalledProviders(
        { agentManifestDir: root },
        { searchPaths: [path.join(root, "node_modules")] },
      );
      const names = items.map((i) => i.name);
      expect(names).toContain("fixture-a");
      expect(names).toContain("fixture-b");
      expect(names).not.toContain("boring");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("loadProviderByName executes register() and surfaces contributed Tools registrations", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "loom-ext-load-"));
    try {
      await buildExtensionFixture({
        rootDir: root,
        packageName: "register-side-effect-ext",
      });
      const { toolsContributions } = await loadProviderByName(
        "register-side-effect-ext",
        {
          agentManifestDir: root,
          agentName: "test",
          loomVersion: "0.1.0",
          providerName: "register-side-effect-ext",
        },
      );
      // The fixture's register() calls api.registerTools() with a
      // contribution whose name matches the package.
      const names = toolsContributions.map((f) => f.name);
      expect(names).toContain("register-side-effect-ext");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects packages whose entry doesn't export register()", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "loom-ext-bad-"));
    try {
      const pkgDir = path.join(root, "node_modules", "no-register");
      await fs.mkdir(pkgDir, { recursive: true });
      await fs.writeFile(
        path.join(pkgDir, "package.json"),
        JSON.stringify({
          name: "no-register",
          version: "1.0.0",
          type: "module",
          loom: { provider: "./index.js" },
        }),
      );
      await fs.writeFile(
        path.join(pkgDir, "index.js"),
        `export const noop = true;`,
      );
      await expect(
        loadProviderByName("no-register", {
          agentManifestDir: root,
          agentName: "x",
          loomVersion: "0",
          providerName: "no-register",
        }),
      ).rejects.toThrow(LoomError);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("agent.toml v5 source resolution end-to-end", () => {
  it("a tool with a path source loads the package and resolves through its Tools instance", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "loom-ext-e2e-"));
    try {
      const agentDir = path.join(root, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await buildExtensionFixture({
        rootDir: agentDir,
        packageName: "ext-pkg-e2e",
      });

      // v5: the tool entry's `provider` field is an inline SourceSpec
      // pointing at the provider package on disk. Loom loads it, runs
      // `register()`, and routes 'fixture.echo' through the Tools
      // instance that package added via `registerTools()`. The
      // `greeting` field is per-tool config (the test fixture reads
      // it inside `resolveTool`).
      await fs.writeFile(
        path.join(agentDir, "agent.toml"),
        `[agent]
name = "ext-driven"
system_prompt = "be brief"

[harness]
provider = "test"

[tools."fixture.echo"]
provider = { path = "./node_modules/ext-pkg-e2e" }
greeting = "yo"
`,
      );

      // Parse the manifest and mutate the harness to inject the test
      // script. Easier than expressing the script as TOML, and the
      // manifest is what runAgent ultimately consumes either way.
      const manifest = await parseAgentManifest(
        path.join(agentDir, "agent.toml"),
      );
      if ("provider" in manifest.harness) {
        manifest.harness.script = [
          [
            { call: { tool: "fixture.echo", input: { text: "world" } } },
            { stop: "end_turn" },
          ],
        ];
      }
      const agent = await runAgent(manifest, {});
      try {
        await agent.prompt("go");
        const events = (await agent.session.pull?.([])) ?? [];
        const tu = events.find((e) => e.sessionUpdate === "tool_call_update");
        expect(tu).toBeTruthy();
        if (tu && tu.sessionUpdate === "tool_call_update") {
          expect(tu.status).toBe("completed");
          const text =
            tu.content?.[0]?.type === "content" &&
            tu.content[0].content.type === "text"
              ? tu.content[0].content.text
              : "";
          expect(text).toBe("yo: world");
        }
      } finally {
        await agent.close();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
