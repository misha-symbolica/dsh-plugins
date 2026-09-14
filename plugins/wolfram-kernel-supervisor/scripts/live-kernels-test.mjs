/**
 * Live test against the real Mathematica kernel (no DSH needed):
 *   - two fake agents (sessions), three kernels, per-kernel isolation of definitions
 *   - kernelId validation across sessions
 *   - default = last-started, falls back after close
 *   - wolfram_show-style Rasterize returns a 2x PNG with the expected size
 *   - forget()/dispose() leave ZERO StartMCPServer processes behind (the leak regression test)
 * Run: node scripts/live-kernels-test.mjs   (~25 s)
 */
import { execFileSync } from 'node:child_process'
import { KernelSessions, evaluate } from '../kernels.mjs'
import { findAgentToolsDirectory, findKernel, kernelLaunch } from '../servers.mjs'
import { pngSize } from '../tools.mjs'

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; throw new Error(msg) } else console.log('ok  ', msg) }
const serverPids = () => { try { return execFileSync('pgrep', ['-f', 'StartMCPServer'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number) } catch { return [] } }

const before = new Set(serverPids())
const launch = kernelLaunch({ kernel: findKernel(''), pacletDirectory: findAgentToolsDirectory(''), server: 'WolframLanguage' })
const sessions = new KernelSessions({
  spec: (session, i) => ({ ...launch, clientName: `live-test · wl:${session.index}:${i}`, cwd: process.cwd() }),
  timeoutMs: 120_000, idleMs: 0, maxPerSession: 4, maxGlobal: 12,
  onIdleClose: () => {}, trace: (r) => console.log('     trace', JSON.stringify(r)), logger: console,
})
const agentA = { id: 'agent-A', session: { header: { cwd: process.cwd() } } }
const agentB = { id: 'agent-B', session: { header: { cwd: process.cwd() } } }

try {
  const t0 = Date.now()
  const [a0, a1, b0] = await Promise.all([sessions.open(agentA, 'first'), sessions.open(agentA, 'second'), sessions.open(agentB)])
  console.log(`     opened 3 kernels in parallel in ${Date.now() - t0} ms`)
  assert(a0.id === 'wl:0:0' && a1.id === 'wl:0:1' && b0.id === 'wl:1:0', `ids are wl:0:0, wl:0:1, wl:1:0 (got ${a0.id}, ${a1.id}, ${b0.id})`)
  assert(a0.sandboxPid > 0 && a1.sandboxPid > 0, `sandbox pids learned (${a0.sandboxPid}, ${a1.sandboxPid})`)
  assert(sessions.defaultOf(sessions.session(agentA)) === a1, 'default is the last-started kernel')

  await evaluate(a0, 'x = 1')
  const out = (t) => (/Out\[\d+\]=\s*(.*)$/m.exec(t)?.[1] ?? '').trim()
  const a1x = out((await evaluate(a1, 'x')).text)
  assert(a1x === 'x', `definitions do not leak between kernels of one session (wl:0:1 sees x = "${a1x}")`)
  const b0x = out((await evaluate(b0, 'x')).text)
  assert(b0x === 'x', `definitions do not leak across sessions (wl:1:0 sees x = "${b0x}")`)
  assert(out((await evaluate(a0, 'x + 1')).text) === '2', 'state persists within a kernel')
  assert((await evaluate(a0, 'Directory[] === ' + JSON.stringify(process.cwd()))).text.includes('True'), 'evaluator cwd pinned to the session cwd')

  let threw = false
  try { sessions.parse(agentB, 'wl:0:0') } catch { threw = true }
  assert(threw, 'agent B cannot address agent A\'s kernel')

  const { images } = await evaluate(a1, 'Rasterize[(\nGraphics[Disk[], ImageSize -> 100]\n), ImageResolution -> 144]')
  const size = pngSize(images[0]?.data ?? new Uint8Array())
  assert(size?.width === 200 && size?.height === 200, `Rasterize @144 dpi of a 100pt graphic is 200x200 px (got ${JSON.stringify(size)})`)

  assert((await sessions.close(agentA)).join() === 'wl:0:1', 'close() without id closes the default (last-started)')
  assert(sessions.defaultOf(sessions.session(agentA)) === a0, 'default falls back to the previous kernel')
  const { kernel: k, opened } = await sessions.resolve(agentA, undefined)
  assert(k === a0 && opened === false, 'resolve() without id returns the default without opening')
} finally {
  await sessions.dispose()
}
await new Promise(r => setTimeout(r, 500))
const leaked = serverPids().filter(p => !before.has(p))
assert(leaked.length === 0, `no StartMCPServer processes leaked (leaked: ${leaked.join(', ') || 'none'})`)
console.log(process.exitCode ? 'FAILED' : 'ALL OK')
