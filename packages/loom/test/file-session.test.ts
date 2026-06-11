import { describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { FileSession } from "../src/builtins/session/file.js";
import { runAgent } from "../src/sdk/run-agent.js";
import { StaticSecretsStore } from "../src/runtime/secrets.js";
import { testHarnessFactory } from "../src/builtins/harness/test.js";
import { useTmpDir } from "./helpers/tmp.js";

describe("FileSession", () => {
  const tmp = useTmpDir("loom-fs-");

  function newSession(): { p: string; s: FileSession } {
    const p = path.join(tmp(), "session.jsonl");
    return { p, s: new FileSession(p) };
  }

  async function readLines(p: string): Promise<string[]> {
    let txt = "";
    try {
      txt = await fs.readFile(p, "utf8");
    } catch {
      return [];
    }
    return txt.split("\n").filter(Boolean);
  }

  function textChunk(kind: "user" | "agent", text: string) {
    return {
      sessionUpdate: `${kind}_message_chunk` as const,
      content: { type: "text" as const, text },
    };
  }

  it("appends and reads back JSONL", async () => {
    const { p, s } = newSession();
    await s.push(textChunk("user", "a"));
    await s.push(textChunk("agent", "b"));
    await s.close();
    expect(await s.pull([])).toHaveLength(2);
    expect(await readLines(p)).toHaveLength(2);
  });

  it("coalesces consecutive same-kind chunks until a boundary flushes them", async () => {
    const { p, s } = newSession();
    for (const ch of ["He", "llo", " the", "re"]) {
      await s.push(textChunk("agent", ch));
    }

    const inFlight = await s.pull([]);
    expect(inFlight).toHaveLength(1);
    expect(inFlight[0]).toMatchObject({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hello there" },
    });

    await s.push({ sessionUpdate: "stop", stopReason: "end_turn" });
    await s.close();
    const lines = await readLines(p);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).content.text).toBe("Hello there");
    expect(JSON.parse(lines[1]!).sessionUpdate).toBe("stop");
  });

  it("flushes the pending buffer when chunk kind switches", async () => {
    const { p, s } = newSession();
    await s.push(textChunk("user", "hi"));
    await s.push(textChunk("user", " there"));
    await s.push(textChunk("agent", "hi back"));
    await s.close();
    const lines = await readLines(p);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).content.text).toBe("hi there");
    expect(JSON.parse(lines[1]!).content.text).toBe("hi back");
  });

  it("treats a tool_call between chunks as a boundary", async () => {
    const { p, s } = newSession();
    await s.push(textChunk("agent", "checking"));
    await s.push(textChunk("agent", " …"));
    await s.push({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "bash",
      status: "in_progress",
      rawInput: { command: "pwd" },
    });
    await s.push(textChunk("agent", "done"));
    await s.close();
    const lines = await readLines(p);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!).content.text).toBe("checking …");
    expect(JSON.parse(lines[1]!).sessionUpdate).toBe("tool_call");
    expect(JSON.parse(lines[2]!).content.text).toBe("done");
  });

  it("close() flushes a pending buffer that never saw a boundary", async () => {
    const { p, s } = newSession();
    await s.push(textChunk("agent", "only message"));
    expect(await readLines(p)).toHaveLength(0);

    await s.close();
    const lines = await readLines(p);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).content.text).toBe("only message");
  });

  it("persists across runs (e2e)", async () => {
    const fixturesRoot = path.resolve("test/fixtures");
    const agentDir = path.join(tmp(), "agent");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.cp(
      path.join(fixturesRoot, "sample-agent", "identity.md"),
      path.join(agentDir, "identity.md"),
    );
    await fs.writeFile(
      path.join(agentDir, "agent.toml"),
      `[agent]
name = "persist"
system_prompt = "./identity.md"

[harness]
provider = "test"

[session]
provider = "file"
path = "./session.jsonl"
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
    const events = (await a2.session.pull?.([])) ?? [];
    const userMsgs = events.filter(
      (e) => e.sessionUpdate === "user_message_chunk",
    );
    expect(userMsgs.length).toBeGreaterThanOrEqual(2);
    await a2.close();
  });
});
