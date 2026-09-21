/**
 * The model-facing tool set. Plain DSH tools that forward to the caller's
 * kernels (kernels.mjs) over private MCP connections (servers.mjs). Only these
 * tools exist; the AgentTools server's raw tools are never registered.
 *
 *   lifecycle: wolfram_kernel_open / wolfram_kernel_close / wolfram_kernel_list
 *   work:      wolfram_eval / wolfram_run / wolfram_show / wolfram_symbol / wolfram_lint
 *
 * Every work tool and wolfram_kernel_close take an optional `kernelId`
 * (wl:<session>:<kernel>); omitted = the session's last-started kernel, or a
 * fresh one. wolfram_show is the Pi `wolfram_Show` successor: the image is
 * shown to the USER through `output.presentationMeta` (persisted card metadata
 * the model never sees) and the model gets one line — unless `see: true`.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { evaluate, wlString } from './kernels.mjs'
import { childPids, killHard, scanKernelProcesses } from './servers.mjs'

const KERNEL_ID = {
  oneOf: [{ type: 'string' }, { type: 'null' }],
  description: 'Kernel id (wl:<session>:<kernel>) from wolfram_kernel_open / wolfram_kernel_list. Omit or null for this chat\'s last-started kernel (one is started if none is running).',
}
const TIME_CONSTRAINT = { type: 'integer', description: 'Evaluation time limit in seconds (server default 60).' }

const objectOutput = (render) => ({
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: render(value) }],
})

const SCRIPT_EXTENSIONS = new Set(['.wl', '.wls', '.m'])

/** `[wl:0:1]` prefix, with an "Opened" note the first time so the model learns the id. */
const tagged = (value, text) => `${value.opened ? `Opened kernel ${value.kernelId} (${value.startupMs} ms; it is now this chat's default). ` : ''}[${value.kernelId}]\n${text}`

/** PNG intrinsic size from the IHDR chunk; undefined for non-PNG bytes. */
export function pngSize(bytes) {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

/** `2026-08-27-15-24-22` in local time (CleanShot-style, matches the Pi Show tool). */
function timestamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`
}

/** Timestamped retina-tagged filename: `<ts>-<md5:8>@2x.png`. */
export function showFileName(bytes, scale) {
  const hash = createHash('md5').update(bytes).digest('hex').slice(0, 8)
  const tag = Number.isInteger(scale) ? String(scale) : String(Number(scale.toFixed(2)))
  return `${timestamp()}-${hash}@${tag}x.png`
}

/** The `DSH-SHOW:{…}` report DSHPlugin` prints for every guarded render: ok, timings, messages. */
export function parseShowReport(text) {
  const match = /DSH-SHOW:(\{.*\})\s*$/m.exec(text)
  if (match === null) return undefined
  try {
    const r = JSON.parse(match[1])
    if (typeof r?.ok !== 'boolean') return undefined
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null)
    return {
      ok: r.ok,
      error: typeof r.error === 'string' ? r.error : null,
      evalMs: num(r.evalMs), rasterMs: num(r.rasterMs), kernelMs: num(r.totalMs),
      messages: Array.isArray(r.messages) ? r.messages.filter(m => typeof m === 'string') : [],
      timedOut: r.timedOut === true,
      errorImage: r.errorImage === true,
      // Native 3D scene (kernel/Scene3D.wl): JSON in a temp file the host reads and deletes.
      scene: typeof r.scene?.path === 'string' ? { path: r.scene.path, bytes: num(r.scene.bytes) ?? 0, elements: num(r.scene.elements) ?? 0, sceneMs: num(r.scene.sceneMs) } : null,
      sceneUnsupported: Array.isArray(r.sceneUnsupported) ? r.sceneUnsupported.filter(m => typeof m === 'string') : [],
    }
  } catch { return undefined }
}

/**
 * Read and delete the scene JSON the kernel wrote for a report. Only files the kernel's own
 * `dsh-scene-*.json` naming in the temp directory are accepted (the path comes from kernel output).
 * @returns {Promise<Uint8Array | undefined>}
 */
export async function takeSceneFile(report) {
  const path = report?.scene?.path
  if (typeof path !== 'string' || !/\/dsh-scene-[a-z0-9]+\.json$/.test(path)) return undefined
  try {
    const bytes = await readFile(path)
    unlink(path).catch(() => {})
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  } catch { return undefined }
}

/** Strip the plugin's report lines from model/user-visible kernel output. */
export function stripReports(text) {
  return text.replace(/^.*DSH-(?:SHOW|MANIPULATE):.*$/gm, '').replace(/\n{2,}/g, '\n').trim()
}

/** A kernel-side failure surfaced as an Error with the collected messages. */
export function showFailure(report, fallbackText) {
  const lines = [report?.error ?? 'rendering failed']
  if (report?.messages?.length) lines.push(...report.messages.map(m => `  ${m}`))
  else if (fallbackText) lines.push(fallbackText.slice(0, 800))
  return new Error(lines.join('\n'))
}

/** The `DSH-MANIPULATE:{…}` descriptor DSHPlugin`ShowRasterizer prints for an interactive graphic, validated. */
export function parseManipulate(text) {
  const match = /DSH-MANIPULATE:(\{.*\})\s*$/m.exec(text)
  if (match === null) return undefined
  let parsed
  try { parsed = JSON.parse(match[1]) } catch { return undefined }
  if (typeof parsed?.id !== 'string' || !Array.isArray(parsed.controls) || parsed.controls.length === 0) return undefined
  const controls = []
  // Label trees are opaque JSON for the client renderer; keep them only when small and JSON-clean.
  const tree = (v) => (v !== undefined && v !== null && typeof v === 'object' && JSON.stringify(v).length < 4000 ? v : null)
  for (const c of parsed.controls) {
    if (typeof c?.name !== 'string' || typeof c.type !== 'string') return undefined
    const label = typeof c.label === 'string' ? c.label : c.name
    const labelTree = tree(c.labelTree)
    if (c.type === 'slider') {
      if (typeof c.min !== 'number' || typeof c.max !== 'number' || typeof c.init !== 'number') return undefined
      controls.push({ name: c.name, label, labelTree, type: 'slider', min: c.min, max: c.max, step: typeof c.step === 'number' ? c.step : null, init: c.init })
    } else if (c.type === 'checkbox') {
      controls.push({ name: c.name, label, labelTree, type: 'checkbox', init: c.init === true })
    } else if (c.type === 'setter' || c.type === 'popup') {
      if (!Array.isArray(c.choices) || !c.choices.every(x => typeof x === 'string') || typeof c.init !== 'number') return undefined
      const choiceTrees = Array.isArray(c.choiceTrees) && c.choiceTrees.length === c.choices.length ? c.choiceTrees.map(tree) : c.choices.map(() => null)
      controls.push({ name: c.name, label, labelTree, type: c.type, choices: c.choices, choiceTrees, init: c.init })
    } else return undefined
  }
  return { id: parsed.id, controls }
}

/** A JSON-clean copy of an attachment reference (no undefined members). */
function cleanRef(ref) {
  const out = { attachmentId: String(ref.attachmentId), mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height }
  if (typeof ref.name === 'string') out.name = ref.name
  if (ref.originalDimensions !== undefined) out.originalDimensions = { width: ref.originalDimensions.width, height: ref.originalDimensions.height }
  return out
}

/**
 * @param {object} deps
 * @param {import('./kernels.mjs').KernelSessions} deps.sessions
 * @param {(exec: object, bytes: Uint8Array, name: string, mediaType?: string) => Promise<{ ref?: object, reason?: string }>} deps.admitImage - model-gated admission (eval/run images, show with see:true)
 * @param {(bytes: Uint8Array, name: string) => Promise<{ ref?: object, reason?: string }>} deps.storeImage - ungated admission (show; user-facing only)
 * @param {(agent: object) => string} deps.labelOf
 * @param {{ resolution: number, writeFiles: boolean, showDirectory: string }} deps.config
 * @param {(record: object) => void} deps.trace
 * @param {(kernel: object) => 'light' | 'dark'} deps.themeOf
 * @param {object} fallbackAgent - the agent these tools are registered for.
 * @returns {object[]} tool definitions
 */
export function createTools(deps, fallbackAgent) {
  const { sessions, admitImage, storeImage, labelOf, config, trace, themeOf } = deps
  const tools = []
  /** Image refs awaiting finalizeContent, keyed by execution. */
  const pending = new WeakMap()

  const agentOf = (exec) => exec.agent ?? fallbackAgent
  const cwdOf = (agent) => agent?.session?.header?.cwd ?? process.cwd()
  const { writeShowFile } = createShowCore(deps)

  /** Model-gated admission of evaluator images; unadmitted ones are written to disk instead. */
  async function admitAll(exec, images, prefix) {
    const refs = []
    const saved = []
    let reason
    for (const [i, image] of images.entries()) {
      const admitted = await admitImage(exec, image.data, `${prefix}-${i + 1}.png`, image.mediaType)
      if (admitted.ref !== undefined) refs.push(admitted.ref)
      else {
        reason = admitted.reason
        if (config.writeFiles && image.mediaType === 'image/png') saved.push(await writeShowFile(image.data, 2))
      }
    }
    if (refs.length > 0) pending.set(exec, refs)
    return { admitted: refs.length, saved, ...(reason !== undefined ? { inlineUnavailable: reason } : {}) }
  }

  /** Append the pending image blocks to the rendered text (never on error). */
  function finalizeImages(exec, result) {
    const refs = pending.get(exec)
    if (refs === undefined) return undefined
    pending.delete(exec)
    if (result.isError) return undefined
    return [...result.content, ...refs.map(ref => ({ type: 'image', attachment: ref }))]
  }

  const imageNote = (value) => {
    const parts = []
    if (value.admitted > 0) parts.push(`${value.admitted} image${value.admitted === 1 ? '' : 's'} attached below`)
    if (value.saved?.length > 0) parts.push(`image${value.saved.length === 1 ? '' : 's'} saved to ${value.saved.join(', ')} (not shown inline: ${value.inlineUnavailable}; wolfram_show shows graphics to the user regardless of model)`)
    return parts.length > 0 ? `\n[${parts.join('; ')}]` : ''
  }

  // ---------------------------------------------------------------- lifecycle

  tools.push(defineTool({
    name: 'wolfram_kernel_open',
    description: 'Start a NEW Wolfram Language kernel for this chat and make it the default. Returns its id (wl:<session>:<kernel>). Kernels are isolated per chat session (subagents get their own); each has independent definitions and state. You rarely need this: wolfram_eval / wolfram_run / wolfram_show start one automatically. Use it to run several independent kernels side by side, or to get a clean state.',
    parameters: { label: { type: 'string', description: 'Optional human label shown in wolfram_kernel_list.' } },
    output: objectOutput(v => `Opened kernel ${v.kernelId}${v.label ? ` (${v.label})` : ''} in ${v.startupMs} ms (pid ${v.pid}, cwd ${v.cwd}). It is now this chat's default kernel.`),
    async execute(args, exec) {
      const kernel = await sessions.open(agentOf(exec), args.label)
      return { kernelId: kernel.id, label: kernel.label, pid: kernel.pid ?? 0, sandboxPid: kernel.sandboxPid ?? 0, cwd: kernel.cwd, startupMs: kernel.startupMs }
    },
  }))

  tools.push(defineTool({
    name: 'wolfram_kernel_close',
    description: 'Close one of this chat\'s Wolfram kernels (default: the last-started one), freeing ~200 MB. Also accepts orphanPid to kill a stray kernel process listed by wolfram_kernel_list global:true whose parent is dead (never a live Claude Desktop / other chat\'s kernel).',
    parameters: {
      kernelId: KERNEL_ID,
      orphanPid: { type: 'integer', description: 'Pid of a stray StartMCPServer process (from wolfram_kernel_list global:true, parentAlive=false) to SIGKILL instead of closing one of your kernels.' },
    },
    output: objectOutput(v => {
      if (v.orphanKilled !== undefined) return `Killed stray kernel process ${v.orphanKilled}${v.childrenKilled.length > 0 ? ` and its child kernel(s) ${v.childrenKilled.join(', ')}` : ''}.`
      if (v.closed.length === 0) return 'No kernel to close: this chat has no running Wolfram kernel.'
      return `Closed ${v.closed.join(', ')}. ${v.default === null ? 'This chat now has no kernel; the next wolfram_* call starts one.' : `Default kernel is now ${v.default}.`}`
    }),
    async execute(args, exec) {
      const agent = agentOf(exec)
      if (args.orphanPid !== undefined) {
        const scan = scanKernelProcesses()
        const stray = scan.find(p => p.pid === args.orphanPid)
        const { others } = sessions.listAll(agent, labelOf)
        const own = sessions.listOwn(agent).kernels
        if (stray === undefined) throw new Error(`Pid ${args.orphanPid} is not a running Wolfram AgentTools server process.`)
        if (own.some(k => k.pid === stray.pid) || others.some(k => k.pid === stray.pid || k.sandboxPid === stray.pid)) throw new Error(`Pid ${args.orphanPid} belongs to a supervised kernel; close it with kernelId instead.`)
        if (stray.parentAlive) throw new Error(`Pid ${args.orphanPid} has a live parent (${stray.launcher}); it is not an orphan. Refusing to kill it.`)
        const children = childPids(stray.pid)
        const killed = killHard([stray.pid, ...children])
        trace({ event: 'orphan-killed', id: agent.id, pid: stray.pid, children })
        return { orphanKilled: stray.pid, childrenKilled: killed.filter(p => p !== stray.pid), closed: [], default: null }
      }
      const closed = await sessions.close(agent, args.kernelId ?? undefined, 'tool')
      const d = sessions.defaultOf(sessions.session(agent, false) ?? { order: [], kernels: new Map() })
      return { closed, default: d === undefined ? null : d.id }
    },
  }))

  tools.push(defineTool({
    name: 'wolfram_kernel_list',
    description: 'List this chat\'s Wolfram kernels (id, label, default, pid, uptime, evaluations). With global:true also lists every other chat\'s kernels (read-only) and stray AgentTools kernel processes on this machine that no supervisor owns.',
    parameters: { global: { type: 'boolean', description: 'Include other chats\' kernels and stray processes (default false).' } },
    output: objectOutput(renderList),
    async execute(args, exec) {
      const agent = agentOf(exec)
      const own = sessions.listOwn(agent)
      if (!args.global) return { ...own, global: false }
      const { others, strays } = sessions.listAll(agent, labelOf)
      return { ...own, global: true, others, strays }
    },
  }))

  // ---------------------------------------------------------------- work

  tools.push(defineTool({
    name: 'wolfram_eval',
    description: 'Evaluate Wolfram Language code in this chat\'s kernel (Mathematica). Definitions persist between calls in the same kernel. Returns the printed output and Out[n] result as text; graphics results come back as images (attached when the current model accepts images, otherwise saved to disk — use wolfram_show to display a plot to the user regardless). Relative paths resolve against the chat workspace. Prefer wolfram_show when the point is for the USER to see a graphic.',
    parameters: { code: { type: 'string', required: true, description: 'Wolfram Language code (multiple statements allowed; the last expression is Out[n]).' }, kernelId: KERNEL_ID, timeConstraint: TIME_CONSTRAINT },
    output: objectOutput(v => tagged(v, (v.output || '(no output)') + imageNote(v))),
    async execute(args, exec) {
      const { kernel, opened } = await sessions.resolve(agentOf(exec), args.kernelId)
      const { text, images } = await evaluate(kernel, args.code, { timeConstraint: args.timeConstraint })
      const admitted = await admitAll(exec, images, `wolfram-eval-${Date.now()}`)
      return { kernelId: kernel.id, opened, startupMs: kernel.startupMs, output: text, ...admitted }
    },
    finalizeContent: finalizeImages,
  }))

  tools.push(defineTool({
    name: 'wolfram_run',
    description: 'Run a Wolfram Language script file (.wl, .wls or .m) inside this chat\'s kernel via Get[], so its definitions stay available to later wolfram_eval calls. $ScriptCommandLine is set to {path, ...args}. Prints and messages are captured; the script\'s last expression is returned. A script that calls Exit[] terminates that kernel.',
    parameters: {
      path: { type: 'string', required: true, description: 'Script path (absolute, ~-relative, or relative to the chat workspace).' },
      args: { type: 'array', items: { type: 'string' }, description: 'Arguments exposed as Rest[$ScriptCommandLine].' },
      kernelId: KERNEL_ID,
      timeConstraint: TIME_CONSTRAINT,
    },
    output: objectOutput(v => tagged(v, `ran ${v.path}\n${v.output || '(no output)'}` + imageNote(v))),
    async execute(args, exec) {
      const agent = agentOf(exec)
      const expanded = args.path.replace(/^~(?=\/|$)/, homedir())
      const path = isAbsolute(expanded) ? expanded : resolvePath(cwdOf(agent), expanded)
      if (!SCRIPT_EXTENSIONS.has(extname(path).toLowerCase())) throw new Error(`wolfram_run accepts .wl, .wls or .m files; got "${basename(path)}".`)
      try { if (!(await stat(path)).isFile()) throw new Error('not a file') } catch { throw new Error(`No script at ${path}.`) }
      const { kernel, opened } = await sessions.resolve(agent, args.kernelId)
      const argv = (args.args ?? []).map(wlString).join(', ')
      const code = `DSHPlugin\`RunScript[${wlString(path)}, {${argv}}]`
      const { text, images } = await evaluate(kernel, code, { timeConstraint: args.timeConstraint })
      const admitted = await admitAll(exec, images, `wolfram-run-${Date.now()}`)
      return { kernelId: kernel.id, opened, startupMs: kernel.startupMs, path, output: text, ...admitted }
    },
    finalizeContent: finalizeImages,
  }))

  const showCore = createShowCore(deps)

  tools.push(defineTool({
    name: 'wolfram_show',
    description: 'Render a Wolfram Language expression (plot, graphic, grid, typeset formula, image, Style[…]) at retina resolution and SHOW IT TO THE USER inline in the chat. A top-level Manipulate[body, {x, 0, 1}, {c, {a, b}}, …] with simple control specs becomes an INTERACTIVE widget with native controls the user can drive (re-rendered in this kernel on release). Graphics3D (plots too) is shown as a NATIVE rotatable 3D scene (three.js) with the PNG as fallback; Manipulate of Graphics3D swaps geometry under the user\'s camera. Evaluated in this chat\'s kernel so it can use variables you defined with wolfram_eval. The image is displayed to the user directly by the GUI; you receive one line of metadata and the PNG path. Do NOT call read_image or wolfram_show again on the result — it is already visible. Graphics follow the GUI\'s light/dark appearance automatically (the kernel\'s front end is pinned to it). Set see:true only when YOU need to inspect the rendering too (costs image tokens). The user can also do this without you: /wolfram-show <expression>.',
    parameters: {
      expression: { type: 'string', required: true, description: 'Expression to render, e.g. Plot[Sin[x], {x, 0, 2 Pi}] or Grid[data, Frame -> All]. Multiple statements allowed; the last one is rendered.' },
      kernelId: KERNEL_ID,
      resolution: { type: 'integer', description: 'Rasterize ImageResolution in dpi (default 144 = @2x retina; 72 = 1x).' },
      see: { type: 'boolean', description: 'Also return the image to you, the model (default false: user-only).' },
      background: { type: 'string', enum: ['transparent', 'opaque'], description: 'transparent (default): PNG with alpha so the chat background shows through; opaque: the kernel\'s own light/dark page colour.' },
      label: { type: 'string', description: 'Optional caption shown under the image.' },
      timeConstraint: TIME_CONSTRAINT,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, v) => [{ type: 'text', text: tagged(v, `displayed ${v.label || 'image'}: ${v.devicePixels.width}x${v.devicePixels.height} px = ${v.points.width}x${v.points.height} pt (@${v.scale}x; eval ${v.timing?.evalMs ?? '?'} ms, rasterize ${v.timing?.rasterMs ?? '?'} ms, total ${v.timing?.totalMs ?? '?'} ms)${v.path ? `, ${v.path}` : ''}.${v.errorImage ? ' WARNING: the rendering contains a pink error box — the expression probably did not evaluate as intended.' : ''} ${v.attachment !== null ? 'Shown to the user inline already; do not call read_image or wolfram_show on it again.' : `Not shown inline (${v.inlineUnavailable}); the PNG is on disk at the path above.`}${v.scene ? ` The user sees it as a native, rotatable 3D scene (${v.scene.elements} element${v.scene.elements === 1 ? '' : 's'}, ${Math.round(v.scene.bytes / 1024)} KB).` : ''}${v.sceneUnsupported?.length ? ` (No native 3D scene: unsupported ${v.sceneUnsupported.join(', ')}; the PNG is shown.)` : ''}${v.see && v.attachment !== null ? ' Image attached below for you.' : ''}${v.manipulate ? ` Interactive: ${v.manipulate.controls.map(c => `${c.name} (${c.type})`).join(', ')} — the user can drive the controls in the chat; the kernel keeps the definition while it runs.` : ''}`) }],
      // Card metadata the client renders; never part of the model-visible content.
      presentationMeta: (_args, v) => showPresentation(v),
    },
    async execute(args, exec) {
      const value = await showCore.show(agentOf(exec), args)
      if (args.see === true && value.attachment !== null && value.pngBytes !== undefined) {
        const admitted = await admitImage(exec, value.pngBytes, basename(value.path ?? 'wolfram-show.png'), 'image/png')
        if (admitted.ref !== undefined) pending.set(exec, [admitted.ref])
        else value.seeUnavailable = admitted.reason
      }
      delete value.pngBytes
      return value
    },
    finalizeContent: finalizeImages,
  }))

  tools.push(defineTool({
    name: 'wolfram_symbol',
    description: 'Documentation summary (usage, options, attributes) of Wolfram Language symbols, from the kernel\'s own documentation index. Comma-separate several.',
    parameters: { symbols: { type: 'string', required: true, description: 'Symbol name(s), e.g. "Rasterize" or "Map, Apply".' }, kernelId: KERNEL_ID },
    output: objectOutput(v => tagged(v, v.output)),
    async execute(args, exec) {
      const { kernel, opened } = await sessions.resolve(agentOf(exec), args.kernelId)
      const output = await kernel.conn.callText('SymbolDefinition', { symbols: args.symbols })
      kernel.lastUsedAt = Date.now()
      return { kernelId: kernel.id, opened, startupMs: kernel.startupMs, output }
    },
  }))

  tools.push(defineTool({
    name: 'wolfram_lint',
    description: 'Static analysis of Wolfram Language code (CodeInspector): syntax errors, unused variables, suspicious patterns. Does not evaluate the code.',
    parameters: { code: { type: 'string', required: true, description: 'Wolfram Language source to inspect.' }, kernelId: KERNEL_ID },
    output: objectOutput(v => tagged(v, v.output)),
    async execute(args, exec) {
      const { kernel, opened } = await sessions.resolve(agentOf(exec), args.kernelId)
      const output = await kernel.conn.callText('CodeInspector', { code: args.code })
      kernel.lastUsedAt = Date.now()
      return { kernelId: kernel.id, opened, startupMs: kernel.startupMs, output }
    },
  }))

  return tools
}


/** The presentation payload shared by the wolfram_show card meta and the /wolfram-show command result. */
export function showPresentation(v) {
  return { attachment: v.attachment, points: v.points, devicePixels: v.devicePixels, scale: v.scale, path: v.path ?? null, sourcePath: v.sourcePath ?? null, label: v.label || null, kernelId: v.kernelId, theme: v.theme, manipulate: v.manipulate, timing: v.timing ?? null, errorImage: v.errorImage === true, scene: v.scene ?? null }
}

/**
 * The wolfram_show core, independent of the tool DSL so the /wolfram-show slash
 * command (no model involved) produces the identical result and card.
 * @param {object} deps - same bag as createTools (sessions, storeImage, config, themeOf, trace).
 */
export function createShowCore(deps) {
  const { sessions, storeImage, storeFile, config, trace, themeOf } = deps

  /**
   * Store the native 3D scene a report points at as a verbatim file attachment.
   * @returns {Promise<{ attachment: object, bytes: number, elements: number, sceneMs: number | null } | undefined>}
   */
  async function storeScene(report, name) {
    if (report?.scene === null || report?.scene === undefined || storeFile === undefined) return undefined
    const bytes = await takeSceneFile(report)
    if (bytes === undefined) return undefined
    const stored = await storeFile(bytes, name)
    if (stored.ref === undefined) { trace({ event: 'scene-store-failed', reason: stored.reason }); return undefined }
    return { attachment: { attachmentId: String(stored.ref.attachmentId), name: stored.ref.name, bytes: stored.ref.bytes }, bytes: bytes.byteLength, elements: report.scene.elements, sceneMs: report.scene.sceneMs ?? null }
  }
  const showDir = () => config.showDirectory.replace(/^~(?=\/|$)/, homedir())

  async function writeShowFile(bytes, scale) {
    const dir = showDir()
    await mkdir(dir, { recursive: true })
    const path = join(dir, showFileName(bytes, scale))
    await writeFile(path, bytes)
    return path
  }

  /**
   * @param {object} agent - the calling agent (its session's kernels).
   * @param {{ expression: string, kernelId?: string|null, resolution?: number, background?: string, label?: string, timeConstraint?: number }} args
   * @returns {Promise<object>} the canonical show value (plus `pngBytes`, which the caller strips).
   */
  async function show(agent, args) {
    const { kernel, opened } = await sessions.resolve(agent, args.kernelId)
    const resolution = args.resolution ?? config.resolution
    const scale = resolution / 72
    // Background -> None: transparent PNG, so the GUI's own light/dark page shows
    // through (a bare Graphics otherwise gets Rasterize's opaque page fill).
    // DSHPlugin`ShowRasterizer (kernel/DSHPlugin.wl) holds the expression; a
    // top-level Manipulate is registered under `showId` and described on a
    // "DSH-MANIPULATE:" Print line that the GUI turns into native controls.
    const background = args.background === 'opaque' ? 'Automatic' : 'None'
    const showId = `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    const code = `DSHPlugin\`ShowRasterizer[${JSON.stringify(showId)}, (\n${args.expression}\n), "Resolution" -> ${resolution}, "Background" -> ${background}]`
    const t0 = Date.now()
    const evaluated = await evaluate(kernel, code, { timeConstraint: args.timeConstraint })
    const totalMs = Date.now() - t0
    const report = parseShowReport(evaluated.text)
    const manipulate = parseManipulate(evaluated.text)
    const text = stripReports(evaluated.text)
    if (report !== undefined && !report.ok) throw showFailure(report, text)
    if (manipulate !== undefined) kernel.manipulates.set(showId, { descriptor: manipulate, scale })
    const image = evaluated.images.find(i => i.mediaType === 'image/png') ?? evaluated.images[0]
    if (image === undefined) throw new Error(`wolfram_show produced no image. Kernel output:\n${text || '(empty)'}`)
    const timing = { evalMs: report?.evalMs ?? null, rasterMs: report?.rasterMs ?? null, kernelMs: report?.kernelMs ?? null, totalMs }
    const size = pngSize(image.data) ?? { width: 0, height: 0 }
    const points = { width: Math.round(size.width / scale), height: Math.round(size.height / scale) }
    const path = config.writeFiles ? await writeShowFile(image.data, scale) : undefined
    // The source next to the PNG (same stem, .wl): what was sent to be rasterized, with a header comment.
    const sourcePath = path !== undefined ? await writeSourceFile(path, args.expression, kernel.id, agent) : undefined
    const stored = await storeImage(image.data, path !== undefined ? basename(path) : 'wolfram-show.png')
    // Graphics3D also arrives as a native scene (kernel/Scene3D.wl) the GUI renders with three.js.
    const scene = await storeScene(report, (path !== undefined ? basename(path).replace(/(@[\d.]+x)?\.png$/, '') : 'wolfram-show') + '.scene.json')
    trace({ event: 'show', kernelId: kernel.id, px: size, pt: points, path: path ?? null, manipulate: manipulate?.id ?? null, timing, scene: scene ? { bytes: scene.bytes, elements: scene.elements } : null, sceneUnsupported: report?.sceneUnsupported ?? [] })
    return {
      kernelId: kernel.id, opened, startupMs: kernel.startupMs,
      attachment: stored.ref !== undefined ? cleanRef(stored.ref) : null,
      devicePixels: size, points, scale, resolution, bytes: image.data.byteLength,
      see: args.see === true, label: args.label ?? '', theme: themeOf(kernel),
      manipulate: manipulate ?? null,
      scene: scene ?? null, sceneUnsupported: report?.sceneUnsupported ?? [],
      timing, errorImage: report?.errorImage === true, messages: report?.messages ?? [],
      ...(path !== undefined ? { path } : {}),
      ...(sourcePath !== undefined ? { sourcePath } : {}),
      ...(stored.ref === undefined ? { inlineUnavailable: stored.reason ?? 'attachment store unavailable' } : {}),
      pngBytes: image.data,
    }
  }

  /** `<stem>.wl` beside `<stem>@2x.png`: header comment + the expression exactly as submitted. */
  async function writeSourceFile(pngPath, expression, kernelId, agent) {
    const path = pngPath.replace(/(@[\d.]+x)?\.png$/, '.wl')
    const when = new Date().toISOString()
    const header = `(* wolfram_show · ${when} · kernel ${kernelId} · DSH session ${agent?.id ?? '?'} · image ${basename(pngPath)} *)\n`
    await writeFile(path, header + expression.trim() + '\n')
    return path
  }

  return { show, writeShowFile }
}

/** Text table for wolfram_kernel_list. */
function renderList(v) {
  const row = (k) => `${k.kernelId}${k.default ? ' *' : ''}${k.label ? ` "${k.label}"` : ''}  pid ${k.pid}${k.sandboxPid && k.sandboxPid !== k.pid ? ` (evaluator ${k.sandboxPid})` : ''}  ${k.starting ? 'starting' : k.alive ? 'alive' : 'DEAD'}  started ${k.startedAt}  idle ${k.idleSeconds}s  evals ${k.evalCount}  ${k.theme}  cwd ${k.cwd}`
  const lines = []
  if (v.session === null || v.kernels.length === 0) lines.push('This chat has no Wolfram kernel running (the next wolfram_* call starts one).')
  else lines.push(`This chat (session ${v.session}), * = default:`, ...v.kernels.map(row))
  if (v.global) {
    lines.push('', v.others.length === 0 ? 'Other chats: none.' : 'Other chats (read-only):', ...v.others.map(k => `  [${k.chat}] ${row(k)}`))
    lines.push('', v.strays.length === 0 ? 'Stray AgentTools kernel processes: none.' : 'Stray AgentTools kernel processes (not supervised by DSH):',
      ...v.strays.map(p => `  pid ${p.pid}  ppid ${p.ppid} (${p.parentAlive ? 'parent alive' : 'ORPHAN — parent dead; wolfram_kernel_close orphanPid:' + p.pid + ' kills it'})  ${p.launcher}`))
  }
  return lines.join('\n')
}
