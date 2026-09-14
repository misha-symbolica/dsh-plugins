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
| `wolfram_show {expression, kernelId?, resolution?=144, see?=false, label?, background?=transparent}` | `Rasterize` the expression @2x in the kernel (transparent PNG; the kernel's front end is pinned to the GUI's light/dark appearance so text, axes and Plot themes match) and **show it to the user** (tool card + a pinned gallery under the turn's final answer, label = link that opens the file). The model gets one line + the PNG path; `see:true` also hands it the image. |
| `wolfram_symbol {symbols}` / `wolfram_lint {code}` | `SymbolDefinition` / `CodeInspector` passthroughs. |
| `wolfram_kernel_open {label?}` | Start another kernel (becomes the default). |
| `wolfram_kernel_close {kernelId?, orphanPid?}` | Close a kernel (default: last-started); or SIGKILL a stray unsupervised kernel process whose parent is dead. |
| `wolfram_kernel_list {global?}` | This chat's kernels; `global:true` adds other chats' kernels and stray `StartMCPServer` processes on the machine. |

Kernel ids are `wl:<session>:<kernel>` (`s:M:N`-style, like browser-automation).
`kernelId` omitted/null = the chat's **last-started** live kernel, or a fresh one
(`Opened kernel wl:0:0 …` prefixes that result). Ids are validated against the
caller's session; subagents get their own session (`subagents: true`).

## Slash commands (no model involved)

| Command | Does |
|---|---|
| `/wolfram-show <expression>` | exactly what the `wolfram_show` tool does — same kernel, same card, Manipulate becomes interactive — but from the composer, with no agent turn and nothing added to the model's context |
| `/wolfram <code>` | evaluate in the chat's default kernel; output shown as a card |
| `/wolfram-kernels` | list this chat's kernels |

Implementation: `ctx.commands.register` handlers receive `invocation.agent`, so they
resolve the same per-chat kernel; `/wolfram-show` returns the presentation payload
as JSON in the command result (`command/done` is log-only, never model-visible) and
the browser half renders it through the keyed `conversation.chat.commandview` slot
with the same body as the tool card. **Caveat:** the chat shows the hero, not the
transcript, until a session has had one turn — command cards in a brand-new session
appear only after the first message (core behaviour, applies to `/compact` too).

## Interactive `Manipulate`

`wolfram_show` of a top-level `Manipulate[body, controls…]` becomes a live widget.
`kernel/DSHPlugin.wl` (`DSHPlugin\`ShowRasterizer`, `HoldAllComplete`) parses the
*simple* control forms with Manipulate's own semantics — non-variable parts are
evaluated, so `{x, 0, Length[l]}` and `{n, Range[10]}` work:

| Spec | Control |
|---|---|
| `{x, min, max}` · `{x, min, max, step}` · `{{x, init}, …}` · `{{x, init, "label"}, …}` | slider (readout shows the value) |
| `{c, {a, b, c}}` (≤ 6 choices, or `ControlType -> Setter`) | setter bar (chips) |
| `{c, {…7+ choices…}}` or `ControlType -> PopupMenu` | popup |
| `{b, {True, False}}` | checkbox |
| Manipulate options (`SaveDefinitions -> True`, …) | ignored |

The held body and variables are registered under an id in the kernel; the
initial frame is rasterized; the descriptor rides `presentationMeta`. On release
the browser fetches `GET /api/wolfram/manipulate?sessionId&kernelId&id&values=[…]`;
the host validates every value against the descriptor (sliders clamped, choice
indices bounded, booleans) and evaluates `DSHPlugin\`Render[id, values]` — the
body with the variables substituted, re-rasterized (~55 ms + transfer). Widgets
live as long as the kernel: a 410 disables the controls with a note. The tool
row and the pinned gallery each hold their own control state.

## How the image reaches the user (and not the model)

1. Host: `wolfram_show` evaluates `Rasterize[(expr), Background -> None, ImageResolution -> 144]`
   through `WolframLanguageEvaluator` (the stock tool already returns graphics
   as MCP `image` blocks), stores the PNG with `ctx.attachments.saveImages`
   (no model-capability gate), writes `~/Library/Wolfram/DeepseekHarness/<ts>-<md5:8>@2x.png`,
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
3. Captions are links: click → `GET /api/wolfram/open?path=` (paths under `showDirectory` only) → `open` in the system viewer.
4. Bytes: the core's attachment read authorizes only references found in
   *content* image blocks, so meta-only references 404. The host registers
   `GET /api/wolfram/shown?sessionId=&attachmentId=` via
   `ctx.connection.fetch` (behind normal browser auth) and authorizes by
   scanning the session's events (live or cold) for a `tool/result` whose
   `meta.attachment.attachmentId` matches (or a `command/done` payload does). `<img src>` uses it directly.

## Kernel-side code

All Wolfram code the plugin evaluates on your behalf is in `kernel/DSHPlugin.wl`
(`Get`'d once per kernel at bootstrap): `ShowRasterizer`, `Render`, `RunScript`.
No `.wl` files elsewhere, no paclet; the stock `Wolfram/AgentTools` server is
used unmodified. Package symbols must not be spelled like `System\`` built-ins
(`Show` resolved to the built-in and silently did nothing).

## Kernel lifecycle

- Spawn (lazy, on first use): `wolfram -nopaclet -noinit -noprompt -run 'PacletDirectoryLoad["<AgentTools dir>"]; Needs["Wolfram`AgentTools`"]; Wolfram`AgentTools`StartMCPServer[]'`, `MCP_SERVER_NAME=WolframLanguage`, cwd = chat workspace. Bootstrap eval `SetDirectory[cwd]; UsingFrontEnd[CurrentValue[$FrontEndSession, LightDark] = "Dark"|"Light"]; $ProcessID` pins the appearance (config `theme: auto|light|dark`; `auto` = DSH `ui-theme` setting, `system` resolved via macOS `AppleInterfaceStyle`) and captures the evaluator `session` id. ~2 s.
- **Shutdown ladder** (`servers.mjs`): write `Quit`, end stdin → wait 2 s → `SIGKILL` → `SIGKILL` child kernels. The kernel **ignores SIGTERM/SIGINT**; MCP-SDK-style SIGTERM closes are how 23 orphans accumulated on this machine before this plugin existed.
- Idle timer per session (`idleMinutes`, default 60) closes kernels and injects a notice; `agent/disposed` and plugin unload close everything. Caps: `maxKernelsPerSession` 4, `maxKernelsGlobal` 12.

## Config

See the header of `index.js`. Defaults need nothing: Wolfram.app, highest installed `Wolfram__AgentTools-*` paclet, 144 dpi, `theme: auto`, files under `~/Library/Wolfram/DeepseekHarness`.

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
