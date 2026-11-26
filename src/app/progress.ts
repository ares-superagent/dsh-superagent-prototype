/**
 * The runtime's progress cadence: publishes a concise update of every running Assignment to the conversation its Ticket
 * started in, about every ten minutes, from stored task state and the worker Session's last activity.
 *
 * It reads what the Engine and the Executor already recorded, so it never asks a model for anything and needs no tool call.
 * A Worker's latest `progress` report supplies what is complete; the rest — what runs now, the next action and any blocker —
 * comes from the Assignment's stage and the last Session event, which also tells a stalled worker from one waiting on a tool.
 */
import { latestAssignment, ticketStage } from '../core/index.ts'
import type { Assignment, ProgressPhase, ProgressUpdate, Ticket } from '../core/index.ts'
import type { HealthEntry } from '../infra/health.ts'
import { wordCount } from '../infra/text.ts'

/** The interval between progress updates, as the operator approved it. */
export const PROGRESS_INTERVAL_MS = 10 * 60_000
/** How long without a recorded worker Session event before an Assignment looks stalled rather than active. */
export const STALLED_AFTER_MS = 30 * 60_000
/** How often the cadence looks for a due update; an update itself is due only at the interval above. */
const CHECK_MS = 60_000
const MINUTE_MS = 60_000
/** A hard ceiling below the IM limit, so a progress update can go to every Channel kind the cadence serves. */
const MAX_WORDS = 95
/** How much of a worker's report the update carries, leaving room for the runtime's own lines. */
const SUMMARY_WORDS = 50

/** What a worker's Session last did, as its Executor reports it, for telling active work from waiting on a tool or the model. */
export interface ProgressActivity { at: string; kind: 'model' | 'tool' | 'background'; detail?: string }
/** What the cadence reads and writes: open Tickets, the Engine, the Executor's activity, and the outbox. */
export interface ProgressHost {
  /** The open Tickets, whose latest Assignment the cadence considers. */
  tickets(): Ticket[]
  /** Hands one update to the Engine, which resolves the conversation and records it on the Assignment. */
  publish(ticketId: string, update: ProgressUpdate): void
  /** What the ticket's worker Session last did; undefined while its Assignment has not started. */
  activity(ticketId: string): ProgressActivity | undefined
  /** Whether an earlier progress message for the ticket has not gone out yet; another would only queue behind it. */
  pending(ticketId: string): boolean
  now(): string
  paused(): boolean
  closing(): boolean
  health: HealthEntry
}
/** Timing overrides for tests; production always uses the approved ten-minute cadence. */
export interface ProgressOptions { intervalMs?: number; stalledAfterMs?: number; checkMs?: number }
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
/** Formats a timestamp as its UTC hour and minute, which is stable across deployments. */
const clock = (value: string | number): string => {
  const time = typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(time) ? `${new Date(time).toISOString().slice(11, 16)} UTC` : String(value)
}
const minutes = (from: number, to: number): number => Math.max(1, Math.round((to - from) / MINUTE_MS))
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()
/** Clips `text` to at most `max` words (Chinese uses word segmentation), marking the cut with an ellipsis. */
function fitWords(text: string, max: number): string {
  if (wordCount(text) <= max) return text
  let kept = '', count = 0
  for (const part of segmenter.segment(text)) {
    if (part.isWordLike) {
      if (count >= max) break
      count++
    }
    kept += part.segment
  }
  return `${kept.trimEnd()}…`
}
/** Names what the Executor last saw the worker do, as the update tells it to a person. */
function doing(activity: ProgressActivity): string {
  if (activity.kind === 'model') return 'waiting for or processing the model\'s next step'
  if (activity.kind === 'background') return 'its shell jobs or subagents are still running'
  return `running a tool call${activity.detail ? ` (\`${activity.detail}\`)` : ''}`
}
/** Names what the last activity was when it is too old to be active, without claiming the work goes on. */
function lastSeen(activity: ProgressActivity): string {
  if (activity.kind === 'model') return 'a model step'
  if (activity.kind === 'background') return 'shell jobs or subagents'
  return activity.detail ? `a tool call (\`${activity.detail}\`)` : 'a tool call'
}

/**
 * Runs the ten-minute progress cadence for the open Tickets with a live Assignment. Updates go out while a Ticket is
 * `working`: its first ten minutes after the Assignment started, then ten minutes after every update it published. A
 * `queued` or `stalled` state is published once, until it changes, so a long wait does not repeat the same message; a
 * restart reads the Assignment's `progress` note and continues where the previous process stopped without a duplicate.
 */
export class Progress {
  private timer?: ReturnType<typeof setInterval>
  private running?: Promise<void>
  private readonly intervalMs: number
  private readonly stalledAfterMs: number
  private readonly checkMs: number
  constructor(private readonly host: ProgressHost, options: ProgressOptions = {}) {
    this.intervalMs = options.intervalMs ?? PROGRESS_INTERVAL_MS
    this.stalledAfterMs = options.stalledAfterMs ?? STALLED_AFTER_MS
    this.checkMs = options.checkMs ?? CHECK_MS
  }
  /** Starts the minute check that publishes whichever update is due; safe to call once. */
  start(): void {
    this.timer ??= setInterval(() => { void this.pump() }, this.checkMs)
    this.timer.unref?.()
  }
  /** Stops the check; a publish already running finishes. */
  stop(): void { clearInterval(this.timer); this.timer = undefined }
  /** Runs one cadence check, coalescing calls that overlap; a failure leaves a health entry for the overview. */
  pump(): Promise<void> {
    this.running ??= Promise.resolve().then(() => { this.check() }).catch((error: unknown) => {
      this.host.health.set({ state: 'error', detail: `Progress updates failed: ${String(error)}`, at: this.host.now() })
    }).finally(() => { this.running = undefined })
    return this.running
  }
  private check(): void {
    if (this.host.closing() || this.host.paused()) return
    let failed = false
    for (const ticket of this.host.tickets()) {
      try { this.consider(ticket) } catch (error) {
        failed = true
        this.host.health.set({ state: 'error', detail: `A progress update failed: ${String(error)}`, at: this.host.now() })
      }
    }
    if (!failed && this.host.health.get()?.state === 'error') {
      this.host.health.set({ state: 'ready', detail: 'Progress updates are being published', at: this.host.now() })
    }
  }
  /** Publishes one Ticket's due update, if it has one; anything that stops it from being active leaves it to the next check. */
  private consider(ticket: Ticket): void {
    const assignment = latestAssignment(ticket)
    // A result, a question for a person, a blocker, a failed delivery or an idle worker is reported by the report itself.
    if (!assignment || assignment.state === 'ended' || ticketStage(ticket).stage !== 'working') return
    const at = Date.parse(this.host.now())
    const started = Date.parse(assignment.startedAt ?? assignment.createdAt)
    if (!Number.isFinite(at) || !Number.isFinite(started)) return
    const last = assignment.progress
    const anchor = Math.max(last ? Date.parse(last.at) : 0, started)
    if (at - anchor < this.intervalMs) return
    // A message that has not gone out yet will carry the previous update; another would only queue behind it.
    if (this.host.pending(ticket.id)) return
    const activity = assignment.state === 'running' ? this.host.activity(ticket.id) : undefined
    const phase = this.phase(assignment, activity, at)
    // Repeating a queued or stalled state every ten minutes is noise: report it once, and again when it changes.
    if (last && last.phase === phase && phase !== 'active') return
    this.host.publish(ticket.id, { text: this.text(assignment, activity, phase, at), at: this.host.now(),
      due: new Date(anchor + this.intervalMs).toISOString(), phase })
  }
  /** What the update says the worker is doing: queued for a slot, stalled, or active. */
  private phase(assignment: Assignment, activity: ProgressActivity | undefined, at: number): ProgressPhase {
    if (assignment.state === 'pending') return 'queued'
    const since = activity ? Date.parse(activity.at) : Date.parse(assignment.startedAt ?? assignment.createdAt)
    return Number.isFinite(since) && at - since > this.stalledAfterMs ? 'stalled' : 'active'
  }
  /** Builds the four-part update: what is complete, what runs now, the next action and any blocker. */
  private text(assignment: Assignment, activity: ProgressActivity | undefined, phase: ProgressPhase, at: number): string {
    const started = Date.parse(assignment.startedAt ?? assignment.createdAt)
    const published = assignment.progress?.at
    const report = assignment.report?.state === 'progress' && (!published || assignment.report.at > published) ? assignment.report : undefined
    const completed = report ? fitWords(oneLine(report.summary), SUMMARY_WORDS)
      : published ? `no new worker report since ${clock(published)}.` : 'no worker report yet.'
    let now: string, next: string, blocker: string
    if (phase === 'queued') {
      now = 'waiting for a free worker slot; the assignment has not started.'
      next = 'it starts as soon as a worker slot frees.'
      blocker = 'a worker slot is not free yet.'
    } else if (phase === 'stalled') {
      const since = activity ? Date.parse(activity.at) : started
      const looks = activity
        ? `the last recorded activity was ${lastSeen(activity)} ${minutes(since, at)} min ago, with nothing since, so the assignment looks stalled`
        : `no worker Session event has been recorded for ${minutes(started, at)} min, so the assignment looks stalled`
      now = looks
      next = 'check the worker\'s session, then ask for its status, or retry the ticket if it cannot continue.'
      blocker = activity?.kind === 'model' ? 'possibly a hung model call; the runtime cannot tell which.'
        : activity?.kind === 'tool' ? 'possibly a hung tool call; the runtime cannot tell which.' : 'the cause is unknown to the runtime.'
    } else {
      now = activity ? doing(activity) : 'the worker Session has started and has not recorded an event yet.'
      next = 'the worker reports at its next milestone; no action is needed.'
      blocker = 'none reported.'
    }
    const header = `**Progress update** — ${minutes(started, at)} min in (started ${clock(started)}).`
    return fitWords([header, `- Completed: ${completed}`, `- Now: ${now}`, `- Next: ${next}`, `- Blocker: ${blocker}`].join('\n'), MAX_WORDS)
  }
}
