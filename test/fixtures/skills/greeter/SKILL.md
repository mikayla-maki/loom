---
name: greeter
description: Greet the user by name and shout the greeting.
requires:
  greet: ../../tools/whoami
  uppercase: ../../tools/uppercase
---

# Greeter

Use `greet` with `{ greeting }` to produce a hello-style message — the tool
prepends "hello, " and lowercases the user's name (which it reads from the
agent's `sample_user_name` secret).

Then call `uppercase` with `{ text }` to convert that to an enthusiastic
shout.
