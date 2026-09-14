# tali-wolfram-kernel-supervisor

Per-chat Wolfram Language (Mathematica 15+) kernels for the DSH web GUI, with
plots shown **inline to the user** at retina resolution.

The kernel is Mathematica's own MCP server (`Wolfram/AgentTools` paclet,
`StartMCPServer[]` over stdio). This plugin supervises those processes — one
per kernel, isolated per chat session — and exposes a small curated tool set.
Nothing else reaches the model (no `mcp__*` names, no dsh-mcp-client).

## Tools

| Tool | Purpose |
|---|---|
| `wolfram_eval {code, kernelId?, timeConstraint?}` | Evaluate code; definitions persist per kernel. Graphics come back as images (attached to the model when it accepts images, else saved to disk). |
| `wolfram_run {path, args?, kernelId?}` | `Get[]` a `.wl`/`.wls`/`.m` script inside the kernel; `$ScriptCommandLine = {path, ...args}`. Its definitions stay available to later calls. |
| `wolfram_show {expression, kernelId?, resolution?=144, see?=false, label?}` | `Rasterize` the expression @2x in the kernel and **show it to the user** (tool card + a pinned gallery under the turn's final answer). The model gets one line + the PNG path; `see:true` also hands it the image. |
| `wolfram_symbol {symbols}` / `wolfram_lint {code}` | `SymbolDefinition` / `CodeInspector` passthroughs. |
| `wolfram_kernel_open {label?}` | Start another kernel (becomes the default). |
| `wolfram_kernel_close {kernelId?, orphanPid?}` | Close a kernel (default: last-started); or SIGKILL a stray unsupervised kernel process whose parent is dead. |
| `wolfram_kernel_list {global?}` | This chat's kernels; `global:true` adds other chats' kernels and stray `StartMCPServer` processes on the machine. |

Kernel ids are `wl:<session>:<kernel>` (`s:M:N`-style, like browser-automation).
`kernelId` omitted/null = the chat's **last-started** live kernel, or a fresh one
(`Opened kernel wl:0:0 …` prefixes that result). Ids are validated against the
caller's session; subagents get their own session (`subagents: true`).

## How the image reaches the user (and not the model)

1. Host: `wolfram_show` evaluates `Rasterize[(expr), ImageResolution -> 144]`
   through `WolframLanguageEvaluator` (the stock tool already returns graphics
   as MCP `image` blocks), stores the PNG with `ctx.attachments.saveImages`
   (no model-capability gate), writes `~/Library/Wolfram/AgentToolsShow/<ts>-<md5:8>@2x.png`,
   returns one line via `output.render`, and puts the attachment reference +
   `points`/`scale` into `output.presentationMeta` (persisted card metadata the
   model never sees).
2. Client (`src/client/index.tsx`): keyed toolviews for `wolfram_show` /
   `wolfram_eval` / `wolfram_run` render the image at **point size**
   (`devicePixels / scale` CSS px, so @2x is crisp and matches Mathematica's
   on-screen size). Because the compact transcript folds tool rows into
   "N tool calls" once the turn ends, a turn-scoped accumulator
   (`ConversationNodeDefinition`, kind `wolframShown`) also collects the
   turn's shows and a `conversation.chat.turnTail` chain entry renders them
   as a pinned gallery under the final answer (never folded).
3. Bytes: the core's attachment read authorizes only references found in
   *content* image blocks, so meta-only references 404. The host registers
   `GET /api/wolfram/shown?sessionId=&attachmentId=` via
   `ctx.connection.fetch` (behind normal browser auth) and authorizes by
   scanning the session's events (live or cold) for a `tool/result` whose
   `meta.attachment.attachmentId` matches. `<img src>` uses it directly.

## Kernel lifecycle

- Spawn (lazy, on first use): `wolfram -nopaclet -noinit -noprompt -run 'PacletDirectoryLoad["<AgentTools dir>"]; Needs["Wolfram`AgentTools`"]; Wolfram`AgentTools`StartMCPServer[]'`, `MCP_SERVER_NAME=WolframLanguage`, cwd = chat workspace. Bootstrap eval `SetDirectory[cwd]; $ProcessID` captures the evaluator `session` id. ~2.3 s.
- **Shutdown ladder** (`servers.mjs`): write `Quit`, end stdin → wait 2 s → `SIGKILL` → `SIGKILL` child kernels. The kernel **ignores SIGTERM/SIGINT**; MCP-SDK-style SIGTERM closes are how 23 orphans accumulated on this machine before this plugin existed.
- Idle timer per session (`idleMinutes`, default 60) closes kernels and injects a notice; `agent/disposed` and plugin unload close everything. Caps: `maxKernelsPerSession` 4, `maxKernelsGlobal` 12.

## Config

See the header of `index.js`. Defaults need nothing: Wolfram.app, highest installed `Wolfram__AgentTools-*` paclet, 144 dpi, files under `~/Library/Wolfram/AgentToolsShow`.

## Develop

```sh
pnpm install                 # links DSH packages from ~/github/deepseek-harness
pnpm run check               # syntax + Config smoke
pnpm run typecheck && pnpm run build   # browser half → lib/client.js
pnpm run live:kernels        # real kernels: isolation, default rules, 2x Rasterize, ZERO leaked processes
```

Preview in an isolated DSH (see ../../PREVIEWING.md); the dev overlay
`../../cordis.dev.yml` has a row for this plugin. Recipe with the end-to-end
story and the gotchas: `~/projects/deepseek-harness/wolfram-kernel-supervisor.md`.
