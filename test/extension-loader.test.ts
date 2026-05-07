import { describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

import {
  listInstalledExtensions,
  loadExtensionPackage,
  locateExtensionPackage,
} from "../src/extensions/loader.js";
import { runAgent } from "../src/sdk/run-agent.js";
import { parseAgentManifest } from "../src/manifest/parser.js";
import { LoomError } from "../src/errors.js";

/**
 * Build a directory tree that looks like a node_modules folder, containing
 * a single Loom extension package. The package's `loom.extension` field
 * points at an entry that registers a Provider supplying a synthetic tool.
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
        description: "Synthetic Loom extension for tests",
        type: "module",
        main: "./index.js",
        loom: { extension: "./index.js" },
      },
      null,
      2,
    ),
  );
  // Entry: ESM module exporting register(). Registers a ProviderFactory
  // via api.addProvider(); the factory's Provider.resolveTool() returns a
  // synthetic 'fixture.echo' tool by name.
  await fs.writeFile(
    path.join(packageDir, "index.js"),
    `export function register(api) {
  const greeting = api.config && typeof api.config.greeting === "string" ? api.config.greeting : "hi";
  const factory = {
    name: "${fullName}",
    create() {
      const tool = {
        name: "fixture.echo",
        description: "Echo with greeting prefix",
        inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
        async execute(input) {
          return { content: greeting + ": " + String((input || {}).text || "") };
        },
      };
      return {
        resolveTool(name, _config) {
          if (name === "fixture.echo") return tool;
          return null;
        },
        async close() { /* noop */ },
      };
    },
  };
  api.addProvider(factory);
}
`,
  );
  return { packageDir, nodeModulesDir: nm };
}

describe("extension package loader", () => {
  it("locates and imports a package with loom.extension metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "loom-ext-loc-"));
    try {
      await buildExtensionFixture({
        rootDir: root,
        packageName: "fixture-loom-ext",
      });
      const info = await locateExtensionPackage("fixture-loom-ext", {
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
        locateExtensionPackage("does-not-exist-loom-ext", {
          agentManifestDir: root,
        }),
      ).rejects.toThrow(/Cannot find Loom extension/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects packages without a loom.extension field (treats as 'not an extension')", async () => {
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
        locateExtensionPackage("boring-pkg", { agentManifestDir: root }),
      ).rejects.toThrow(/Cannot find Loom extension/);
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
      const info = await locateExtensionPackage("@my-org/fixture", {
        agentManifestDir: root,
      });
      expect(info.name).toBe("@my-org/fixture");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("listInstalledExtensions enumerates packages with loom.extension metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "loom-ext-list-"));
    try {
      await buildExtensionFixture({ rootDir: root, packageName: "fixture-a" });
      await buildExtensionFixture({ rootDir: root, packageName: "fixture-b" });
      // A non-extension package alongside.
      const boring = path.join(root, "node_modules", "boring");
      await fs.mkdir(boring, { recursive: true });
      await fs.writeFile(
        path.join(boring, "package.json"),
        JSON.stringify({ name: "boring", version: "1.0.0" }),
      );
      const items = await listInstalledExtensions(
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

  it("loadExtensionPackage executes register() and surfaces added provider factories", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "loom-ext-load-"));
    try {
      await buildExtensionFixture({
        rootDir: root,
        packageName: "register-side-effect-ext",
      });
      const { addedProviderFactories } = await loadExtensionPackage(
        "register-side-effect-ext",
        { greeting: "yo" },
        { agentManifestDir: root, agentName: "test", loomVersion: "0.1.0" },
      );
      // The fixture's register() calls api.addProvider() with a factory
      // whose name matches the package.
      const names = addedProviderFactories.map((f) => f.name);
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
          loom: { extension: "./index.js" },
        }),
      );
      await fs.writeFile(
        path.join(pkgDir, "index.js"),
        `export const noop = true;`,
      );
      await expect(
        loadExtensionPackage(
          "no-register",
          {},
          { agentManifestDir: root, agentName: "x", loomVersion: "0" },
        ),
      ).rejects.toThrow(LoomError);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("agent.toml [extensions] activation end-to-end", () => {
  it("extensions listed in [extensions] are loaded before tool/skill resolution", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "loom-ext-e2e-"));
    try {
      const agentDir = path.join(root, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await buildExtensionFixture({
        rootDir: agentDir,
        packageName: "ext-pkg-e2e",
      });

      // [tools] references the extension's tool by name; the extension
      // provider's resolveTool() claims it ahead of the native chain.
      await fs.writeFile(
        path.join(agentDir, "agent.toml"),
        `[agent]
name = "ext-driven"
system_prompt = "be brief"

[tools]
"fixture.echo" = {}

[harness]
provider = "test"

[extensions]
"ext-pkg-e2e" = { greeting = "yo" }
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
        const events = await agent.session.getEvents();
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
