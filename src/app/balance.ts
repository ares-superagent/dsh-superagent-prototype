/** Read-only balance monitoring for the provider the main Session runs on, with severity levels, cooldown and health reporting. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { APP_IDENTITY } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import type { BalanceConfig, BalanceLadder } from '../deployment.ts'
import type { HealthEntry } from '../infra/health.ts'
import type { Settings } from '../policy.ts'
import { health } from '../sources/host.ts'
import type { BalanceLevel, BalanceView, BalanceWalletView } from './balance-view.ts'
import type { Sessions } from './sessions.ts'

/** The official DeepSeek API-key balance endpoint, the only route whose exact remaining balance this monitor reads. */
export const BALANCE_ENDPOINT = 'https://api.deepseek.com/user/balance'
/** Where a person replenishes a DeepSeek API account; the warning names it instead of buying anything itself. */
export const TOP_UP_URL = 'https://platform.deepseek.com/top_up'

/** The dependency seam of {@link BalanceMonitor}; `context` supplies the provider selection, credentials and account services. */
export interface BalanceDeps {
  /** DSH context, read through `get` so the monitor works in a minimal profile without optional services. */
  context: Context
  /** Ladders, interval and cooldown. Read once when the plugin starts. */
  config: BalanceConfig
  /** Main Session id whose current model selection names the provider to check. */
  masterId: string
  /** Current saved settings, for the configured router model. */
  settings(): Settings
  /** Main-Session notice sink; the monitor never sends Channel messages itself. */
  sessions: Pick<Sessions, 'notify'>
  /** Health entry this monitor owns and writes. */
  health: HealthEntry
  /** Lifetime signal; aborting it cancels an in-flight read. */
  lifetime: AbortSignal
  /** Clock override for tests; defaults to `Date.now`. */
  now?: () => number
  /** Fetch override for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch
}

const API_BALANCE = z.object({
  is_available: z.boolean().optional(),
  balance_infos: z.array(z.object({
    currency: z.string().min(1),
    total_balance: z.string().min(1),
    granted_balance: z.string().optional(),
    topped_up_balance: z.string().optional(),
  })).optional(),
})

interface Wallet { currency: string; balance: string }
type AccountBalance = {
  status: 'ready'
  value: readonly Wallet[]
  bonusWallets: readonly Wallet[]
} | { status: 'failed' }

/** The parts of DSH's credential service this monitor reads; a reference resolves to its value or `undefined`. */
interface CredentialsLike { resolve(ref: string): Promise<{ value: string } | undefined> }
/** The parts of DSH's account service this monitor reads; `null` means signed out. */
interface AccountLike { getBalance(client: { version: string; locale: string; timezoneOffsetSeconds: number }): Promise<AccountBalance | null> }
/** The parts of DSH's default-model service this monitor reads; absent in a minimal profile. */
interface DefaultModelLike { currentSelection(): { provider: string; model: string } }

const LEVEL_RANK: Readonly<Record<BalanceLevel, number>> = { low: 1, recommend: 2, critical: 3 }
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** The highest severity any wallet crossed, or `undefined` when every wallet is above its low threshold. */
function highestLevel(wallets: readonly BalanceWalletView[]): BalanceLevel | undefined {
  let highest: BalanceLevel | undefined
  for (const wallet of wallets) {
    if (wallet.level === 'ok') continue
    if (highest === undefined || LEVEL_RANK[wallet.level] > LEVEL_RANK[highest]) highest = wallet.level
  }
  return highest
}

/** The level one amount crossed and that level's threshold; above the low threshold the first warning threshold is kept. */
function crossedLevel(remaining: number, ladder: BalanceLadder): { level: 'ok' | BalanceLevel; threshold: number } {
  if (remaining <= ladder.critical) return { level: 'critical', threshold: ladder.critical }
  if (remaining <= ladder.recommend) return { level: 'recommend', threshold: ladder.recommend }
  if (remaining <= ladder.low) return { level: 'low', threshold: ladder.low }
  return { level: 'ok', threshold: ladder.low }
}

/**
 * Checks the balance of the provider the main Session runs on at startup and on a timer, without a model call.
 * It reads the official DeepSeek API-key endpoint or the signed-in Platform wallet through DSH's account service. A low
 * balance becomes the owned `balance` health entry, a durable main-Session notice, and the panel's warning banner. Each
 * currency's low / top-up-recommended / critical ladder decides the severity. It never logs or exposes the credential,
 * and it does not present a token-usage estimate as a balance.
 */
export class BalanceMonitor {
  private state: BalanceView = { status: 'checking', wallets: [] }
  private timer: ReturnType<typeof setTimeout> | undefined
  private inflight: Promise<void> | undefined
  private stopped = false
  private started = false
  /** Creation time of the last announcement, or `undefined` once a reading recovered above the low threshold. */
  private lastNotifiedAt: number | undefined
  /** Severity of the last announcement, so an escalation bypasses the same-level cooldown. */
  private lastNotifiedLevel: BalanceLevel | undefined
  private readonly now: () => number
  private readonly read: typeof fetch

  constructor(private readonly deps: BalanceDeps) {
    this.now = deps.now ?? Date.now
    this.read = deps.fetch ?? fetch
  }

  /** The latest reading, safe for the panel's state route. */
  view(): BalanceView { return this.state }

  /** Runs the startup check and schedules later ones; a check already running is reused. */
  start(): void {
    if (this.started || this.stopped) return
    this.started = true
    if (!this.deps.config.enabled) {
      this.setView({ status: 'disabled', attemptedAt: new Date(this.now()).toISOString(), wallets: [],
        detail: 'Balance warnings are turned off in the deployment configuration.' })
      return
    }
    void this.tick()
  }

  /** Stops the timer; the Runtime's lifetime signal cancels an in-flight read. Idempotent. */
  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Runs one check now; concurrent callers share it. Tests use this directly instead of starting the timer. */
  check(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.inflight) return this.inflight
    this.inflight = this.run(new Date(this.now()).toISOString()).finally(() => { this.inflight = undefined })
    return this.inflight
  }

  private async tick(): Promise<void> {
    try { await this.check() }
    catch (error) { this.deps.context.logger.warn('dsh-superagent: balance check failed: %s', message(error)) }
    if (this.stopped) return
    const interval = Math.max(1, this.deps.config.intervalMinutes) * 60_000
    const timer = setTimeout(() => { this.timer = undefined; void this.tick() }, interval)
    // A monitoring timer must not keep the process alive by itself.
    ;(timer as { unref?: () => void }).unref?.()
    this.timer = timer
  }

  /** Resolve the provider from the live main Session, then its router role model, then DSH's default selection. */
  private selection(): { provider: string; model: string } | undefined {
    const header = this.deps.context.agents.get(this.deps.masterId as SessionId)?.session.requestHeader()
    if (header) return { provider: header.config.provider, model: header.config.model }
    const role = this.deps.settings().eval.model
    if (role) return { provider: role.provider, model: role.model }
    const fallback = this.deps.context.get('agentDefaultModel') as DefaultModelLike | undefined
    try { return fallback?.currentSelection() } catch { return undefined }
  }

  private async run(attemptedAt: string): Promise<void> {
    if (!this.deps.config.enabled) {
      this.setView({ status: 'disabled', attemptedAt, wallets: [], detail: 'Balance warnings are turned off in the deployment configuration.' })
      return
    }
    const selection = this.selection()
    if (!selection) {
      this.setView({ status: 'unconfigured', attemptedAt, wallets: [],
        detail: 'No main-Session model selection is available yet, so no provider balance can be checked.' })
      return
    }
    if (selection.provider === 'deepseek-official') return this.checkApiKey(selection, attemptedAt)
    if (selection.provider === 'deepseek-account') return this.checkAccount(selection, attemptedAt)
    this.setView({ status: 'unsupported', ...selection, attemptedAt, wallets: [],
      detail: `No read-only balance endpoint is known for provider ${selection.provider}; no warning is produced.` })
  }

  /** Read the exact API-key balance from the official endpoint; the credential value only reaches the request header. */
  private async checkApiKey(selection: { provider: string; model: string }, attemptedAt: string): Promise<void> {
    const credentials = this.deps.context.get('credentials') as CredentialsLike | undefined
    if (!credentials) return this.unconfigured(selection, attemptedAt, 'The credential service is not mounted, so the API key cannot be resolved.')
    let key: string | undefined
    try { key = (await credentials.resolve(this.deps.config.apiKeyEnv))?.value }
    catch (error) { return this.fail(selection, attemptedAt, `The API key could not be resolved: ${message(error)}`) }
    if (!key) return this.unconfigured(selection, attemptedAt, `No credential named ${this.deps.config.apiKeyEnv} is configured.`)

    let response: Response
    try {
      response = await this.read(this.deps.config.endpoint, { method: 'GET', headers: { accept: 'application/json',
        authorization: `Bearer ${key}` }, signal: AbortSignal.any([this.deps.lifetime, AbortSignal.timeout(15_000)]) })
    } catch (error) {
      return this.fail(selection, attemptedAt, `The balance check did not complete: ${message(error)}`)
    }
    if (!response.ok) return this.fail(selection, attemptedAt, `The balance endpoint returned HTTP ${response.status}.`)
    let body: unknown
    try { body = await response.json() } catch { return this.fail(selection, attemptedAt, 'The balance endpoint did not return JSON.') }
    const parsed = API_BALANCE.safeParse(body)
    if (!parsed.success) return this.fail(selection, attemptedAt, 'The balance endpoint returned an unexpected body.')

    const wallets: BalanceWalletView[] = []
    const unknown: string[] = []
    for (const info of parsed.data.balance_infos ?? []) {
      const ladder = this.deps.config.thresholds[info.currency]
      if (ladder === undefined) { unknown.push(info.currency); continue }
      const remaining = Number(info.total_balance)
      if (!Number.isFinite(remaining)) return this.fail(selection, attemptedAt, `The balance endpoint returned an invalid amount for ${info.currency}.`)
      const crossed = crossedLevel(remaining, ladder)
      wallets.push({ currency: info.currency, remaining: info.total_balance, threshold: crossed.threshold.toFixed(2), level: crossed.level })
    }
    const unavailable = parsed.data.is_available === false
    if (unavailable && !wallets.length) {
      this.setView({ status: 'low', level: 'critical', ...selection, source: 'api-key', checkedAt: attemptedAt, attemptedAt, wallets: [],
        detail: 'The provider reports the account has no available balance.' })
      return
    }
    if (!wallets.length) {
      return this.unconfigured(selection, attemptedAt, unknown.length
        ? `No thresholds are configured for the balance currencies: ${unknown.join(', ')}. Add balance.thresholds.<currency> to enable warnings.`
        : 'The balance endpoint returned no balance information.')
    }
    const level = unavailable ? 'critical' : highestLevel(wallets)
    this.setView({ status: level === undefined ? 'ok' : 'low', ...level === undefined ? {} : { level }, ...selection, source: 'api-key',
      checkedAt: attemptedAt, attemptedAt, wallets, ...unknown.length ? { detail: `No thresholds are configured for ${unknown.join(', ')}; those wallets are not checked.` } : {} })
  }

  /** Read the signed-in Platform wallet, keeping recharge and bonus balances distinct on the wire and summed for the warning. */
  private async checkAccount(selection: { provider: string; model: string }, attemptedAt: string): Promise<void> {
    const account = this.deps.context.get('deepseekAccount') as AccountLike | undefined
    if (!account) return this.unconfigured(selection, attemptedAt, 'The signed-in account service is not mounted.')
    let balance: AccountBalance | null
    try {
      balance = await account.getBalance({ version: APP_IDENTITY.version, locale: 'en',
        timezoneOffsetSeconds: -new Date(this.now()).getTimezoneOffset() * 60 })
    } catch (error) { return this.fail(selection, attemptedAt, `The account balance could not be read: ${message(error)}`) }
    if (!balance) return this.unconfigured(selection, attemptedAt, 'No DeepSeek account is signed in.')
    if (balance.status !== 'ready') return this.fail(selection, attemptedAt, 'The DeepSeek Platform did not return the wallet balance.')

    const totals = new Map<string, number>()
    for (const wallet of [...balance.value, ...balance.bonusWallets]) {
      totals.set(wallet.currency, (totals.get(wallet.currency) ?? 0) + Number(wallet.balance))
    }
    const wallets: BalanceWalletView[] = []
    const unknown: string[] = []
    for (const [currency, total] of totals) {
      const ladder = this.deps.config.thresholds[currency]
      if (ladder === undefined) { unknown.push(currency); continue }
      if (!Number.isFinite(total)) return this.fail(selection, attemptedAt, `The account returned an invalid amount for ${currency}.`)
      const crossed = crossedLevel(total, ladder)
      wallets.push({ currency, remaining: total.toFixed(2), threshold: crossed.threshold.toFixed(2), level: crossed.level })
    }
    if (!wallets.length) {
      return this.unconfigured(selection, attemptedAt, unknown.length
        ? `No thresholds are configured for the account currencies: ${unknown.join(', ')}. Add balance.thresholds.<currency> to enable warnings.`
        : 'The account returned no wallet balance.')
    }
    const level = highestLevel(wallets)
    this.setView({ status: level === undefined ? 'ok' : 'low', ...level === undefined ? {} : { level }, ...selection, source: 'account',
      checkedAt: attemptedAt, attemptedAt, wallets, ...unknown.length ? { detail: `No thresholds are configured for ${unknown.join(', ')}; those wallets are not checked.` } : {} })
  }

  private unconfigured(selection: { provider: string; model: string }, attemptedAt: string, detail: string): void {
    this.setView({ status: 'unconfigured', ...selection, attemptedAt, wallets: [], detail })
  }

  /** Keep a previous low reading visible when a later check fails, so a transient network error cannot hide a known low balance. */
  private fail(selection: { provider: string; model: string }, attemptedAt: string, detail: string): void {
    const previous = this.state
    if (previous.status === 'low') {
      this.setView({ ...previous, attemptedAt, detail: `${detail} The last successful check still applies.` })
      return
    }
    this.setView({ status: 'error', ...selection, attemptedAt, wallets: [], detail })
  }

  /** Publish a reading, update the owned health entry, and announce a low balance at most once per cooldown per severity. */
  private setView(view: BalanceView): void {
    this.state = view
    if (view.status === 'low') {
      const level = view.level ?? 'low'
      const code = level === 'critical' ? 'balanceCritical' : level === 'recommend' ? 'balanceRecommend' : 'balanceLow'
      this.deps.health.set({ ...health('error', code, {
        wallets: view.wallets.filter(wallet => wallet.level !== 'ok').map(wallet => `${wallet.currency} ${wallet.remaining} remaining (threshold ${wallet.threshold})`).join('; ')
          || 'no available balance',
        provider: view.provider ?? 'the active provider',
        checkedAt: view.checkedAt ?? view.attemptedAt ?? '',
      }), at: view.checkedAt ?? view.attemptedAt })
      this.announce(view, level)
      return
    }
    this.lastNotifiedAt = undefined
    this.lastNotifiedLevel = undefined
    this.deps.health.set({ state: 'ready', detail: view.detail ?? 'Balance is above the low warning threshold', at: view.attemptedAt })
  }

  /** Enqueue one durable main-Session notice per cooldown; a more severe level is announced immediately instead of waiting. */
  private announce(view: BalanceView, level: BalanceLevel): void {
    const now = this.now()
    const cooldown = Math.max(1, this.deps.config.cooldownMinutes) * 60_000
    const escalated = this.lastNotifiedLevel !== undefined && LEVEL_RANK[level] > LEVEL_RANK[this.lastNotifiedLevel]
    if (!escalated && this.lastNotifiedAt !== undefined && now - this.lastNotifiedAt < cooldown) return
    this.lastNotifiedAt = now
    this.lastNotifiedLevel = level
    const low = view.wallets.filter(wallet => wallet.level !== 'ok')
    const wallets = low.map(wallet => `${wallet.currency} ${wallet.remaining} (threshold ${wallet.threshold})`).join(', ')
    const action = level === 'critical' ? 'API balance is critical; top up the account now.'
      : level === 'recommend' ? 'API balance is low; top up the account soon.'
      : 'API balance is low; plan to top up the account.'
    const title = level === 'critical' ? 'API balance critical' : level === 'recommend' ? 'API balance low (top-up recommended)' : 'API balance low'
    const summary = `${title} for ${view.provider}: ${wallets || 'no available balance'}; ${action}`
    this.deps.sessions.notify('balance', {
      balance_low: { level, provider: view.provider, model: view.model, source: view.source, checked_at: view.checkedAt,
        ...low.length ? { wallets: low.map(({ currency, remaining, threshold, level: walletLevel }) => ({ currency, remaining, threshold, level: walletLevel })) } : {},
        ...view.detail ? { detail: view.detail } : {} },
      action,
      top_up: TOP_UP_URL,
    }, summary)
    this.deps.context.logger.warn('dsh-superagent: %s', summary)
  }
}
