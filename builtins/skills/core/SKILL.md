---
name: core
description: Core file & shell capabilities. Always-on by default; opt out via [agent].remove_builtin_tools = true.
requires:
  bash: builtin
  read_file: builtin
  write_file: builtin
  find: builtin
---

# Core file & shell tools

You have direct, unprompted access to the local filesystem and a shell:

- `find` — locate files by glob pattern (e.g. `**/*.ts`). Use this first
  when looking for something rather than scanning whole directories with
  `bash`.
- `read_file` — read a UTF-8 file. Prefer this over `bash cat` for clarity.
- `write_file` — create or overwrite a UTF-8 file. Set `create_dirs: true`
  to create missing parent directories. Set `append: true` to append.
- `bash` — execute a shell command. Use only when the file tools are
  insufficient (e.g. running a build, running tests, listing processes).

Guidelines:
- When the user asks about a file, use `read_file` to fetch it before
  answering. Don't guess at contents.
- Prefer minimal tool calls. Reach for `bash` last.
- Always paste relevant file contents back to the user when answering
  questions about them — they want to see what you saw.
