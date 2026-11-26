/** The Engine's messages to Channels, each by the rule that allows it. */
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import { latestAssignment, liveTicket, ticketOutcome } from './model.ts'
import type { ChannelRef, ProgressPhase, Ticket, Trigger } from './model.ts'
import type { ReplyStatus } from './ports.ts'
import { EnginePart } from './part.ts'

/** The line every message posted on GitHub must begin with, which a runtime-written progress update adds itself. */
const GITHUB_NOTE = 'This is by an automated agent, not a human.'

/**
 * A message for a Channel, by purpose: an Executor's acknowledgement of a person's request it works on, the answer to a
 * person's question once the worker reported it, the result of a ticket that is `ready`, `completed`, `merged`, or `dropped`,
 * the ticket's current `question` for a person (`attention`), or a runtime progress update (`progress`) from the cadence in
 * `src/app/progress.ts`. When `ticketId` is omitted, the ticket that `triggerId` reached is used.
 */
export type ReplyRequest =
  | { purpose: 'acknowledgement'; ticketId: string; triggerId: string; text: string }
  | { purpose: 'answer' | 'result' | 'attention'; ticketId?: string; triggerId?: string; question?: string; text: string }
  | ProgressRequest
/** A runtime progress update: its text, when it is queued, which due time keeps it idempotent, and what it says about the worker. */
export interface ProgressRequest { purpose: 'progress'; ticketId: string; text: string; at: string; due: string; phase: ProgressPhase }
/** A queued message: its id, whether it went out, and whether an earlier request had queued it already. */
export interface Reply { id: string; status: ReplyStatus; reused: boolean }

/**
 * Replies writes the Engine's messages to Channels through the Outbox port: an acknowledgement, the answer to a person's
 * question, a ticket's result, and its question for a person, each only when its rule allows it, under a deterministic id
 * that keeps it from going out twice (idempotent). The Engine routes `reply` here; Tickets asks it for the acknowledgement
 * an accept carries, and Assignments asks it to withdraw a question a report replaced.
 */
export class Replies extends EnginePart {
  /**
   * Queue a message for the Channel its purpose names: an acknowledgement or an answer goes where that person's message was
   * written, attention where the message that raised the question was (or to the ticket's starting conversation), and a
   * result to the conversation where the ticket started (`result` is allowed only for a ticket in `ready`, `completed`,
   * `merged`, or `dropped`). Each message is queued at most once (idempotent). An acknowledgement, even one already queued,
   * records that the ticket's worker took the message up.
   * @throws UserError when the ticket or trigger is unknown or the purpose's rule refuses it, such as a result of a ticket
   * that is not ready, completed, merged, or dropped.
   */
  reply(request: ReplyRequest): Reply {
    return request.purpose === 'acknowledgement' ? this.acknowledge(request)
      : request.purpose === 'progress' ? this.progress(request) : this.answer(request)
  }
  /**
   * Queue a progress update in the conversation the ticket started in, from the runtime's cadence: only while one of its
   * Assignments runs, at most once for `due` (a deterministic id), and with the automated-agent line on GitHub. The
   * Assignment records when it was published and what it said, so the next update is ten minutes later also after a restart.
   * A ticket with no Channel, or one that ended or no longer runs an Assignment, is skipped silently, since the cadence is
   * best effort and raced by a worker's own reports.
   */
  progress(request: ProgressRequest): Reply {
    const ticket = this.require(request.ticketId)
    // A queued assignment has no worker yet, but a person waiting on it deserves to hear that it is queued.
    const assignment = liveTicket(ticket) ? latestAssignment(ticket) : undefined
    if (!assignment || assignment.state === 'ended') return { id: key('progress', ticket.id, request.due), status: 'dropped', reused: true }
    const id = key('progress', ticket.id, assignment.id, request.due)
    const existing = this.options.outbox.status(id)
    const channel = this.sourceChannel(ticket)
    if (!channel) {
      // Nothing to publish to, such as a ticket accepted from a Source without a Channel: remember the due time, so the cadence does not retry every minute.
      assignment.progress = { at: request.at, phase: request.phase }
      this.repo.tickets.save(ticket)
      return { id, status: 'dropped', reused: existing !== undefined }
    }
    if (!existing) {
      const text = channel.source === 'github' && !request.text.startsWith(GITHUB_NOTE) ? `${GITHUB_NOTE}\n\n${request.text}` : request.text
      this.options.outbox.send({ id, channel, text, kind: 'progress', ticketId: ticket.id })
    }
    assignment.progress = { at: request.at, phase: request.phase }
    this.repo.tickets.save(ticket)
    return { id, status: this.options.outbox.status(id) ?? 'pending', reused: existing !== undefined }
  }
  /**
   * Queue the acknowledgement an accept carries where the message that started the ticket was written, if it has a Channel
   * and a person wrote it.
   */
  acknowledgeAccepted(ticketId: string, trigger: Trigger, text: string): void {
    if (trigger.channel && trigger.human) this.options.outbox.send({ id: key('ack', trigger.id), channel: trigger.channel, text, kind: 'acknowledgement', ticketId })
  }
  /** Withdraw a ticket's question for a person from the outbox, unless it went out already. */
  withdrawAttention(attentionId: string): void { this.options.outbox.withdraw(key('attention-reply', attentionId)) }
  private acknowledge(request: Extract<ReplyRequest, { purpose: 'acknowledgement' }>): Reply {
    const ticket = this.require(request.ticketId)
    if (!liveTicket(ticket)) throw new UserError('ackEnded')
    const trigger = this.repo.triggers.get(request.triggerId)
    if (!trigger) throw new UserError('unknownTrigger')
    // Context-only threads are read-only and cannot receive acknowledgements.
    if (!this.reaches(ticket, trigger, false)) throw new UserError('notReached')
    if (!trigger.channel) throw new UserError('ackNoChannel')
    const id = key('ack', trigger.id)
    const existing = this.options.outbox.status(id)
    if (!existing && !trigger.human) throw new UserError('ackNotPerson')
    // Preserve the automatic or first queued acknowledgement.
    if (!existing) this.options.outbox.send({ id, channel: trigger.channel, text: request.text, kind: 'acknowledgement', ticketId: ticket.id })
    this.takeUp(ticket.id, trigger.id)
    return { id, status: this.options.outbox.status(id) ?? 'pending', reused: existing !== undefined }
  }
  private answer(request: Exclude<ReplyRequest, { purpose: 'acknowledgement' } | { purpose: 'progress' }>): Reply {
    const trigger = request.triggerId ? this.repo.triggers.get(request.triggerId) : undefined
    if (request.triggerId && !trigger) throw new UserError('unknownTrigger')
    const ticket = request.ticketId ? this.require(request.ticketId)
      : trigger ? this.repo.tickets.list().find(item => this.reaches(item, trigger)) : undefined
    if (request.purpose === 'result') {
      const outcome = ticket && ticketOutcome(ticket)
      const reported = !!ticket && liveTicket(ticket) && latestAssignment(ticket)?.report?.state === 'ready'
      const ready = outcome === 'merged' || outcome === 'completed' || outcome === 'dropped' || reported
      if (!ticket || !ready) throw new UserError('notReady')
    }
    const attention = request.purpose === 'attention' ? ticket?.attention : undefined
    // Attention replies must match the ticket's currently open question text.
    if (request.purpose === 'attention' && (!attention || attention.question !== request.question)) throw new UserError('notAttention')
    if (request.purpose === 'answer' && !trigger?.human) throw new UserError('notQuestion')
    const id = attention ? key('attention-reply', attention.id) : key('reply', trigger?.id ?? ticket?.id ?? '', request.text)
    const existing = this.options.outbox.status(id)
    const ready = !ticket || !trigger || ticket.answers?.includes(trigger.id)
    if (request.purpose === 'answer' && !ready && !existing) throw new UserError('noAnswer')
    const asker = attention?.triggerId ? this.repo.triggers.get(attention.triggerId) : undefined
    const channel = request.purpose === 'answer' ? trigger!.channel : asker?.channel ?? (ticket ? this.sourceChannel(ticket) : undefined)
    if (!channel) throw new UserError('noChannel')
    this.options.outbox.send({ id, channel, text: request.text, kind: 'reply', ...ticket ? { ticketId: ticket.id } : {} })
    if (request.purpose === 'answer' && ticket && trigger && ticket.answers?.includes(trigger.id)) {
      ticket.answers = ticket.answers.filter(item => item !== trigger.id)
      this.repo.tickets.save(ticket)
    }
    return { id, status: this.options.outbox.status(id) ?? 'pending', reused: existing !== undefined }
  }
  /** The conversation a ticket started in: its origin Trigger's Channel, else its first Channel. */
  private sourceChannel(ticket: Ticket): ChannelRef | undefined { return this.source(ticket)?.channel ?? ticket.channels[0] }
}
