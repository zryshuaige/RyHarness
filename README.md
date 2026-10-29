# RyHarness

English | [中文](README.zh.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%5E22.19%20%7C%7C%20%3E%3D24-339933.svg)](https://nodejs.org)
[![pnpm](https://img.shields.io/badge/pnpm-11-F69220.svg)](https://pnpm.io)
[![Electron](https://img.shields.io/badge/Electron-44-47848F.svg)](https://electronjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6.svg)](https://www.typescriptlang.org)
[![tests](https://img.shields.io/badge/tests-237%20files-brightgreen)](https://github.com/zryshuaige/RyHarness/actions)

RyHarness is a desktop app for AI agents that live on your own machine. You keep a
small team of them — each with its own personality, its own memory, its own tools —
and they work for you the way colleagues do: one of them picks up the job, hands it
over when the job turns out to be someone else's, and the result lands in your chat
as something you can open.

<img src="apps/desktop/docs/capture.png" width="900" alt="The RyHarness chat window" />

Everything stays local. Conversations, files, memories and API keys live on your
disk; the app talks to model providers over the loopback interface with a one-time
token.

## Developer preview

RyHarness is young and moving fast. **Expect breaking changes.** Back up your data
directory before you upgrade.

## Run it

Needs Node `^22.19` or `>=24` (persistence uses the built-in `node:sqlite`) and pnpm 11.

```sh
git clone https://github.com/zryshuaige/RyHarness.git
cd RyHarness
pnpm install
pnpm build
pnpm --filter @ryharness/desktop start
```

`pnpm --filter @ryharness/desktop dev` runs it with Vite hot reload instead.

Then give it a model provider: the first screen asks you to pick one — SiliconFlow,
DeepSeek, Moonshot, Zhipu, MiniMax, OpenRouter, OpenAI or Ollama — and then paste
that provider's API key (it is stored in the OS keychain). Any OpenAI-compatible
provider works: point `config/providers.json` in the data directory at yours. The
embedding model is a separate setting, so switching providers does not silently reuse
someone else's vectors.

## What it does

### Agents that have a personality

Four sliders (outgoing, rigorous, humorous, proactive) compile straight into the
system prompt, so moving one changes what the agent actually does. Each agent also
has a birthday, catchphrases, a 3D animal avatar, and a bond level that grows with
the conversations you actually have — a thumbs up or a thumbs down moves it.

### Group chats that hand work over

Mention an agent with `@` and the request goes straight to it. Leave the `@` out
and the dispatcher picks someone by reading the sentence. When one agent finishes
its part and the next one is a better fit, it says so and passes the job along.
The chain is visible in the sidebar.

### RyVibe: one sentence in, something you can use out

Say what you want. The first thing the team asks is what you actually want at the
end — an app you can open, a document, a table, or a process you'll follow again
each time. The rest are multiple-choice cards, not a form: the options are written
the way you'd answer them ("on my phone", "just me", "a link to send people"),
never in implementation terms ("how many screens", "web or desktop"). Then the
result lands on disk — a project folder, a document, a sheet, a flow — and the
tasks go into your todo list. Deliverables must pass validation before they are marked done. Every successful delivery keeps a real file snapshot, so you can preview, iterate, or roll back. Finished work also becomes shared memory.

<img src="apps/desktop/docs/capture-project.png" width="900" alt="RyVibe with a project on disk" />

### Memory that you can read

Extracted facts, a mix of keyword and vector search, decay over time, and a
playbook of what worked and what did not. Everything is visible and editable in the
sidebar. Thumbs up and thumbs down feed back into it.

### Everything is a plugin

Tools, routes, model adapters and skills are plugins. Turn one off and its tools
and endpoints really go away — not just the button. See [docs/plugins.md](docs/plugins.md).

## How it fits together

```text
apps/desktop      Electron shell: window, tray, capture, IPC, packaging
apps/server       Local backend: sessions, tools, providers, memory, vibe
packages/*        session, agent, llm, tools, memory, evolve, group, ...
vendor/*          cordis, schemastery, cosmokit
```

The plugin host is [Cordis](https://github.com/cordiverse/cordis), so a plugin is a
fiber you can mount and unmount at runtime.

## Development

```sh
pnpm build                                  # build every package
pnpm --filter @ryharness/desktop dev        # desktop app with hot reload
pnpm test                                   # 198 test files
pnpm lint                                   # biome, with a frozen warning budget
pnpm verify                                 # the five release gates
```

The release gates are not decoration: unknown casts, undeclared package
dependencies, duplicated code, the lint budget and the numbers in `NOTICE.md` are
all checked against the repository, and a mismatch fails the build.

## Documentation

- [docs/plugins.md](docs/plugins.md) — writing a plugin
- [docs/performance.md](docs/performance.md) — where the time goes
- [CHANGELOG.md](CHANGELOG.md) — what changed, and why

## License

[MIT](LICENSE)

Third-party licenses are listed in [NOTICE.md](NOTICE.md).
