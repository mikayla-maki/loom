/**
 * Example Loom provider — `loom-notes-provider`. Contributes a single
 * end-to-end story: **a notes-taking session for persistent recall**.
 *
 *   - A **Session contribution** (`NotesSession`) that loads notes
 *     from a markdown file on startup, renders them as a
 *     system-prompt section every turn, and contributes a
 *     `remember(fact)` verb. The session OWNS the tool: it advertises
 *     the name via `tools()` AND implements it via `resolveTool` —
 *     no separate `[tools.remember]` entry needed in the manifest.
 *
 * Why this exists pedagogically: a plain `[tools.remember]` couldn't
 * pull the file into the system prompt; a plain `[session]` couldn't
 * expose a verb to the model. The agent needs BOTH, and the v5
 * design lets a single session own both ends. Reading the file +
 * writing on every `remember` call lives in `NoteStore`; the Session
 * is the thin adapter between Loom's interface and the store.
 *
 * v5 convention: register the primary contribution of each kind
 * (Tools, harness, session) under the package's name. We only register
 * one contribution here — the Session. There is no separate Tools
 * registration; the session implements the `Tools.resolveTool`-shaped
 * `Session.resolveTool` method instead.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type {
  Agent,
  FactoryContext,
  Session,
  Tool,
  ToolConfig,
  ToolRef,
} from "../../src/types/interfaces.js";
import type { LoomProviderApi } from "../../src/providers/loader.js";
import type { SessionUpdate } from "../../src/types/acp.js";
import type { CapabilitySet } from "../../src/types/manifest.js";

const PROVIDER_NAME = "loom-notes-provider";

// ─── Note store ───────────────────────────────────────────────────────────

/**
 * One saved note. Persisted as a single markdown bullet:
 * `- (ISO timestamp) text`. Human-editable on purpose — the user can
 * prune, reorder, or hand-author entries.
 */
interface Note {
  at: string; // ISO timestamp
  text: string;
}

/**
 * Wraps the on-disk markdown file with an in-memory mirror. Loaded
 * once at session construction; appended on every `remember` call.
 */
class NoteStore {
  private notes: Note[] = [];

  constructor(
    public readonly filePath: string,
    private readonly maxNotes: number | undefined,
  ) {}

  async load(): Promise<void> {
    try {
      const text = await fs.readFile(this.filePath, "utf8");
      this.notes = parseNotesFile(text);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      // No file yet — start empty. The file is created on first add().
      this.notes = [];
    }
  }

  list(): readonly Note[] {
    return this.notes;
  }

  /** Append a new note; persist to disk; evict oldest if past the cap. */
  async add(text: string): Promise<Note> {
    const trimmed = text.trim().replace(/\s+/g, " ");
    if (!trimmed) {
      throw new Error("remember: fact must be non-empty after trimming");
    }
    const note: Note = {
      at: new Date().toISOString(),
      text: trimmed,
    };
    this.notes.push(note);

    // FIFO compaction. Drop oldest until we're at the cap. We rewrite
    // the whole file in that case; in the common case (no cap, or
    // under it) we append a single line.
    if (this.maxNotes !== undefined && this.notes.length > this.maxNotes) {
      this.notes = this.notes.slice(-this.maxNotes);
      await fs.writeFile(this.filePath, renderNotesFile(this.notes), "utf8");
    } else {
      await fs.appendFile(this.filePath, renderNoteLine(note), "utf8");
    }
    return note;
  }
}

function renderNoteLine(n: Note): string {
  return `- (${n.at}) ${n.text}\n`;
}

function renderNotesFile(ns: readonly Note[]): string {
  return ns.map(renderNoteLine).join("");
}

/**
 * Parse the markdown file. Lines that don't match the bullet pattern
 * are skipped silently — that way a user can add comments / headings
 * to the file by hand without breaking the loader.
 */
function parseNotesFile(text: string): Note[] {
  const out: Note[] = [];
  const lineRe = /^- \((\d{4}-\d{2}-\d{2}T[^)]+)\) (.+)$/;
  for (const line of text.split("\n")) {
    const m = lineRe.exec(line);
    if (m) out.push({ at: m[1]!, text: m[2]! });
  }
  return out;
}

// ─── Config + input readers ──────────────────────────────────────────────

interface DemoSessionConfig {
  file: string;
  max_notes: number | undefined;
}

/**
 * Pull `file` + `max_notes` out of the session config. The `file`
 * path resolves against the manifest directory (so `./notes.md` lives
 * next to `agent.toml`, not next to `process.cwd()`).
 */
function readSessionConfig(
  raw: unknown,
  ctx: FactoryContext,
): DemoSessionConfig {
  const c = (raw ?? {}) as Record<string, unknown>;
  const fileRaw =
    typeof c.file === "string" && c.file.length > 0
      ? c.file
      : "./loom-notes.md";
  const file = path.isAbsolute(fileRaw)
    ? fileRaw
    : path.resolve(ctx.manifestDir, fileRaw);
  const max =
    typeof c.max_notes === "number" && c.max_notes > 0
      ? c.max_notes
      : undefined;
  return { file, max_notes: max };
}

interface RememberInput {
  fact: string;
}

function readRememberInput(raw: unknown): RememberInput {
  const c = (raw ?? {}) as Record<string, unknown>;
  return {
    fact: typeof c.fact === "string" ? c.fact : "",
  };
}

// ─── The session ─────────────────────────────────────────────────────────

/**
 * The actual session class. Implements `tools()` (advertises the
 * `remember` verb) AND `resolveTool` (owns the implementation). The
 * runtime treats it as the implicit Tools provider for the names it
 * lists.
 */
class NotesSession implements Session {
  constructor(private readonly store: NoteStore) {}

  async push(event: SessionUpdate): Promise<SessionUpdate[]> {
    return [event];
  }

  async pull(below: SessionUpdate[]): Promise<SessionUpdate[]> {
    return below;
  }

  systemPromptSection(): string {
    const notes = this.store.list();
    if (notes.length === 0) {
      return (
        "Notes from previous sessions: (none yet — use the `remember` " +
        "tool to save facts you want to keep across runs)"
      );
    }
    const lines = notes.map((n) => `- ${n.text}`);
    return `Notes from previous sessions:\n${lines.join("\n")}`;
  }

  tools(): ToolRef[] {
    // We advertise `remember`. Implementation lives in `resolveTool`.
    return [{ name: "remember", config: {} }];
  }

  resolveTool(
    name: string,
    _config: ToolConfig,
    _agent: Agent,
    _capabilities: CapabilitySet | undefined,
  ): Tool | null {
    if (name !== "remember") return null;
    const store = this.store;
    return {
      name: "remember",
      description:
        "Save a fact you want to remember across this and future sessions. " +
        "The fact is persisted to disk as a note and replayed into the " +
        "system prompt every turn. Use this for user preferences, project " +
        "conventions, names, or anything else that should outlive the " +
        "current conversation.",
      inputSchema: {
        type: "object",
        required: ["fact"],
        additionalProperties: false,
        properties: {
          fact: {
            type: "string",
            description:
              "A short, declarative statement. Plain prose; no markdown.",
            minLength: 1,
          },
        },
      },
      async execute(input: unknown) {
        const { fact } = readRememberInput(input);
        if (!fact) {
          return { content: "Cannot remember an empty fact." };
        }
        try {
          const note = await store.add(fact);
          return { content: `Noted: "${note.text}"` };
        } catch (e) {
          return {
            content: `Failed to save note: ${(e as Error).message}`,
          };
        }
      },
    };
  }

  async close(): Promise<void> {
    /* nothing to release — the in-memory mirror dies with the process */
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────

/**
 * Called once by the host runtime when the manifest references this
 * provider's source. Registering happens here; instantiation is
 * deferred until the manifest asks for it.
 */
export function register(api: LoomProviderApi): void {
  api.registerSession({
    name: PROVIDER_NAME,
    async create(
      config: Record<string, unknown>,
      ctx: FactoryContext,
    ): Promise<Session> {
      const { file, max_notes } = readSessionConfig(config, ctx);
      const store = new NoteStore(file, max_notes);
      await store.load();
      return new NotesSession(store);
    },
  });
}
