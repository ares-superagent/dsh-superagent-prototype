/**
 * The runtime progress cadence: its start, ten-minute interval, completion, queued and stalled states, duplicate
 * suppression, recovery after a restart, and the limits of what it claims without a worker report.
 */
import { describe, expect, it } from 'vitest'
import { Engine, MemoryRepositories, type Assignment, type ChannelRef, type OutboundMessage, type Policy, type Ticket }
  from '../src/core/index.ts'
import { Progress, type ProgressActivity } from '../src/app/progress.ts'
import { wordCount } from '../src/infra/text.ts'

const AT = '2026-09-23T00:00:00.000Z'
const channel = (source = 'github'): ChannelRef => ({ source, thread: `${source}:42`, address: { number: '42' } })
const assignment = (overrides: Partial<Assignment> = {}): Assignment =>
  ({ id: 'a1', state: 'running', createdAt: AT, startedAt: AT, ...overrides })
const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: 'ticket-1', title: 'Fix the failing check', decisionId: 'd1',
  mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed', sender: 'Alice' },
    actor: { source: 'github', id: 'alice' }, scope: 'small' },
  channels: [channel()], assignments: [assignment()], inputs: [], undelivered: [],
  createdAt: AT, updatedAt: AT, origin: { triggerId: 'trigger-1', triggerIds: ['trigger-1'] }, ...overrides,
})
const policy: Policy = { version: 'v1', paused: false, evalTimeoutMs: 60_000,
  gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }), revalidate: () => true, admitsInferred: () => true }
const health = { get: () => undefined, set: () => {}, release: () => {} }

/** A runtime with one open ticket, a real Engine and outbox, a controllable clock and worker activity. */
function harness(overrides: Partial<Ticket> = {}, options: { intervalMs?: number; stalledAfterMs?: number } = {}) {
  const repo = new MemoryRepositories()
  const sent: OutboundMessage[] = []
  let clock = Date.parse(AT)
  let activity: ProgressActivity | undefined
  let pending = false
  const engine = new Engine({ repo, scope: { scope: () => ({ listened: true, observed: false }) }, policy: () => policy,
    assessor: { request: () => {} }, executor: { start: () => {}, deliver: () => {}, stop: () => {} },
    outbox: { send: message => { if (!sent.some(item => item.id === message.id)) sent.push(message) },
      status: id => sent.some(item => item.id === id) ? 'pending' : undefined, withdraw: () => {} },
    now: () => new Date(clock).toISOString() })
  repo.tickets.save(ticket(overrides))
  const make = () => new Progress({ tickets: () => repo.tickets.open(), publish: (id, update) => { engine.publishProgress(id, update) },
    activity: () => activity, pending: () => pending, now: () => new Date(clock).toISOString(), paused: () => false, closing: () => false,
    health }, options)
  let progress = make()
  return { repo, engine, sent, progress,
    advance: (minutes: number) => { clock += minutes * 60_000 },
    setActivity: (value: ProgressActivity | undefined) => { activity = value },
    setPending: (value: boolean) => { pending = value },
    restart: () => { progress.stop(); progress = make(); return progress },
    at: (minutes: number) => new Date(Date.parse(AT) + minutes * 60_000).toISOString() }
}
const lastProgress = (h: ReturnType<typeof harness>) => h.repo.tickets.get('ticket-1')!.assignments.at(-1)!.progress

describe('progress cadence', () => {
  it('publishes the first update ten minutes after the assignment starts, and not before', async () => {
    const h = harness()
    h.advance(9)
    await h.progress.pump()
    expect(h.sent).toEqual([])
    h.advance(1)
    await h.progress.pump()
    expect(h.sent).toHaveLength(1)
    const message = h.sent[0]!
    expect(message).toMatchObject({ kind: 'progress', channel: channel(), ticketId: 'ticket-1' })
    expect(message.text.startsWith('This is by an automated agent, not a human.')).toBe(true)
    expect(message.text).toContain('10 min in')
    for (const label of ['Completed:', 'Now:', 'Next:', 'Blocker:']) expect(message.text).toContain(label)
    expect(lastProgress(h)).toMatchObject({ phase: 'active' })
  })
  it('continues every ten minutes, and a worker report supplies what is completed', async () => {
    const h = harness()
    h.advance(10)
    await h.progress.pump()
    h.advance(2)
    h.engine.report('ticket-1', { state: 'progress', summary: 'Ran the failing test. Now fixing the parser. Next: push the fix. Blocker: none.' })
    h.advance(7)
    await h.progress.pump()
    expect(h.sent).toHaveLength(1)
    h.advance(1)
    await h.progress.pump()
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1]!.text).toContain('Ran the failing test.')
    expect(h.sent[1]!.text).toContain('20 min in')
  })
  it('sends no update once the ticket ends with its result', async () => {
    const h = harness()
    h.advance(10)
    await h.progress.pump()
    h.engine.report('ticket-1', { state: 'ready', summary: 'The fix is ready.' })
    expect(h.repo.tickets.get('ticket-1')!.ended).toBeDefined()
    h.advance(30)
    await h.progress.pump()
    expect(h.sent).toHaveLength(1)
  })
  it('reports a queued assignment once, and again when it starts', async () => {
    const h = harness({ assignments: [assignment({ state: 'pending', startedAt: undefined })] })
    h.advance(10)
    await h.progress.pump()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]!.text).toContain('worker slot')
    expect(lastProgress(h)).toMatchObject({ phase: 'queued' })
    h.advance(10)
    await h.progress.pump()
    expect(h.sent).toHaveLength(1)
    h.engine.assignmentStarted('ticket-1', 'a1')
    h.setActivity({ at: h.at(20), kind: 'model' })
    h.advance(10)
    await h.progress.pump()
    expect(h.sent).toHaveLength(2)
    expect(lastProgress(h)).toMatchObject({ phase: 'active' })
  })
  it('reports a stalled assignment once, tells it from active work, and resumes after activity', async () => {
    const h = harness()
    h.setActivity({ at: AT, kind: 'tool', detail: 'npm test' })
    h.advance(31)
    await h.progress.pump()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]!.text).toContain('looks stalled')
    expect(h.sent[0]!.text).toContain('npm test')
    expect(h.sent[0]!.text).toContain('possibly a hung tool call')
    expect(lastProgress(h)).toMatchObject({ phase: 'stalled' })
    // An unchanged stalled state is not repeated every ten minutes.
    h.advance(10)
    await h.progress.pump()
    expect(h.sent).toHaveLength(1)
    // Activity after the stall resumes the active cadence.
    h.setActivity({ at: h.at(41), kind: 'model' })
    h.advance(10)
    await h.progress.pump()
    expect(h.sent).toHaveLength(2)
    expect(lastProgress(h)).toMatchObject({ phase: 'active' })
    h.advance(31)
    await h.progress.pump()
    expect(h.sent).toHaveLength(3)
    expect(h.sent[2]!.text).toContain('looks stalled')
  })
  it('leaves a ticket that waits for a person to its report', async () => {
    const h = harness()
    h.engine.report('ticket-1', { state: 'blocked', summary: 'I need the API key.' })
    h.advance(40)
    await h.progress.pump()
    expect(h.sent).toEqual([])
  })
  it('waits while an earlier progress message has not gone out', async () => {
    const h = harness()
    h.advance(10)
    h.setPending(true)
    await h.progress.pump()
    expect(h.sent).toEqual([])
    h.setPending(false)
    await h.progress.pump()
    expect(h.sent).toHaveLength(1)
  })
  it('continues the interval after a restart without repeating the last update', async () => {
    const h = harness()
    h.advance(10)
    await h.progress.pump()
    const next = h.restart()
    h.advance(5)
    await next.pump()
    expect(h.sent).toHaveLength(1)
    h.advance(5)
    await next.pump()
    expect(h.sent).toHaveLength(2)
  })
  it('keeps a Feishu update within the IM limit even when the worker report is long', async () => {
    const h = harness({ channels: [channel('feishu')] })
    const long = Array.from({ length: 200 }, (_, index) => `detail${index}`).join(' ')
    h.engine.report('ticket-1', { state: 'progress', summary: long })
    h.advance(10)
    await h.progress.pump()
    expect(h.sent).toHaveLength(1)
    expect(wordCount(h.sent[0]!.text)).toBeLessThanOrEqual(100)
    for (const label of ['Completed:', 'Now:', 'Next:', 'Blocker:']) expect(h.sent[0]!.text).toContain(label)
  })
  it('counts a fresh worker report as completed even when it is the only evidence of progress', async () => {
    const h = harness()
    h.engine.report('ticket-1', { state: 'progress', summary: 'Finished the failing test; CI is green.' })
    h.advance(10)
    await h.progress.pump()
    expect(h.sent[0]!.text).toContain('Finished the failing test; CI is green.')
    // A later update without a new report says so instead of repeating the old one as fresh.
    h.advance(10)
    await h.progress.pump()
    expect(h.sent[1]!.text).toContain('no new worker report since')
  })
  it('publishes a stalled update without any recorded activity, with a recovery action', async () => {
    const h = harness()
    h.advance(31)
    await h.progress.pump()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]!.text).toContain('no worker Session event has been recorded')
    expect(h.sent[0]!.text).toContain('check the worker\'s session')
    expect(h.sent[0]!.text).toContain('cause is unknown')
  })
})
