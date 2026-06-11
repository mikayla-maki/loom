import { describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import {
  listInstalledProviders,
  loadProviderByName,
  locateProviderPackage,
} from "../src/providers/loader.js";
import { runAgent } from "../src/sdk/run-agent.js";
import { parseAgentManifest } from "../src/manifest/parser.js";
import { LoomError } from "../src/errors.js";
import { useTmpDir } from "./helpers/tmp.js";
import { defined } from "./helpers/assert.js";

async function buildExtensionFixture(opts: {
  rootDir: string;
  packageName: string;
  scope?: string;
}): Promise<{ packageDir: string; nodeModulesDir: string }> {
  const nm = path.join(opts.rootDir, "node_modules");
  const packageDir = opts.scope
    ? path.join(nm, opts.scope, opts.packageName)
    : path.join(nm, opts.packageName);
  const fullName = opts.scope
    ? `${opts.scope}/${opts.packageName}`
    : opts.packageName;
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
        async close() {},
      };
    },
  });
}
`,
  );
  return { packageDir, nodeModulesDir: nm };
}

async function writeNonProviderPackage(
  rootDir: string,
  name: string,
): Promise<void> {
  const dir = path.join(rootDir, "node_modules", name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name, version: "1.0.0", main: "./index.js" }),
  );
  await fs.writeFile(path.join(dir, "index.js"), "export const x = 1;");
}

describe("provider package loader", () => {
  const tmp = useTmpDir("loom-ext-");

  it("locates plain, scoped, and rejects non-provider or missing packages", async () => {
    const root = tmp();
    await buildExtensionFixture({
      rootDir: root,
      packageName: "fixture-loom-ext",
    });
    await buildExtensionFixture({
      rootDir: root,
      packageName: "fixture",
      scope: "@my-org",
    });
    await writeNonProviderPackage(root, "boring-pkg");

    const info = await locateProviderPackage("fixture-loom-ext", {
      agentManifestDir: root,
    });
    expect(info.name).toBe("fixture-loom-ext");
    expect(info.entryPath).toMatch(/index\.js$/);
    expect(info.version).toBe("0.1.0");

    const scoped = await locateProviderPackage("@my-org/fixture", {
      agentManifestDir: root,
    });
    expect(scoped.name).toBe("@my-org/fixture");

    await expect(
      locateProviderPackage("does-not-exist-loom-ext", {
        agentManifestDir: root,
      }),
    ).rejects.toThrow(/Cannot find Loom provider/);
    await expect(
      locateProviderPackage("boring-pkg", { agentManifestDir: root }),
    ).rejects.toThrow(/Cannot find Loom provider/);
  });

  it("listInstalledProviders enumerates only packages with loom.provider metadata", async () => {
    const root = tmp();
    await buildExtensionFixture({ rootDir: root, packageName: "fixture-a" });
    await buildExtensionFixture({ rootDir: root, packageName: "fixture-b" });
    await writeNonProviderPackage(root, "boring");

    const items = await listInstalledProviders(
      { agentManifestDir: root },
      { searchPaths: [path.join(root, "node_modules")] },
    );
    const names = items.map((i) => i.name);
    expect(names).toContain("fixture-a");
    expect(names).toContain("fixture-b");
    expect(names).not.toContain("boring");
  });

  it("loadProviderByName runs register() and surfaces Tools contributions", async () => {
    const root = tmp();
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
    expect(toolsContributions.map((f) => f.name)).toContain(
      "register-side-effect-ext",
    );
  });

  it("rejects packages whose entry doesn't export register()", async () => {
    const root = tmp();
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
  });
});

describe("agent.toml v5 source resolution end-to-end", () => {
  const tmp = useTmpDir("loom-ext-e2e-");

  it("a tool with a path source loads the package and resolves through its Tools instance", async () => {
    const agentDir = path.join(tmp(), "agent");
    await fs.mkdir(agentDir, { recursive: true });
    await buildExtensionFixture({
      rootDir: agentDir,
      packageName: "ext-pkg-e2e",
    });

    await fs.writeFile(
      path.join(agentDir, "agent.toml"),
      `[agent]
name = "ext-driven"
system_prompt = "be brief"

[harness]
provider = "test"

[tools."fixture.echo"]
provider = { path = "./node_modules/ext-pkg-e2e" }
`,
    );

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
      const tu = defined(
        events.find((e) => e.sessionUpdate === "tool_call_update"),
      );
      expect(tu.status).toBe("completed");
      const text =
        tu.content?.[0]?.type === "content" &&
        tu.content[0].content.type === "text"
          ? tu.content[0].content.text
          : "";
      expect(text).toBe("hi: world");
    } finally {
      await agent.close();
    }
  });
});
