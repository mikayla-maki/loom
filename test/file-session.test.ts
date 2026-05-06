import { describe, expect, it } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { FileSession } from "../src/extensions/session/file.js";
import { runAgent } from "../src/sdk/run-agent.js";
import { StaticSecretsStore } from "../src/runtime/secrets.js";
import { testHarnessFactory } from "../src/extensions/harness/test.js";

describe("FileSession", () => {
  it("appends and reads back JSONL", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-fs-"));
    try {
      const p = path.join(dir, "session.jsonl");
      const s = new FileSession(p);
      await s.append({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "a" } });
      await s.append({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "b" } });
      const events = await s.getEvents();
      expect(events).toHaveLength(2);
      const file = await fs.readFile(p, "utf8");
      expect(file.split("\n").filter(Boolean)).toHaveLength(2);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("persists across runs (e2e)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-fs-e2e-"));
    try {
      // Build a self-contained agent in tmp (so file session writes here).
      const fixturesRoot = path.resolve("test/fixtures");
      const agentDir = path.join(dir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.cp(path.join(fixturesRoot, "sample-agent", "identity.md"), path.join(agentDir, "identity.md"));
      await fs.writeFile(
        path.join(agentDir, "agent.toml"),
        `[agent]
name = "persist"
system_prompt = "./identity.md"
[tools]

[harness]
provider = "test"
[session]
provider = "file"
path = "./session.jsonl"
[sandbox]
filesystem = ["./"]
network = []
secrets = ["sample_user_name"]
[skills]
g = "${path.join(fixturesRoot, "skills/greeter").replace(/\\/g, "/")}"
`,
        "utf8",
      );
      const opts = {
        secrets: new StaticSecretsStore({ sample_user_name: "EVE" }),
        harnessOverride: {
          factory: testHarnessFactory,
          config: {
            script: [
              [{ say: "first" }, { stop: "end_turn" }],
              [{ say: "second" }, { stop: "end_turn" }],
            ],
          },
        },
      };
      const a1 = await runAgent(path.join(agentDir, "agent.toml"), opts);
      await a1.prompt("hi");
      await a1.close();

      const a2 = await runAgent(path.join(agentDir, "agent.toml"), opts);
      await a2.prompt("hi again");
      const events = await a2.session.getEvents();
      // After two prompts in two separate runs, the log contains 2 user msgs.
      const userMsgs = events.filter((e) => e.sessionUpdate === "user_message_chunk");
      expect(userMsgs.length).toBeGreaterThanOrEqual(2);
      await a2.close();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
