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

  /** Build a `FileSession` rooted in this test's tmp dir. */
  function newSession(): { p: string; s: FileSession } {
    const p = path.join(tmp(), "session.jsonl");
    return { p, s: new FileSession(p) };
  }

  it("appends and reads back JSONL", async () => {
    const { p, s } = newSession();
    await s.push({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "a" },
    });
    await s.push({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "b" },
    });
    // close() flushes the trailing pending buffer (the agent_message_chunk
    // is sitting in the pending buffer until a boundary or close).
    await s.close();
    const events = await s.pull([]);
    expect(events).toHaveLength(2);
    const file = await fs.readFile(p, "utf8");
    expect(file.split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("coalesces consecutive same-kind chunks into one disk line", async () => {
    const { p, s } = newSession();
    // Many small agent_message_chunk fragments — like a streaming response.
    for (const ch of ["He", "llo", " the", "re"]) {
      await s.push({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: ch },
      });
    }
    // pull() should see them as one merged event (in-flight buffer).
    const inFlight = await s.pull([]);
    expect(inFlight).toHaveLength(1);
    expect(inFlight[0]).toMatchObject({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hello there" },
    });
    // Boundary event flushes pending to disk.
    await s.push({ sessionUpdate: "stop", stopReason: "end_turn" });
    await s.close();
    const lines = (await fs.readFile(p, "utf8")).split("\n").filter(Boolean);
    expect(lines).toHaveLength(2); // merged message + stop
    const merged = JSON.parse(lines[0]!);
    expect(merged.sessionUpdate).toBe("agent_message_chunk");
    expect(merged.content.text).toBe("Hello there");
  });

  it("different chunk kinds form separate boundaries", async () => {
    const { p, s } = newSession();
    await s.push({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "hi" },
    });
    await s.push({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: " there" },
    });
    // user → agent kind switch flushes the user buffer.
    await s.push({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hi back" },
    });
    await s.close();
    const lines = (await fs.readFile(p, "utf8")).split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).content.text).toBe("hi there");
    expect(JSON.parse(lines[1]!).content.text).toBe("hi back");
  });

  it("tool_call between chunks acts as a boundary", async () => {
    const { p, s } = newSession();
    await s.push({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "checking" },
    });
    await s.push({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: " …" },
    });
    await s.push({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "bash",
      status: "in_progress",
      rawInput: { command: "pwd" },
    });
    await s.push({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "done" },
    });
    await s.close();
    const lines = (await fs.readFile(p, "utf8")).split("\n").filter(Boolean);
    // 3 lines: merged "checking…", tool_call, "done"
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!).content.text).toBe("checking …");
    expect(JSON.parse(lines[1]!).sessionUpdate).toBe("tool_call");
    expect(JSON.parse(lines[2]!).content.text).toBe("done");
  });

  it("close() flushes a pending buffer that never saw a boundary", async () => {
    const { p, s } = newSession();
    await s.push({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "only message" },
    });
    // No boundary. File should be empty (or not exist) until close().
    let preCloseLines: string[] = [];
    try {
      const txt = await fs.readFile(p, "utf8");
      preCloseLines = txt.split("\n").filter(Boolean);
    } catch {
      // File hasn't been created yet — also valid.
    }
    expect(preCloseLines).toHaveLength(0);
    await s.close();
    const postCloseLines = (await fs.readFile(p, "utf8"))
      .split("\n")
      .filter(Boolean);
    expect(postCloseLines).toHaveLength(1);
    expect(JSON.parse(postCloseLines[0]!).content.text).toBe("only message");
  });

  it("persists across runs (e2e)", async () => {
    // Build a self-contained agent in tmp (so file session writes here).
    const fixturesRoot = path.resolve("test/fixtures");
    const agentDir = path.join(tmp(), "agent");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.cp(
      path.join(fixturesRoot, "sample-agent", "identity.md"),
      path.join(agentDir, "identity.md"),
    );
    // No skills, no [tools] entry → default builtin tool set.
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
    // After two prompts in two separate runs, the log contains 2 user msgs.
    const userMsgs = events.filter(
      (e) => e.sessionUpdate === "user_message_chunk",
    );
    expect(userMsgs.length).toBeGreaterThanOrEqual(2);
    await a2.close();
  });
});
