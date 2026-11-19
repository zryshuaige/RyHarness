# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

RyHarness is a Windows-first Electron desktop app: a local multi-agent workbench (chat UI, group
hand-off, RyVibe deliverables, readable memory). pnpm monorepo; everything stays on disk — SQLite +
JSON in the user data dir, model providers over HTTP, API keys in the OS keychain.

- Node `^22.19 || >=24` (persistence uses built-in `node:sqlite`), pnpm 11 (`corepack enable`).
- Develop and verify on Windows; CI runs `windows-latest`. If the Electron binary download stalls:
  `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`.
- Full chat loop needs a key: `SILICONFLOW_API_KEY` in user env or repo-root `.env` (gitignored).
  Never put keys in code, test fixtures, or screenshots.

## Commands

```sh
pnpm install
pnpm build                             # vendor=tsc, packages=tsdown→lib/, desktop=tsdown+vite
pnpm typecheck                         # builds vendor first, then tsc -p tsconfig.typecheck.json
pnpm lint                              # biome check . — hard gate
npx biome check --write <file>         # let the tool format; never hand-format
pnpm test                              # vitest run; root vitest.config.ts is the ONLY runner
npx vitest run apps/server/tests/plugins.test.ts            # one file
npx vitest run apps/server/tests/plugins.test.ts -t 'name'  # one test
npx vitest run --coverage              # full run + coverage ratchet (exactly what CI runs)
pnpm perf                              # vitest.perf.config.ts (*.perf.ts) — blocks merges
pnpm bench                             # trend numbers only, non-blocking
pnpm verify                            # the seven guardrails below
pnpm --filter @ryharness/desktop dev   # Vite HMR renderer + tsdown main + Electron
pnpm --filter @ryharness/desktop start
pnpm --filter @ryharness/server dev    # backend standalone (tsx src/main.ts)
pnpm --filter @ryharness/desktop package  # electron-builder: NSIS / portable / zip
```

- There are **no per-package test scripts**. Tests live in `apps/*/tests/`, `packages/*/tests/`,
  `packages/*/*/tests/`, `scripts/tests/` (guardrail self-tests). Component tests need the
  `// @vitest-environment jsdom` pragma.
- Tests resolve `@ryharness/*` to **TypeScript sources** (tsconfig paths), but the running app
  consumes `lib/` build output: after editing `packages/*/src` or `vendor/*/src`, run `pnpm build`
  before running or dev-ing the app.
- Coverage thresholds are only meaningful on a **full** run; never attach them to `--changed` /
  `--shard` subsets.

## Guardrails (`pnpm verify` — seven hard gates, also run in CI)

Self-contained scripts in `scripts/verify-*.mjs`. All are ratchets: frozen baselines may only shrink.

1. `verify-no-unknown-casts` — `as unknown as` is banned; legacy hits whitelisted per file + count.
2. `verify-package-deps` — declared `@ryharness/*` deps must be imported, imports must be declared.
3. `verify-duplication` — exact token-window duplication (400-token threshold); test dirs are
   deliberately in scope (most real duplication lives there).
4. `verify-biome-budget` — warning budget frozen per rule + file (e.g. `noNonNullAssertion`).
   When debt shrinks, re-freeze with `pnpm verify:biome:freeze` or the budget silently loosens.
5. `verify-notice` — every count/version in `NOTICE.md` sits inside `<!-- notice:key -->…<!-- /notice -->`
   markers and must equal repository facts; also syncs the README test-count badge. Regenerate with
   `node scripts/verify-notice.mjs --write` and review the diff. New third-party assets require a
   NOTICE entry (source, license, attribution).
6. `verify-shots-fresh` — `apps/desktop/docs/capture-*.png` / `dark-capture-*.png` must not be older
   than renderer source: touched the UI → re-capture via `scripts/capture-window.ps1` (window-only,
   never full-screen).
7. `verify-no-dead-code` — packages/files unreachable from the three product entries
   (`apps/desktop/electron/main.ts`, `apps/desktop/renderer/src/main.tsx`, `apps/server/src/index.ts`)
   fail; exemptions live in `docs/dead-code-exemptions.json`.

CI adds `pnpm audit --audit-level=high` as a hard red line. Perf discipline: `*.perf.ts` assertions
must be same-machine **ratios** or machine-independent **counts**; pure trend numbers belong in
`scripts/bench.ts` (nightly CI archives them, non-blocking).

## Coverage ratchet and vitest pool — do not "fix" these

- Thresholds in `vitest.config.ts` are **negative per-file counts** = max uncovered
  lines/statements/functions/branches per file; the global numbers equal the worst single file
  (vitest glob thresholds add constraints, they never override the global). New untested files go
  red; paying down existing debt does not. Recalibrate with
  `npx vitest run --coverage --coverage.thresholds.update` and review the diff; when local and CI
  environments differ (Word COM / LibreOffice paths), calibrate against the CI runner's numbers.
- An incomplete-run guard reporter aborts the coverage verdict when a run did not finish (crashed
  worker, Ctrl-C, watcher subset rerun). A ratchet red after such a run means "run incomplete",
  not "these files lost tests".
- `maxWorkers: 2`, `fileParallelism: false`, `retry: 1`, 1 GB worker heap are deliberate: suites
  spawn real Edge (CDP), Word (COM), PowerShell and shells. Raising parallelism produces random
  `Worker exited unexpectedly` reds; the settings keep local and CI identical.

## Architecture

**Layout.** `apps/desktop` (Electron main in `electron/`, React 19 renderer in `renderer/src`),
`apps/server` (local HTTP + WS backend), `packages/*` capability packages (nested families such as
`packages/llm/{llm,openai}`, `packages/typert/*`, `packages/util/*`, `packages/attachment/*`),
`vendor/*` inlined upstreams: cordis (plugin host), schemastery (schemas), cosmokit.

**Runtime topology.** The Electron main process embeds the backend in-process
(`RyHarnessServer.create`); it also runs standalone via `apps/server/src/main.ts`. The backend
listens on `127.0.0.1:32100` behind a per-launch random Bearer token pushed to the renderer
(`Authorization` header; WS uses `?token=`). `RYHARNESS_API_TOKEN` env override exists only for
CI/capture automation. Data dir: `%APPDATA%\RyHarness\ryharness-data` (SQLite `ryharness.db`,
`config/providers.json|plugins.json|mcp-servers.json`, per-plugin JSON stores);
`electron/data-dir.ts` migrates the legacy RyAgent directory on upgrade.

**Composition root.** `apps/server/src/app.ts` wires cordis Context → LlmRuntime + OpenAI-compatible
adapter → SessionStore (SQLite) → ToolRegistry → seed agent → SessionCoordinator + EventHub →
HTTP/WS. Cross-domain turn scheduling (queue/cancel/history rewrite) lives in `turn-engine.ts`,
event translation in `turn-events.ts`, WS fan-out in `bus.ts` (EventHub). Routes are split by domain
under `routes/`.

**Plugins are real mount/unmount**, not config flags: cordis fibers. A `PluginEntry`
(`plugins/host.ts`: `id` / `inject` / `apply` plus capabilities/impact metadata) is appended to
`pluginEntries` in `app.ts`; everything registered in `apply` goes through `ctx.effect()` so
unmounting unregisters its tools, routes and voice providers. Switches persist in
`<dataDir>/config/plugins.json`, exposed via `/api/plugins`. Registries: `tools`
(`packages/tools`, `defineTool`, `executionMode: 'sequential'` for side effects), `routes`
(`plugins/routes.ts`, same Router as core routes), `voice`. Plugin state = atomic-write JSON under
the data dir (temp file + rename, promise-queue serialization); never add columns to SQLite business
tables. Full guide: `docs/plugins.md`.

**REST contracts have one source of truth.** schemastery schema constants in
`apps/server/src/contract/*.ts`; mutating routes register through `route()` / `withBody()`
(`src/route.ts`) so runtime validation and handler input types come from the same schema, and the
renderer/SDK `import type` those constants. GET routes use `Router.get` directly. Never hand-copy
interface shapes into the renderer or SDK.

**Agent stack.** `packages/agent` (loop, personality sliders compiled into the system prompt,
permission presets), `packages/group` (dispatcher + hand-off chain), `packages/session` (SQLite
store + coordinator), `packages/llm` + `llm/openai` (runtime + OpenAI-compatible adapters;
embedding model configured separately), `packages/memory` (keyword + vector recall, decay,
playbook), `packages/evolve` (bond level, thumbs feedback), RyVibe pipeline in `apps/server/src/vibe/`
plus the `grill-me` plugin. Permission presets are server-owned (`GET /api/permission-presets`) and
only narrow the built-in tool surface — there is **no kernel-level sandbox** (see
`docs/dsh-parity.md`); approvals go through `approvals.ts` (ApprovalBroker).

**Typed RPC.** `packages/api` + `packages/typert/*` expose host objects as a reflected type graph
over JSON-RPC 2.0 (`@Remote` decorators); `packages/sdk` is the out-of-process client. Decorator
syntax needs TS transpilation: vitest's `standardDecoratorPlugin` and `scripts/tsdown-decorators.mjs`.

**Renderer.** React + Vite, per-page plain CSS (`styles-*.css`); talks to the backend only via
HTTP/WS with the pushed token. Server-owned lists (permission presets, voice catalog, plugin
metadata) must not be duplicated client-side — copies drift from what the server actually allows.

## Conventions

- Comments explain **why** (trade-offs, boundaries, historical traps), not what the code does.
  Chinese prose uses full-width punctuation; identifiers are English; files kebab-case, components
  PascalCase.
- biome: width 120, single quotes, semicolons asNeeded, trailing commas all. `biome.json`
  `files.includes` exclusions may only hit build output/deps — `apps/desktop/renderer/src/lib/` is
  real source; `apps/desktop/tests/lint-coverage.test.tsx` guards that invariant.
- New features and bugfixes ship tests in the owning package's `tests/`; never change assertion
  semantics to make a test green.
- Network-facing tools need protocol whitelists + private-address blocking (see `web-read.ts`);
  tool failures return structured Chinese `ToolResult` with `isError: true`; credentials never
  reach the renderer or logs.
- Brand art has one master: `apps/desktop/assets/brand/mark.png`. All icon sizes are derived by
  `pnpm --filter @ryharness/desktop gen:icon` — edit the master and regenerate, never hand-edit a
  derived PNG.
- Do not commit local screenshots, `.env`, `release/`, or build output (`main/`, `dist/`, `lib/`).
  Process screenshots go in PRs/issues; product shots enter the repo only via the capture scripts.