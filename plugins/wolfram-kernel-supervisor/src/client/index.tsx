/**
 * Wolfram kernel supervisor, browser half: keyed toolviews that render the
 * plugin's tool cards in the chat.
 *
 *   wolfram_show   the image, at POINT size (devicePixels / scale), from the
 *                  attachment reference the host persisted in the call's
 *                  presentationMeta (block.meta). The model never saw it.
 *   wolfram_eval   text output plus any image blocks the result carries
 *   wolfram_run    (same row as wolfram_eval)
 *
 * plus a PINNED GALLERY under each turn's final answer: in the default
 * "compact" transcript view the chat folds a settled turn's tool rows into a
 * "N tool calls" disclosure, which would hide the very image wolfram_show
 * exists to show. The turn-tail node (`conversation.chat.turnTail` chain) is
 * never folded, so a turn-scoped event accumulator collects every successful
 * wolfram_show of the turn (from the tool/result events' presentationMeta) and
 * the gallery renders them there, at point size. Pattern: ui-deliverables.
 *
 * Why a toolview: the generic tool card flattens non-text result blocks to
 * JSON, and image rendering is only possible from a keyed entry
 * (<checkout>/.agents/notes/implemented/feature/2026-08-20-tool-card-image-results.md).
 * The shared `tool.call.images` gallery slot is owned by the read_image entry
 * and a child slot has exactly one owner, so this row draws its own <img>
 * with the session-authorized `loadImage` loader every toolview receives.
 *
 * Claiming a key suppresses the generic card for EVERY shape of that tool, so
 * each row covers running / error / cancelled / missing-meta by falling back
 * to a plain text body.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only imports (erased at build time): SlotMap merges for
// 'tool.call.toolview' and the session-scope standard props.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { DisclosureRow, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CSSProperties, ReactNode } from 'react'
import { useEffect, useState } from 'react'

type Props = PropsRuntime<'tool.call.toolview'>
type Block = Props['block']
type LoadImage = Props['loadImage']

/** Mirror of dsh-attachment's ImageAttachmentRef (runtime narrowing at the wire boundary). */
interface ImageRef {
  attachmentId: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  bytes: number
  width: number
  height: number
  name?: string
}

const MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function positiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}
/** Defensive narrowing: the id is opaque (existence only), everything else exact. */
function asImageRef(value: unknown): ImageRef | undefined {
  if (!isRecord(value)) return undefined
  const { attachmentId, mediaType, bytes, width, height, name } = value
  if (typeof attachmentId !== 'string' || attachmentId === '') return undefined
  if (typeof mediaType !== 'string' || !MEDIA_TYPES.has(mediaType)) return undefined
  if (!positiveInt(bytes) || !positiveInt(width) || !positiveInt(height)) return undefined
  const ref: ImageRef = { attachmentId, mediaType: mediaType as ImageRef['mediaType'], bytes, width, height }
  if (typeof name === 'string') ref.name = name
  return ref
}

function isSettled(block: Block): block is Extract<Block, { kind: 'tool-result' }> {
  return 'kind' in block
}

/** Flattened result text: text blocks verbatim, image blocks omitted (they render), others as JSON. */
function resultText(block: Block): string {
  if (!isSettled(block)) return ''
  const parts: string[] = []
  for (const item of block.content) {
    if (item.type === 'text') parts.push(item.text)
    else if (item.type !== 'image') parts.push(JSON.stringify(item, null, 2))
  }
  if (parts.length === 0 && block.error !== undefined) parts.push(`${block.error.name}: ${block.error.code}`)
  return parts.join('\n').trim()
}

function imageRefsOf(block: Block): ImageRef[] {
  if (!isSettled(block)) return []
  const refs: ImageRef[] = []
  for (const item of block.content) {
    if (item.type === 'image' && 'attachment' in item) {
      const ref = asImageRef((item as { attachment?: unknown }).attachment)
      if (ref !== undefined) refs.push(ref)
    }
  }
  return refs
}

function parseArgs(block: Block): Record<string, unknown> {
  const raw = isSettled(block) ? block.call?.argsRaw : block.argsRaw
  if (typeof raw !== 'string') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** `[wl:0:1]` from the rendered result text (the host prefixes every result with it). */
function kernelIdOf(block: Block): string | undefined {
  const match = /\[(wl:\d+:\d+)\]/.exec(resultText(block))
  return match?.[1]
}

type RowState = 'running' | 'ok' | 'error'
function stateOf(block: Block): RowState {
  if (!isSettled(block)) return 'running'
  return block.isError ? 'error' : 'ok'
}

// ---------------------------------------------------------------- image loading

/** Same-origin URL of the plugin's own image route (host: index.js SHOWN_IMAGE_PATH). The browser sends the auth cookie. */
function shownImageUrl(sessionId: string, image: ImageRef): string {
  return `/api/wolfram/shown?sessionId=${encodeURIComponent(sessionId)}&attachmentId=${encodeURIComponent(image.attachmentId)}`
}

/**
 * Resolve an image to a displayable URL. A wolfram_show image (referenced only
 * by presentationMeta) comes from the plugin route; a content-block image (a
 * wolfram_eval plot the model also received) goes through the session loader,
 * which the core authorizes from the log's content blocks.
 */
function useImageUrl(source: { url: string } | { loadImage: LoadImage }, image: ImageRef): { url: string | undefined, failed: boolean } {
  const direct = 'url' in source ? source.url : undefined
  const loader = 'loadImage' in source ? source.loadImage : undefined
  const [url, setUrl] = useState<string | undefined>(() => direct ?? loader?.peek?.(image as never))
  const [failed, setFailed] = useState(false)
  const id = image.attachmentId
  useEffect(() => {
    if (direct !== undefined) { setUrl(direct); return }
    if (loader === undefined) return
    let cancelled = false
    setFailed(false)
    loader(image as never).then(
      (resolved) => { if (!cancelled) setUrl(resolved) },
      () => { if (!cancelled) setFailed(true) },
    )
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, direct, loader])
  return { url, failed }
}

const IMAGE_FRAME: CSSProperties = {
  display: 'inline-block',
  background: '#fff',
  borderRadius: 6,
  padding: 6,
  boxShadow: '0 0 0 1px color-mix(in srgb, currentColor 12%, transparent)',
  maxWidth: '100%',
  boxSizing: 'border-box',
}

// NB: the reference prop is `image`, not `ref` — React reserves `ref` and
// strips it from a function component's props (it arrived undefined).
function WolframImage({ source, image, pointWidth, alt, path }: { source: { url: string } | { loadImage: LoadImage }, image: ImageRef, pointWidth: number | undefined, alt: string, path: string | undefined }) {
  const { url, failed } = useImageUrl(source, image)
  const [broken, setBroken] = useState(false)
  const width = pointWidth ?? image.width
  if (failed || broken) return <div style={{ opacity: 0.7, fontSize: 12 }}>[image unavailable{path ? `: ${path}` : ''}]</div>
  if (url === undefined) return <div style={{ ...IMAGE_FRAME, width, aspectRatio: `${image.width} / ${image.height}`, opacity: 0.4 }} />
  return (
    <span style={IMAGE_FRAME}>
      <img
        src={url}
        alt={alt}
        width={width}
        style={{ display: 'block', width, maxWidth: '100%', height: 'auto', cursor: 'zoom-in' }}
        onClick={() => { window.open(url, '_blank', 'noopener') }}
        onError={() => setBroken(true)}
        title={path ?? alt}
      />
    </span>
  )
}

// ---------------------------------------------------------------- row chrome

const SPIKEY = (
  <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden style={{ display: 'block' }}>
    <path fill="currentColor" d="M12 1.5l2.3 4.7 5.2-.6-2.6 4.5 3.6 3.8-5.1 1 .1 5.2L12 17.6l-3.5 3.5.1-5.2-5.1-1 3.6-3.8L4.5 5.6l5.2.6z" />
  </svg>
)

const ROW_STYLE: CSSProperties = { fontSize: 13, lineHeight: '20px' }
const SUMMARY_STYLE: CSSProperties = { opacity: 0.7, marginLeft: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const BODY_STYLE: CSSProperties = { padding: '6px 0 8px 22px', display: 'flex', flexDirection: 'column', gap: 8 }
const PRE_STYLE: CSSProperties = { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, lineHeight: '18px', maxHeight: 360, overflow: 'auto' }

function leading(state: RowState): ReactNode {
  if (state === 'ok') return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>{SPIKEY}</span>
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <StateDot state={state === 'running' ? 'ongoing' : 'error'} />
      {SPIKEY}
    </span>
  )
}

function KernelRow({ title, summary, state, defaultOpen, children }: { title: string, summary: string, state: RowState, defaultOpen: boolean, children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  // A row mounts while its call is running (defaultOpen false) and must open
  // itself once the result carries an image; the user's own toggle wins after.
  const [touched, setTouched] = useState(false)
  useEffect(() => { if (defaultOpen && !touched) setOpen(true) }, [defaultOpen, touched])
  const expandable = children !== null && children !== undefined && children !== false
  return (
    <div style={ROW_STYLE} data-tool-state={state}>
      <DisclosureRow
        icon={leading(state)}
        title={title}
        open={open && expandable}
        expandable={expandable}
        expandOnRowClick
        keepContentWhenOpen
        onToggle={() => { setTouched(true); setOpen(v => !v) }}
        collapsedContent={summary !== '' ? <span style={SUMMARY_STYLE}>{summary}</span> : undefined}
      >
        <div style={BODY_STYLE}>{children}</div>
      </DisclosureRow>
    </div>
  )
}

// ---------------------------------------------------------------- wolfram_show

interface ShowMeta {
  attachment: ImageRef | null
  points?: { width: number, height: number }
  devicePixels?: { width: number, height: number }
  scale?: number
  path?: string | null
  label?: string | null
  kernelId?: string
}

function showMetaOf(block: Block): ShowMeta | undefined {
  if (!isSettled(block) || !isRecord(block.meta)) return undefined
  const meta = block.meta
  const attachment = asImageRef(meta.attachment) ?? null
  const dims = (v: unknown) => (isRecord(v) && positiveInt(v.width) && positiveInt(v.height) ? { width: v.width, height: v.height } : undefined)
  return {
    attachment,
    points: dims(meta.points),
    devicePixels: dims(meta.devicePixels),
    scale: typeof meta.scale === 'number' ? meta.scale : undefined,
    path: typeof meta.path === 'string' ? meta.path : null,
    label: typeof meta.label === 'string' && meta.label !== '' ? meta.label : null,
    kernelId: typeof meta.kernelId === 'string' ? meta.kernelId : undefined,
  }
}

function firstLine(s: string, max = 80): string {
  const line = s.split('\n')[0] ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export function WolframShowRow({ block, loadImage, sessionId }: Props) {
  const state = stateOf(block)
  const args = parseArgs(block)
  const expression = typeof args.expression === 'string' ? args.expression : ''
  const meta = showMetaOf(block)
  const text = resultText(block)
  const label = meta?.label ?? firstLine(expression)
  const kernelId = meta?.kernelId ?? kernelIdOf(block)
  const size = meta?.devicePixels && meta.points ? `${meta.points.width}×${meta.points.height} pt${meta.scale && meta.scale !== 1 ? ` @${meta.scale}x` : ''}` : ''
  const summary = [kernelId, state === 'running' ? 'rendering…' : size].filter(Boolean).join(' · ')
  const ref = meta?.attachment ?? imageRefsOf(block)[0]
  const body = state === 'running'
    ? <pre style={PRE_STYLE}>{expression}</pre>
    : ref !== undefined
      ? (
        <>
          <WolframImage source={meta?.attachment !== undefined && meta.attachment !== null ? { url: shownImageUrl(String(sessionId), ref) } : { loadImage }} image={ref} pointWidth={meta?.points?.width} alt={label} path={meta?.path ?? undefined} />
          {(meta?.label || meta?.path) && (
            <div style={{ fontSize: 12, opacity: 0.7 }}>
              {meta?.label ? <span>{meta.label}</span> : null}
              {meta?.label && meta?.path ? ' · ' : null}
              {meta?.path ? <code style={{ fontSize: 11 }}>{meta.path}</code> : null}
            </div>
          )}
          <details style={{ fontSize: 12, opacity: 0.7 }}>
            <summary>expression</summary>
            <pre style={PRE_STYLE}>{expression}</pre>
          </details>
        </>
      )
      : <pre style={PRE_STYLE}>{text || expression}</pre>
  return (
    <KernelRow title={`Wolfram show${label ? `: ${label}` : ''}`} summary={summary} state={state} defaultOpen={state !== 'running' && ref !== undefined}>
      {body}
    </KernelRow>
  )
}

// ---------------------------------------------------------------- wolfram_eval / wolfram_run

export function WolframEvalRow({ toolName, block, loadImage }: Props) {
  const state = stateOf(block)
  const args = parseArgs(block)
  const code = typeof args.code === 'string' ? args.code : typeof args.path === 'string' ? args.path : ''
  const text = resultText(block)
  const refs = imageRefsOf(block)
  const kernelId = kernelIdOf(block)
  const output = text.replace(/^\[wl:\d+:\d+\]\n?/, '').replace(/^Opened kernel [^\n]*\n?/, '')
  const summary = [kernelId, state === 'running' ? 'evaluating…' : firstLine(code)].filter(Boolean).join(' · ')
  const title = toolName === 'wolfram_run' ? 'Wolfram run' : 'Wolfram eval'
  return (
    <KernelRow title={title} summary={summary} state={state} defaultOpen={refs.length > 0}>
      {code !== '' && <pre style={PRE_STYLE}>{code}</pre>}
      {state !== 'running' && output !== '' && (
        <pre style={{ ...PRE_STYLE, opacity: 0.85, borderLeft: '2px solid color-mix(in srgb, currentColor 20%, transparent)', paddingLeft: 8 }}>{output}</pre>
      )}
      {refs.map((ref) => <WolframImage key={ref.attachmentId} source={{ loadImage }} image={ref} pointWidth={Math.round(ref.width / 2)} alt="Wolfram graphics" path={undefined} />)}
    </KernelRow>
  )
}

// ---------------------------------------------------------------- pinned gallery (turn tail)

/** One successful wolfram_show of a turn, as the tool/result event recorded it. */
interface ShownImage {
  readonly seq: number
  readonly callId: string
  readonly meta: ShowMeta & { attachment: ImageRef }
}

export interface WolframShownTurnData {
  readonly shown: readonly ShownImage[]
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationTurnDataMap {
    wolframShown: WolframShownTurnData
  }
}

interface WolframShownState extends WolframShownTurnData {
  readonly turn: number
  /** callId → tool name, so a result can be attributed to wolfram_show. */
  readonly calls: ReadonlyMap<string, string>
}

/** Narrow one tool/result event's presentationMeta into a gallery entry. */
function shownFromMeta(meta: unknown): (ShowMeta & { attachment: ImageRef }) | undefined {
  if (!isRecord(meta)) return undefined
  const attachment = asImageRef(meta.attachment)
  if (attachment === undefined) return undefined
  const dims = (v: unknown) => (isRecord(v) && positiveInt(v.width) && positiveInt(v.height) ? { width: v.width, height: v.height } : undefined)
  return {
    attachment,
    points: dims(meta.points),
    devicePixels: dims(meta.devicePixels),
    scale: typeof meta.scale === 'number' ? meta.scale : undefined,
    path: typeof meta.path === 'string' ? meta.path : null,
    label: typeof meta.label === 'string' && meta.label !== '' ? meta.label : null,
    kernelId: typeof meta.kernelId === 'string' ? meta.kernelId : undefined,
  }
}

/** Turn-local accumulator of shown images; publishes no view node, only turn data. */
const wolframShownDefinition: ConversationNodeDefinition<WolframShownState> = {
  kind: 'wolframShown', // must equal the Location data key below (the engine enforces it)
  match: (event) => {
    if (event.type === 'turn/start') return { id: String((event.data as { turn: number }).turn), role: 'start' }
    if (event.type === 'tool/call' || event.type === 'tool/result') return { id: String((event.data as { turn: number }).turn), role: 'update' }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'turn/start') throw new Error('wolframShown start requires turn/start')
    return { turn: (match.event.data as { turn: number }).turn, calls: new Map(), shown: [] }
  },
  update: (context, match) => {
    const event = match.event as { type: string, seq: number, data: Record<string, unknown> }
    if (event.type === 'tool/call') {
      const calls = new Map(context.state.calls)
      calls.set(String(event.data.callId), String(event.data.name))
      return { ...context.state, calls }
    }
    if (event.type !== 'tool/result') return context.state
    const message = event.data.message as { source?: { callId?: unknown }, content?: { isError?: boolean }[] } | undefined
    const callId = String(message?.source?.callId ?? '')
    if (context.state.calls.get(callId) !== 'wolfram_show') return context.state
    if (message?.content?.[0]?.isError === true) return context.state
    const meta = shownFromMeta(event.data.meta)
    if (meta === undefined) return context.state
    return { ...context.state, shown: [...context.state.shown, { seq: event.seq, callId, meta }] }
  },
  buildLocationData: (context, scope, previous) => {
    if (scope !== 'turn' || context.state === undefined) return null
    if (previous?.kind === 'turn'
      && previous.turn === context.state.turn
      && previous.key === 'wolframShown'
      && (previous.value as WolframShownTurnData).shown === context.state.shown) return previous
    return { kind: 'turn', turn: context.state.turn, key: 'wolframShown', value: { shown: context.state.shown } }
  },
}

/** Claim the turn tail only when the closing turn showed something (up to the closing seq). */
function selectShown(owner: TurnTailOwnerProps): readonly ShownImage[] | null {
  const data = owner.turn.data.get('wolframShown')
  if (data === undefined) return null
  const shown = data.shown.filter(s => s.seq <= owner.seq)
  return shown.length === 0 ? null : shown
}

type GalleryInjected = { sessionId: string }
type GalleryProps = Pick<TurnTailOwnerProps, 'openFile'> & { matched: readonly ShownImage[] } & InjectFace<GalleryInjected>

const GALLERY_STYLE: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-start', padding: '4px 0 8px' }

/** The turn's shown images, pinned under the final answer (never folded away). */
function ShownGallery({ matched, sessionId }: GalleryProps) {
  return (
    <div style={GALLERY_STYLE} data-wolfram-shown={matched.length}>
      {matched.map((item) => (
        <figure key={item.callId} style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 4, maxWidth: '100%' }}>
          <WolframImage source={{ url: shownImageUrl(sessionId, item.meta.attachment) }} image={item.meta.attachment} pointWidth={item.meta.points?.width} alt={item.meta.label ?? 'Wolfram graphics'} path={item.meta.path ?? undefined} />
          {(item.meta.label || item.meta.path) && (
            <figcaption style={{ fontSize: 12, opacity: 0.7 }}>
              {item.meta.label ?? ''}
              {item.meta.label && item.meta.path ? ' · ' : ''}
              {item.meta.path ? <code style={{ fontSize: 11 }}>{item.meta.path}</code> : null}
            </figcaption>
          )}
        </figure>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- plugin

export const name = 'wolfram-kernel-supervisor-client'
export const inject = ['slots', 'uiConversation']

export function apply(ctx: Context): void {
  // Turn-scoped accumulator feeding the pinned gallery (registration unwinds with the plugin).
  ctx.uiConversation.events.register(wolframShownDefinition)
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail',
    select: selectShown,
    inject: (sessionId): GalleryInjected => ({ sessionId: String(sessionId) }),
  }, ShownGallery))

  // The callback returns the registrations' disposers so they unwind with the
  // slot owner (and re-register when it is mounted again).
  ctx.slots.inject('tool.call.toolview', () => [
    ctx.slots.register({ name: 'tool.call.toolview', key: 'wolfram_show' }, WolframShowRow),
    ctx.slots.register({ name: 'tool.call.toolview', key: 'wolfram_eval' }, WolframEvalRow),
    ctx.slots.register({ name: 'tool.call.toolview', key: 'wolfram_run' }, WolframEvalRow),
  ])
}
