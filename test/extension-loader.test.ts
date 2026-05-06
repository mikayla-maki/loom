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
  // Entry: ESM module exporting register().
  await fs.writeFile(
    path.join(packageDir, "index.js"),
    `// Synthetic Loom extension fixture.
//
// Two side-effects on register():
//   1. Auto-activates a ProviderFactory that supplies 'fixture.echo'.
//      This is the common case — listing the extension in [extensions]
//      is enough.
//   2. ALSO registers a named ProviderFactory (so a separate test can
//      assert factories get registered).
export function register(api) {
  const greeting = api.config && typeof api.config.greeting === "string" ? api.config.greeting : "hi";
  const factory = {
    name: "fixture-provider",
    create(_config, _ctx, _secrets) {
      return {
        resolveTool(name) {
          if (name !== "fixture:echo") return null;
          return {
            kind: "synthetic",
            manifest: {
              manifestPath: "synthetic://fixture.echo",
              toolDir: "synthetic://fixture.echo",
              name: "fixture.echo",
              description: "Echo with greeting prefix",
              schema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
              invocation: { command: "(synthetic)", args: [] },
              secrets: { required: [] },
              capabilities: { filesystem: [], network: [] },
              shipsBinary: false,
            },
            tool: {
              name: "fixture.echo",
              description: "Echo with greeting prefix",
              inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
              async execute(input) {
                return { content: greeting + ": " + String((input || {}).text || "") };
              },
            },
          };
        },
        resolveSkill() { return null; },
        async list() { return { tools: ["fixture.echo"], skills: [] }; },
        async close() { /* noop */ },
      };
    },
  };
  api.addProvider(factory);
  api.registerProvider({
    name: "${fullName}",
    create(_config, _ctx, _secrets) { return factory.create(_config, _ctx, _secrets); },
  });
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

  it("loadExtensionPackage executes register() and registers factories", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "loom-ext-load-"));
    try {
      const { listProviders } = await import("../src/extensions/index.js");
      await buildExtensionFixture({
        rootDir: root,
        packageName: "register-side-effect-ext",
      });
      const before = new Set(listProviders());
      await loadExtensionPackage(
        "register-side-effect-ext",
        { greeting: "yo" },
        { agentManifestDir: root, agentName: "test", loomVersion: "0.1.0" },
      );
      const after = listProviders();
      // The fixture registers itself by its package name as the provider name.
      expect(after).toContain("register-side-effect-ext");
      void before;
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

      // Skill that pulls in the extension's synthetic tool by its provider key.
      const skillDir = path.join(agentDir, "skills", "echo-skill");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        `---
name: echo-skill
description: Echo via extension-supplied tool
requires:
  fixture.echo: fixture:echo
---
body
`,
      );
      await fs.writeFile(
        path.join(agentDir, "agent.toml"),
        `[agent]
name = "ext-driven"
system_prompt = "be brief"

[tools]

[harness]
provider = "test"

[sandbox]
filesystem = []
network = []
secrets = []

[extensions]
"ext-pkg-e2e" = { greeting = "yo" }

[skills]
e = "./skills/echo-skill"
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
