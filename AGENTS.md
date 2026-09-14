# AGENTS.md

DeepSeek Harness is a plugin-based agent harness on vendored Cordis: **everything is a plugin**. Read [docs/architecture.md](docs/architecture.md) before changing `packages/`; follow [docs/AGENTS.md](docs/AGENTS.md) for documentation.

## Pre-release stance: foundation over blast radius

**Remove this section at the first tagged release.** With no external consumers, prefer the correct foundation over compatibility shims: rename or repackage freely and update every reference together. Backends reject old on-disk formats. SQLite uses monotonic `SCHEMA_VERSION`; `dsh-session` keeps `SESSION_FORMAT_VERSION` at `0` with no compatibility promise.

## Repository layout

```
vendor/      Vendored Cordis source — manifest + sync procedure in vendor/README.md
packages/    @deepseek-ai/dsh-<pkg> workspaces at packages/<group>/<pkg>/
  core/        product API spine: session, system-prompt, tools, agent, agent-loop
  api/         Remote BFF assembly and Typert RPC gateway
  typert/      type graph generator, loader, and runtime registry
  llm/         LLM capability: Service Definition/Consumer + DeepSeek providers
  e2b/         E2B POC: sandbox + FS/subprocess adapters
  shell/        bash capability: Service Definition + local/pwsh providers + shell Consumers
  subprocess/  subprocess capability + local process-tree provider
  terminal/         persistent sessions
  fs/          filesystem capability + policy
  lsp/         language-server capability
  skill/       skill provider registry + local impl + catalog/loader tool
  web/         web capability: Service Definition + search/fetch providers + tool Consumer
  compaction/     compaction capability + basic provider
  context/     request-context plugins
  subagent/    subagent capability: Service Definition + providers + delegation Consumers
  bundle/      installable dsh --profile patch-layer bundles
  workflow/    workflow capability + worker-thread provider + tool Consumer
  todo/        todo_write tool
  plan/        plan mode as logged state
  preset/      per-session agent composition from preset cordis.yml files
  guard/       loop-hygiene + tool-timeout plugins
  self-modification/  the agent inspects/mounts its own plugins
  hooks/       Claude Code/Codex hook bridges + wire-protocol library
  session/     durable session data: persistence, projection, titles, telemetry
  identity/    anonymous identity
  settings/    user-settings capability + file provider
  credentials/ credential/authorization capabilities + env/.env provider
  acp/         automation-only Agent Client Protocol server
  interaction/ approval/interaction capabilities, permission, commands, ask-user
  boot/        shared app-bin glue
  sdk/         JSON-RPC protocol, server, and TypeScript client
  examples/    demo bundles (agent-spine + CLI/ACP/JSON-RPC bins)
  experimental/ private prototypes excluded from official releases
  support/     dev/test infrastructure
  util/        zero-dependency utilities
python/      Python SDK and bundled runtime (see python/README.md)
native/      @deepseek-ai/node-addon-landlock-run source of record (see native/README.md)
examples/    Runnable cordis.yml leaves over packages/examples bundles (see examples/AGENTS.md)
.agents/     Agent workflows and Agent Notes (`notes/`)
docs/        architecture, generated catalogs, postmortems, cookbook (see docs/AGENTS.md)
scripts/     repo gates and generators
website/     VitePress projection of selected bilingual docs/ sources
```

Package groups: [packages/README.md](packages/README.md).

## Commands

```sh
pnpm install            # pnpm workspaces, node ^22.19 || >=24
pnpm run clean           # remove build outputs and safe residue from deleted packages
pnpm run test           # vitest unit tests
pnpm run test:coverage  # CI coverage gate: per-file 100% on packages/*/*/src
pnpm run test:e2e       # real-API tests; self-skip without DEEPSEEK_API_KEY
pnpm run test:snapshot  # keyless ACP/headless replay vs expected outputs; filter: -t <name>
pnpm run test:snapshot:record  # re-record expected outputs (needs key)
pnpm run typecheck
pnpm run lint
pnpm run duplication    # cross-file TypeScript clone detection
pnpm run build          # tsc emits lib/types, tsdown bundles runtime
pnpm run hygiene        # knip + publint + workspace constraints + NodeNext consumer check
pnpm run check:windows-wine  # ONLY when diagnosing a known Windows failure (needs wine); CI owns this signal
pnpm run doc-sync       # all documentation gates; leaf list in scripts/run-gates.ts
pnpm run website:build  # VitePress build (doubles as dead-link check)
pnpm dsh --profile headless "task"  # run one task from source (needs DEEPSEEK_API_KEY)
pnpm run demo:cordis    # the agent modifies its own runtime (needs key)
pnpm run demo:acp       # ACP automation server (needs DEEPSEEK_API_KEY)
```

### Host sandbox failures

When required `gh`, `pnpm`, build, test, or generator commands fail because the agent sandbox blocks credentials, network, IPC, file watching, or nested `sandbox-exec`, retry unchanged with the narrowest host escalation before diagnosing authentication or project failure. Require sandbox evidence; never bypass genuine test failures or the product sandbox under test.

### Run relevant checks locally

Run checks before pushes via [dsh-pre-push-checks](.agents/skills/dsh-pre-push-checks/SKILL.md); report only commands run. After `gh stack sync`, validate immediately; do not merge before checks pass.

- Match evidence to the surface: focused tests for behavior, snapshots for model or user output, `doc-sync` for docs, build/hygiene and built smokes for published paths, and real-API e2e for provider behavior.
- Never default to the full suite or repeat a passing check for commit or push. CI owns exhaustive coverage and the platform matrix; rehearse all locally only by explicit request, for CI diagnosis, or for an irreducibly repository-wide change.
- `test:coverage`, not `test`, is the CI coverage gate ([why](docs/testing.md)).

## Secrets / .env

Real-API tests and demos read `DEEPSEEK_API_KEY`, optional `DEEPSEEK_BASE_URL`, and root `.env`. cordis.yml allows `!!js` (never `!js`) under plugin `config` and entry `disabled`; other metadata stays literal, so conditional composition also uses overlays ([primer](docs/cordis-primer.md#loader-configuration)). Never commit credentials. CI e2e skips without a key; [testing.md](docs/testing.md) owns key policy.

## Conventions

- Every npm package is `@deepseek-ai/dsh-<name>`; vendored packages are rescoped ([mapping](docs/rescope.md)) and `private: true`. `@deepseek-ai/cordis` is a peerDependency (+ dev) of every harness package.
- ESM everywhere (`"type": "module"`). Use package names across packages and `.ts` in local relative imports. Config subprocesses run built `lib/` under plain Node; source regressions use their declared launcher ([testing policy](docs/testing.md#test-subprocess-launch-modes)). The `dsh` CLI source launch runs through tsx's ESM-only hook (`node --import tsx/esm`); modules it reaches must stay ESM (no CJS-only exports) — Node's native TypeScript modes are unavailable across the engines range ([source-launch contract](.agents/notes/implemented/architecture/2026-07-29-dsh-source-launch-tsx-esm.md)). Raw/Web `cordis.yml` bare plugins must appear in their resolver manifest's `dependencies`; `verify-cordis-config` enforces it.
- **Registrations are effects**: every contribution goes through `ctx.effect()` / `ctx.on()`; a registry's `register()` returns the disposer.
- **Runtime invariants assert owned relationships.** Check authoritative event streams or mutable data, not service or method presence, plugin metadata or effects, or fixed pure examples. Without a plausible relationship, an explained empty companion is correct ([package invariant rules](packages/AGENTS.md)).
- **Typed events use declaration merging** and merge-extensible maps. Event JSDoc needs `@mode` and payload `@param`; scoped keys absent from payloads need `@dshScopeScan unsupported`. Public service methods document parameters and non-void returns. A `SessionEventMap` member is required-on-read by default — builds that do not know its type refuse the log unless the event carries the envelope's `ignorable: true`; only structural format changes bump `SESSION_FORMAT_VERSION` ([mechanism](.agents/notes/implemented/architecture/2026-08-10-session-log-version-mechanism.md)).
- **Switch on discriminant tags.** Closed unions end in `assertNever`; merge-extensible unions fall through a documented default.
- **Waterfall listeners MUST call `next()`** to delegate; returning without it short-circuits the chain ([semantics](docs/cordis-primer.md#cordis-waterfall-semantics)).
- **Model-visible ⟺ logged**: anything that reaches a model request must be reconstructable from the session log; a new model-visible input requires a session event.
- **Plugins, not loop changes**: new behavior goes on documented extension points; changing `agent-loop` requires updating docs/architecture.md.
- **A capability seam comprises Service Definition / Service Provider / Consumer roles.** It is complete, never one role; split only when roles evolve independently ([glossary](docs/glossary.md#capability-seam)).
- **Prefer maintained dependencies over hand-rolling** when they genuinely delete owned code and tests ([policy](.agents/notes/implemented/process/2026-07-26-dependencies-over-hand-rolling.md)).
- **Explicit > implicit at package boundaries**: defaulting is an explicit `resolve(request): Spec` step in the owning implementation, never a hidden `?? default` inside `run()` (the `dsh-shell` request/spec split is the template).
- **No hardcoded tunables in plugins**: deployment-varying choices are validated `Config` fields changeable from cordis.yml; a `DEFAULT_*` constant or test hook is not configurability. Protocol constants, external specs, and security invariants stay fixed.
- **Misconfiguration fails loud** at load when self-contained, otherwise at the earliest resolvable point; never silently skip a missing referent.
- **Opaque cross-boundary ids are branded** (`Branded<B>` from `dsh-brand`), never bare `string`.
- **Trust TypeScript at typed same-process boundaries.** Do not add runtime validation, fallback behavior, or hostile-input tests solely for values the static interface requires; validate at parser/config, queued, model/tool JSON, durable/file, worker, process, and wire boundaries.
- **Source plane vs artifact plane, never mixed.** Static gates and tests resolve workspace imports through tsconfig `paths` to `src` and pass on a clean tree; gates consuming built `lib/` declare that dependency ([layout](docs/development.md#typescript-project-layout)).
- **Keep compiler faces explicit.** Each package uses one aggregate except `api/remotes`; repo-wide programs seed a face config, never the root solution ([layout](docs/development.md#typescript-project-layout)).
- **An empty `catch` names what it swallows** and why nothing else can reach it; keep the `try` to one statement.
- Do not comment on facts obvious from code.
- **Prefer symmetry for parallel values**; unexplained asymmetry usually signals a missed extraction.
- **Tests describe behavior, not correctness.** Change obsolete behavior with its tests; explain why in the PR.
- **Non-trivial changes MUST include an Agent Note in the same PR;** only mechanical/local edits are exempt ([scope](.agents/notes/README.md#when-to-write-one)). Archived notes are frozen: never edit or treat them as current authority ([archive policy](.agents/notes/README.md#archiving-and-deletion)).
- **Testing policy** — [docs/testing.md](docs/testing.md). Every non-trivial model- or product-user-visible behavior change adds or updates a keyless snapshot through a real runnable example in the same PR; package tests, e2e-only assertions, and mock-only fixtures do not substitute for the assembled application transcript. Fixtures must replay on macOS/Linux; fix fixtures, not normalizers.
- **A tool's UI render intent is part of its design**, decided up front (`generic`/`terminal`/`diff`, `locations`); presentation methods are pure functions of `args` ([cookbook](docs/cookbook/adding-a-tool.md)).
- **Plan unit, e2e, and snapshot coverage** for capability seams, lifecycle paths, and transcript output; include missing snapshot-harness support in the same change.
- **Both SDKs project the loop.** Agent-loop, session-lifecycle, and `SessionEventMap` changes update the TypeScript and Python SDK expected outputs in the same PR; `pnpm run test` covers neither ([surfaces](docs/testing.md#when-a-snapshot-test-is-required)).
- **Choose PR history deliberately.** Split independent changes; fix the introducing PR before propagation. Standalone PRs and official stacks may merge-forward or rebase after review. Rewrites use `--force-with-lease`, abort on remote movement, never raw `--force`; an in-progress merge-forward preserves its checkpoint before taking a newer base ([rationale](.agents/notes/implemented/process/2026-08-02-native-github-stacks-and-optional-rebases.md)).
- **Labels:** one PR `kind/*`, all material `area/*`, and native Issue Type ([taxonomy](.agents/notes/implemented/process/2026-08-08-unified-github-label-taxonomy.md)).
- TODO markers: `FIXME`/`TODO`/`XXX` by urgency ([semantics](docs/development.md)).
- Files end with exactly one trailing newline; `git diff --cached --check` (pre-commit) gates it.

## Defensive patterns

Read [docs/defensive-patterns.md](docs/defensive-patterns.md) before lifecycle, concurrency, subprocess, or teardown work.

## Type safety and documentation

Everything compiles under `strict: true` with `noImplicitAny`; every remaining `any` explains why narrowing is infeasible. Every module and export has concise JSDoc for its non-obvious contract; function-like exports include `@param`/`@returns`, as enforced by `verify-export-jsdoc`. Heritage-declared members, plugin-protocol slots, and constructors keep their docs at the declaring Service Definition, protocol, or class.

Comments and docs state complete contracts and context, not reasoning transcripts. Use direct, concrete terms. Do not use metaphors. Before writing `contract`, `boundary`, or `shape`, ask whether a more exact term names the subject: write `response fields`, `JSON validation`, or `ESM exports` instead of `response shape`, `validation boundary`, or `module shape`. Keep `contract` for preconditions, postconditions, invariants, compatibility promises, and other obligations that callers, callees, implementers, providers, producers, or consumers rely on. Keep a literal process, wire, security, transaction, or lifecycle boundary. Do not narrate control flow or tests, preserve review history, or restate code. Keep behavior, failure, timing, ownership, and safe-use facts; link the rationale. Use [dsh-prose-standard](.agents/skills/dsh-prose-standard/SKILL.md) for decisions. Wire mechanically checkable invariants into an executed top-level gate and prove each changed acceptance path rejects an invalid case. Use narrow, justified exceptions instead of disabling a rule globally.

Docs accompany every code change: update affected README and JSDoc contracts together. Routine bilingual work follows [docs/AGENTS.md](docs/AGENTS.md); only explicit user invocation may run `dsh-translate-docs`. Current-state prose, one physical line per paragraph, one home per fact, and word budgets live there.

## Editing these instructions

`CLAUDE.md` symlinks `AGENTS.md` at root, `packages/`, and `examples/`; edit the real file. Keep each rule self-contained while linking high-level docs. Condense when clarity survives; raise a `verify-doc-budgets` ceiling when the required content genuinely needs more space.

## Vendoring policy

`vendor/` packages are pinned source copies (manifest with upstream SHAs in [vendor/README.md](vendor/README.md)). Update via the sync procedure there; re-apply or retire the logged local modifications; rerun `pnpm run test && pnpm run build`.

## 插件准入三件套纪律 / Plugin admission discipline (three-piece gate)

Authoritative user rule (2026-08-31, cross-session and cross-agent, applies to every plugin before it enters the shared profile's `dsh.profile.bundles` at `C:\Users\Administrator\.dsh\profiles\web`). Violations that broke global-mode startup five times across three days:

1. `@dsh-external/dsh-brand-manager`, `@dsh-external/dsh-job-progress`: package.json missing `dsh.bundle` declaration → startup failure.
2. `@dsh-external/dsh-expert-market`, `@dsh-external/dsh-turn-nav`: missing `dsh.bundle.patch` declaration and `cordis.patch.yml` → startup failure.
3. `dsh-memory-evolve` vs `@max-null/dsh-memory`: duplicate `memory` tool name → startup failure.
4. `@omdsh-dev/dsh-genui` vs `@changfenhuang/dsh-genui`: duplicate loader entry id → startup failure (recurred twice).
5. `dsh-custom-brand` retired without cleaning node_modules link and ledger → client-side "ghost load".

### Three-piece gate (原文语义不得删改)

Any plugin entering the shared profile's `dsh.profile.bundles` must pass, item by item:

1. `package.json` declares `dsh.bundle.patch`, pointing at a real `cordis.patch.yml` inside the plugin directory, and that file contains an entry that inserts this plugin as a loader entry;
2. that `cordis.patch.yml` is fully parseable by the loader dialect (no round-trip rewriting when it contains `!!js` expressions);
3. trial install passes: `dsh plugin --profile web add <plugin-dir>` succeeds (use the CLI's actual subcommand), and the subsequent `dsh web` startup reaches the `dsh web: http://127.0.0.1:3080` line with no "plugin tree failed / duplicate / already registered / declares no" in the log.

### Companion discipline

- **Retirement four-clear**: when a plugin is removed from bundles, also clean its dependency declaration, node_modules link, its persistent lock file (e.g. `task-board/ledger-v2.lock`), and the market/injector ledger, to prevent ghost loads.
- **Uniqueness**: loader id, tool names, and slot+priority combinations must not conflict with plugins already in bundles (three lessons: genui duplicate, memory name clash, brand slot conflict).
- **Experiment isolation**: plugins under development are validated in a separate profile (e.g. `dsh --profile dev web`), never written directly into the shared web profile's bundles.
- **Single mount source**: a plugin mounted through the super-injector registry must not also enter bundles (double mount).

Automation: run `node scripts/check-plugin-ready.mjs` before `dsh plugin add` and require an all-PASS result; any FAIL blocks the add. Retiring a plugin follows the four-clear discipline.

## Browser probe rules (three iron rules)

Authoritative user rule (2026-09-02, cross-session and cross-agent; from the tn-probe leak incident: 16 probe versions leaked 11 Edge process trees / 103 processes / ~2.5GB RAM — root cause was `chrome.kill()` killing only the main process, bare `process.exit()` skipping cleanup on the error path, and a freshly random `user-data-dir` per run). Any headless browser probe (Edge/Chrome CDP script) written in this workspace MUST follow:

1. **Tear down the whole tree in `finally`**: run `taskkill /PID <chrome.pid> /T /F`; never rely on `chrome.kill()` alone (main process only) or bare `process.exit()` (orphans children).
2. **Share one fixed `user-data-dir`** for the same probe family (e.g. `%TEMP%\dsh-probe-edge`); never mint a fresh profile directory per run (accumulates residue).
3. **Clean up residuals at startup**: remove the previous run's same-name leftover instances/directories (old processes on the same `user-data-dir`, old profile data) before launching.

## DSH 本地源码启动与运维纪律 / DSH source runtime operations

Authoritative user rule (2026-09-12, 跨会话/跨项目/跨智能体). 源码 check out `D:\deepseek-harness`；运维工具箱 `D:\dsh-sync`；Harness home `C:\Users\Administrator\.dsh`。每条命令注明它动什么、为什么必须、跳过会怎样。

### 首次准备（一次性）

```powershell
cd D:\deepseek-harness      # 必须在仓库根：pnpm 靠 pnpm-workspace.yaml 识别 packages/*、apps/* 同属一个工作区；子目录执行会退化成普通安装、workspace:^ 关联断开
pnpm install                # 按 lockfile 铺依赖（实体在 node_modules/.pnpm）；lockfile 随 git 版本切换而变，错配导致构建/启动报莫名模块错，跳过＝在旧依赖上跑新源码
pnpm run build              # build:lib（tsc 类型 + tsdown 219 包）+ build:web（vite 前端）；宿主走 tsx 直读 src，但浏览器加载的是产物，跳过＝dsh web 起不来
cd D:\dsh-sync; .\doctor-sync.ps1   # 只读体检 8 项约 3 秒（版本一致/tag 可得/依赖新鲜/bundle 补丁在位/profile link 可达/端口占用者身份/产物新鲜/已知配置源的 stdio MCP 命令可解析），任一 FAIL 退出码 2
```

### 日常启动（源码接管 3080）

```powershell
Get-NetTCPConnection -LocalPort 3080 -State Listen | % { Stop-Process -Id $_.OwningProcess }   # GUI 里 Ctrl+C 更干净
pnpm dsh --profile web --port 3080 --no-open
D:\dsh-sync\start-source-instance.ps1 -SourceRoot D:\deepseek-harness -SharedHome -Port 3080 -Profile web -SkipDevWatch
```

- 先停 3080 占用者：Harness home 是**单写者设计**（sessions 日志 / memory / SQLite 索引假定只有一个宿主在写）；换端口硬跑＝两进程写同一 home，有损坏风险。`-SharedHome` 会检查 3080 当时无宿主，正是为此。
- 端口必须显式：仓库里没有 3080 常量，它是发行版配置层的默认值，不写就是赌。
- `pnpm dsh --profile web` 展开为 `node --import tsx/esm apps/cli/src/bin.ts web --port 3080`（tsx 让 Node 直接执行 `.ts`；`web` 等价 `--profile web`，从 `$DSH_HOME/profiles/web` 读 bundles 装配插件树）。
- **裸 `pnpm dsh web` 不会自动补前端补丁**——只有 `start-source-instance.ps1` 会在启动前跑 `patch-source-frontend.ps1`；HTML 不渲染的根因即此。
- 去掉 `-SkipDevWatch` 即后台常驻 `pnpm run dev:web --poll`（三阶段 watch：tsc → tsdown → vite；改 `packages/*/src` 自动重建、宿主广播 rebuilt 帧、浏览器自动刷新）。**它与 `pnpm run build` 不能同时跑**（都写 `lib/` 与 `apps/web/dist`）。

### 停止 / 回退

- 停 watcher：`.\start-source-instance.ps1 -Stop`（读 `logs\dev-web.pid`，只停 watcher；宿主要 Ctrl+C）。
- 回退全局编译产物：`dsh web`（走 `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\lib\bin.js`）；**前提先 `-Stop` 杀 watcher**，否则它仍在后台重建产物、与全局宿主抢同一批文件。

### 项目更新（两端一致，顺序不可颠倒）

```powershell
git fetch --tags origin                 # --tags 是关键：发布 tag dsh-v* 是后续对齐的锚点
npm i -g @deepseek-ai/dsh@<version>     # 全局是版本真相源——下一条命令读它的版本号反查 tag
D:\dsh-sync\sync-runtime-to-source.ps1  # 切 baseline/<V>；自动搬移 AGENTS.md 本地覆盖层并校验纯加法；无对应 tag / 工作树脏 / 非纯追加 → 拒绝
pnpm install && pnpm run build          # 顺序不可反：版本变了 lockfile 就变了；build 会抹掉前端补丁 → 补 .\patch-source-frontend.ps1
D:\dsh-sync\doctor-sync.ps1; D:\dsh-sync\promote-source-to-runtime.ps1   # 只读验证（promote 默认 dry-run，不改东西）
```

### 生效规则（源码启动不等于改哪都即时生效）

| 改哪里 | 怎么生效 | 机制原因 |
|---|---|---|
| `packages/*/src`（宿主侧） | 重启宿主 | tsx 只在启动时加载模块；HMR 只热重载 Cordis 插件，不热替换宿主自身 |
| `packages/client/*`（界面） | `dev:web` 重建 → 浏览器自动 reload；无 watcher 则 `pnpm run build` + Ctrl+F5 | 浏览器加载的是 bundle 产物，须重新产出 |
| `apps/web`（外壳） | `pnpm run build` + Ctrl+F5，重建后补 `patch-source-frontend.ps1` | 同上；且 build 会抹掉前端补丁 |
| `plugins/*` | 插件自身热载通道（inject / 重启宿主） | 与宿主源码无关 |

### 三层一致性判据

| 层级 | 比什么 | 手段 |
|---|---|---|
| L1 版本一致 | 全局 version == 源码根 `package.json` version，且 HEAD 命中该 tag | `doctor-sync.ps1` version parity |
| L2 产物一致 | 源码 `lib/` 与运行态 `lib/` 逐文件内容哈希 | `promote-source-to-runtime.ps1` dry-run（`would change 0` 即一致；做过 `-IncludeDist -Apply` 时 dist 报差异属预期——运行态前端是打过补丁的版本，源码 dist 是原始版，先看 lib 集是否为 0） |
| L3 补丁在位 | 服役中的前端 bundle 含 `__vcpStable` / `vcp-root` / `dsh.rawHtml` | `doctor-sync.ps1` frontend patches |

逐字节最强路径：`patch-probe.ps1` 把源码 bundle 复制到隔离目录、对副本跑补丁链、核对运行态没被动过 → GO/NO-GO；GO 后 `promote-source-to-runtime.ps1 -Apply -IncludeDist`（备份 → 覆盖 → 自动重放补丁链 → 校验标记），任一步失败用 `-Rollback <时间戳>` 精确还原。

### 硬约束（三条）

1. **单写者**：同 home 不可双实例并行（sessions/memory/索引单写语义）；要并行实验用隔离模式 `~\.dsh-src` + 3081。
2. **lockfile 随版本变**：切版本后必须先 `pnpm install` 再 `build`——用旧依赖编译新源码即错误地基。
3. **宿主不热替换**：源码启动后改宿主 src 必须重启宿主。
