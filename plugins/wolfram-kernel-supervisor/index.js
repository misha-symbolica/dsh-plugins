/**
 * tali-wolfram-kernel-supervisor — per-chat Wolfram Language kernels for DSH.
 *
 * Mathematica 15 ships an MCP server inside the Wolfram/AgentTools paclet
 * (`Wolfram`AgentTools`StartMCPServer[]`, stdio). This plugin owns those
 * processes: one kernel per `wolfram_kernel_open` (or on first use), isolated
 * per chat session and addressed as wl:<session>:<kernel> (kernels.mjs), and
 * registers exactly the tools in tools.mjs into each eligible agent's scope.
 * Nothing else reaches the model: no mcp__wolfram__* names, no dsh-mcp-client.
 *
 * wolfram_show is the successor of the Pi `wolfram_Show` + rho `show.ts`
 * pair: Rasterize at 144 dpi in the chat's kernel, store the PNG as a durable
 * DSH attachment, hand the reference to the GUI through the tool's
 * `presentationMeta` (the browser half, src/client, renders it inline at
 * point size) and give the model one line of text.
 *
 * IMAGE ROUTE. The GUI reads durable attachments only after the core proves
 * the session log references them in a *content* image block; a reference
 * that lives solely in presentationMeta (the user-only path) is invisible to
 * that check ("Image is not referenced by this session"). So this plugin
 * serves its own images: GET /api/wolfram/shown?sessionId=…&attachmentId=…
 * (registered through ctx.connection.fetch, behind the normal browser auth),
 * authorized by proving the session's log holds a wolfram_show result whose
 * meta.attachment carries that id — live or cold session, so it survives
 * server restarts.
 *
 * LIFECYCLE. Nothing is spawned until a tool needs it. A per-session idle
 * timer (`idleMinutes`, reset by every call) closes the session's kernels and
 * injects a notice; agent disposal and plugin unload close everything. The
 * kernel ignores SIGTERM, so closing is Quit/EOF → SIGKILL (servers.mjs).
 *
 * Config (all optional):
 *
 *   kernel: ''                 # wolfram binary; '' = first of /Applications/Wolfram.app, Mathematica.app, Wolfram Engine.app, /usr/local/bin
 *   pacletDirectory: ''        # Wolfram/AgentTools paclet dir; '' = highest ~/Library/Wolfram/Paclets/Repository/Wolfram__AgentTools-*
 *   server: WolframLanguage    # MCP_SERVER_NAME profile (WolframLanguage | Wolfram | WolframAlpha)
 *   resolution: 144            # wolfram_show default dpi (144 = @2x)
 *   writeFiles: true           # also write show/eval PNGs to showDirectory
 *   showDirectory: ~/Library/Wolfram/DeepseekHarness   # PNGs written by wolfram_show / unadmitted wolfram_eval images
 *   theme: auto                # auto | light | dark — kernels render graphics for this appearance; auto follows
 *                              # DSH's Settings ▸ Appearance (ui-theme), resolving "system" via macOS AppleInterfaceStyle
 *   subagents: true            # delegated child agents get the tools too (each its own session)
 *   idleMinutes: 60            # close a session's kernels after this long unused (0 = never)
 *   maxKernelsPerSession: 4
 *   maxKernelsGlobal: 12
 *   toolCallTimeoutMs: 180000  # per MCP call (kernel evals can be long)
 *   traceFile: ''              # append JSON lifecycle lines here ('' = off)
 */

import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import Schema from '@deepseek-ai/schemastery'
import { KernelSessions } from './kernels.mjs'
import { findAgentToolsDirectory, findKernel, kernelLaunch } from './servers.mjs'
import { createTools } from './tools.mjs'

export const name = 'wolfram-kernel-supervisor'

export const inject = ['agents', 'tools', 'connection']

export const Config = Schema.object({
  kernel: Schema.string().default(''),
  pacletDirectory: Schema.string().default(''),
  server: Schema.string().default('WolframLanguage'),
  resolution: Schema.number().min(36).max(576).default(144),
  writeFiles: Schema.boolean().default(true),
  showDirectory: Schema.string().default('~/Library/Wolfram/DeepseekHarness'),
  theme: Schema.union(['auto', 'light', 'dark']).default('auto'),
  subagents: Schema.boolean().default(true),
  idleMinutes: Schema.number().min(0).default(60),
  maxKernelsPerSession: Schema.number().min(1).default(4),
  maxKernelsGlobal: Schema.number().min(1).default(12),
  toolCallTimeoutMs: Schema.number().default(180_000),
  traceFile: Schema.string().default(''),
})

const PLUGIN_SOURCE = { kind: 'plugin', plugin: 'wolfram-kernel-supervisor' }
/** Exact Fetch route (below /api) that serves wolfram_show images to the GUI. Mirrored in src/client. */
export const SHOWN_IMAGE_PATH = '/api/wolfram/shown'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - host-plane plugin context.
 * @param {ReturnType<typeof Config>} config - validated plugin config.
 */
export function apply(ctx, config) {
  const trace = (record) => {
    if (config.traceFile === '') return
    try { appendFileSync(config.traceFile, `${JSON.stringify({ t: new Date().toISOString(), ...record })}\n`) } catch { /* best effort */ }
  }

  const kernel = findKernel(config.kernel)
  if (kernel === undefined) {
    ctx.logger.warn(`wolfram-kernel-supervisor: no Wolfram kernel binary found${config.kernel ? ` at "${config.kernel}"` : ' (Wolfram.app / Mathematica.app / Wolfram Engine.app)'}; plugin is inert`)
    return
  }
  const pacletDirectory = findAgentToolsDirectory(config.pacletDirectory)
  if (pacletDirectory === undefined) {
    ctx.logger.warn('wolfram-kernel-supervisor: no Wolfram__AgentTools paclet directory found; falling back to the paclet-manager launch (~2 s slower per kernel). Install/update Wolfram/AgentTools in Mathematica 15+.')
  }
  const launch = kernelLaunch({ kernel, pacletDirectory, server: config.server })

  /** Label for one chat: session title when logged, else the short id. */
  function chatLabel(agent) {
    let title
    try { title = ctx.get('sessionProjections')?.stateOf(agent.session, 'title') } catch { /* no projection for this session shape */ }
    const text = typeof title === 'string' && title.trim() !== '' ? title.trim() : `chat ${agent.id.slice(-8)}`
    return text.replace(/\s+/g, ' ').slice(0, 60)
  }

  /**
   * The appearance kernels should render for. `auto` reads DSH's persisted
   * theme preference (settings namespace `ui-theme`, field `preference`;
   * absent/`system` when the user never changed it) and resolves `system`
   * through macOS (`defaults read -g AppleInterfaceStyle` prints "Dark" only in
   * dark mode). Decided once per kernel, at bootstrap — a theme switch applies
   * to kernels started afterwards.
   * @returns {'light' | 'dark'}
   */
  function resolveTheme() {
    if (config.theme !== 'auto') return config.theme
    let preference
    try { preference = ctx.get('settings')?.get('ui-theme')?.preference } catch { /* namespace unregistered */ }
    if (preference === 'light' || preference === 'dark') return preference
    if (process.platform === 'darwin') {
      try {
        return execFileSync('defaults', ['read', '-g', 'AppleInterfaceStyle'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'Dark' ? 'dark' : 'light'
      } catch { return 'light' } // the key is absent in light mode
    }
    return 'light'
  }

  /** Wolfram code that pins the kernel's front-end appearance (Plot themes, Grid frames, Rasterize background follow it). */
  const themeBootstrap = (theme) => `UsingFrontEnd[CurrentValue[$FrontEndSession, LightDark] = ${theme === 'dark' ? '"Dark"' : '"Light"'}];`

  const sessions = new KernelSessions({
    spec: (session, kernelIndex) => {
      const theme = resolveTheme()
      session.theme = theme
      return {
        ...launch,
        clientName: `DSH ${chatLabel(session.agent)} · wl:${session.index}:${kernelIndex}`,
        cwd: session.agent.session.header?.cwd,
        bootstrap: themeBootstrap(theme),
      }
    },
    timeoutMs: config.toolCallTimeoutMs,
    idleMs: config.idleMinutes * 60_000,
    maxPerSession: config.maxKernelsPerSession,
    maxGlobal: config.maxKernelsGlobal,
    onIdleClose: (agent, closed) => {
      try {
        agent.inject({
          content: `[wolfram-kernel-supervisor] Closed idle Wolfram kernel(s) ${closed.join(', ')} after ${config.idleMinutes} min without use; their definitions are gone. Any wolfram_* call starts a fresh kernel.`,
          source: PLUGIN_SOURCE,
        })
      } catch { /* agent disposed or not accepting injections */ }
    },
    trace,
    logger: ctx.logger,
  })

  /** Model-gated admission (same rule as dsh-mcp-client): only when the current model declares image input. */
  async function admitImage(exec, bytes, name, mediaType = 'image/png') {
    const attachments = ctx.get('attachments')
    if (attachments === undefined) return { reason: 'no attachment store is mounted' }
    const routed = exec.agent?.session.requestHeader?.()?.config
    const provider = routed?.provider ?? exec.agent?.options?.provider
    const model = routed?.model ?? exec.agent?.options?.model
    const llm = ctx.get('llm')
    if (provider === undefined || model === undefined || llm === undefined) return { reason: 'the current model route could not be resolved' }
    let info
    try { info = await llm.resolveModelInfo(provider, model, exec.signal) } catch { return { reason: 'the current model route could not be verified' } }
    if (!info.inputModalities?.includes('image')) return { reason: `model "${model}" does not declare image input` }
    try {
      const [ref] = await attachments.saveImages([{ data: bytes, mediaType, name }])
      return { ref }
    } catch (error) {
      return { reason: `attachment store rejected the image: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /** Ungated admission for user-facing images (wolfram_show): the model never receives these. */
  async function storeImage(bytes, name) {
    const attachments = ctx.get('attachments')
    if (attachments === undefined) return { reason: 'no attachment store is mounted' }
    try {
      const [ref] = await attachments.saveImages([{ data: bytes, mediaType: 'image/png', name }])
      return { ref }
    } catch (error) {
      return { reason: `attachment store rejected the image: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  const deps = {
    sessions, admitImage, storeImage, labelOf: chatLabel, trace,
    config: { resolution: config.resolution, writeFiles: config.writeFiles, showDirectory: config.showDirectory },
    themeOf: (kernel) => kernel.theme ?? 'light',
  }


  // ---------------------------------------------------------------- shown-image route

  /** Whether the session's log holds a wolfram_show result whose meta references the attachment. */
  async function sessionShows(sessionId, attachmentId) {
    const live = ctx.get('sessions')?.get?.(sessionId)
    let events
    let observation
    if (live !== undefined) {
      events = live.snapshotEvents()
    } else {
      const query = ctx.get('sessionQuery')
      if (query === undefined) return undefined
      try {
        observation = await query.observeSession(sessionId, { projectionMode: 'none' })
        events = observation.events
      } catch {
        return undefined
      }
    }
    try {
      for (const event of events) {
        if (event.type !== 'tool/result') continue
        const meta = event.data?.meta
        const ref = meta?.attachment
        if (ref && typeof ref === 'object' && String(ref.attachmentId) === attachmentId) return ref
      }
      return undefined
    } finally {
      observation?.[Symbol.dispose]?.()
      await observation?.[Symbol.asyncDispose]?.()
    }
  }

  ctx.connection.fetch.register({
    path: SHOWN_IMAGE_PATH,
    methods: ['GET', 'HEAD'],
    fetch: async (request) => {
      const url = new URL(request.url)
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const attachmentId = url.searchParams.get('attachmentId') ?? ''
      if (sessionId === '' || attachmentId === '') return new Response('missing sessionId or attachmentId', { status: 400 })
      const attachments = ctx.get('attachments')
      if (attachments === undefined) return new Response('no attachment store', { status: 500 })
      const ref = await sessionShows(sessionId, attachmentId)
      if (ref === undefined) return new Response('image is not a wolfram_show result of this session', { status: 404 })
      let stored
      try { stored = await attachments.readImage(ref) } catch (error) { return new Response(`attachment read failed: ${error instanceof Error ? error.message : String(error)}`, { status: 404 }) }
      const headers = { 'content-type': stored.ref.mediaType, 'content-length': String(stored.data.byteLength), 'cache-control': 'private, max-age=31536000, immutable' }
      if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
      return new Response(stored.data, { status: 200, headers })
    },
  })

  /** Plugin-owned disposer of each attached agent's scoped tool registrations. */
  const attached = new Map()

  function attach(agent) {
    if (attached.has(agent)) return
    const depth = agent.session.header?.delegationDepth ?? 0
    if (depth > 0 && !config.subagents) return
    const dispose = ctx.effect(() => {
      const disposers = createTools(deps, agent).map(tool => agent.ctx.tools.register(tool))
      return () => { for (const dispose of disposers) dispose() }
    }, 'wolfram-kernel-supervisor.tools')
    attached.set(agent, dispose)
    trace({ event: 'attach', id: agent.id, depth })
  }

  for (const agent of ctx.agents.list()) attach(agent)
  ctx.on('agent/created', ({ agent }) => { attach(agent) })

  ctx.on('agent/disposed', ({ agent }) => {
    const dispose = attached.get(agent)
    if (dispose !== undefined) {
      attached.delete(agent)
      void dispose()
    }
    void sessions.forget(agent, 'agent-disposed').catch((error) => {
      ctx.logger.warn(`wolfram-kernel-supervisor: closing kernels of disposed agent "${agent.id}" failed: ${String(error)}`)
    })
  })

  // Plugin unload: every session's kernels.
  ctx.effect(() => async () => { await sessions.dispose() }, 'wolfram-kernel-supervisor.kernels')
}
