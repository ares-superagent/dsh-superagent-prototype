/** Read-only provider balance checks: the three-level ladder, cooldown and escalation, provider selection, account wallet, and failures. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { BALANCE_ENDPOINT, BalanceMonitor } from '../src/app/balance.ts'
import type { BalanceConfig } from '../src/deployment.ts'
import type { Settings } from '../src/policy.ts'
import type { Health } from '../src/sources/host.ts'

const USD = { low: 2, recommend: 1, critical: 0.5 }
const config = (overrides: Partial<BalanceConfig> = {}): BalanceConfig => ({ enabled: true, intervalMinutes: 30, cooldownMinutes: 360,
  endpoint: BALANCE_ENDPOINT, apiKeyEnv: 'DEEPSEEK_API_KEY', thresholds: { USD: { ...USD } }, ...overrides })

const settings = (provider?: string, model = 'deepseek-flash') => ({ eval: { model: provider ? { provider, model } : null } }) as unknown as Settings

const apiBody = (total: string, currency = 'USD', available = true) => Response.json({ is_available: available,
  balance_infos: [{ currency, total_balance: total, granted_balance: '0.00', topped_up_balance: total }] })

interface Harness {
  header?: { provider: string; model: string }
  role?: string
  defaultModel?: { provider: string; model: string }
  credential?: string
  account?: { getBalance: (client: unknown) => Promise<unknown> }
  read?: ReturnType<typeof vi.fn>
  now?: () => number
  config?: BalanceConfig
}
function harness(options: Harness = {}) {
  const ctx = new Context()
  ctx.reflect.provide('agents', { get: () => options.header ? { session: { requestHeader: () => ({ config: options.header }) } } : undefined })
  if (options.credential !== undefined) ctx.reflect.provide('credentials', { resolve: async () => ({ value: options.credential }) })
  if (options.account !== undefined) ctx.reflect.provide('deepseekAccount', options.account)
  if (options.defaultModel !== undefined) ctx.reflect.provide('agentDefaultModel', { currentSelection: () => options.defaultModel })
  const notify = vi.fn()
  const writes: Health[] = []
  const health = { get: () => writes.at(-1), set: (value: Health) => { writes.push(value) }, release: vi.fn() }
  const read = options.read ?? vi.fn(async () => apiBody('1.50'))
  const monitor = new BalanceMonitor({ context: ctx, config: options.config ?? config(), masterId: 'master',
    settings: () => settings(options.role), sessions: { notify }, health, lifetime: new AbortController().signal,
    now: options.now ?? (() => 1_700_000_000_000), fetch: read as unknown as typeof fetch })
  return { monitor, notify, health, writes, read }
}

it('classifies the approved USD ladder: $2 low, $1 top-up recommended, $0.50 critical', async () => {
  let amount = '2.01'
  const read = vi.fn(async () => apiBody(amount))
  const h = harness({ header: { provider: 'deepseek-official', model: 'deepseek-flash' }, credential: 'sk-test', read })
  await h.monitor.check()
  expect(h.monitor.view()).toMatchObject({ status: 'ok', wallets: [{ currency: 'USD', remaining: '2.01', threshold: '2.00', level: 'ok' }] })
  expect(h.notify).not.toHaveBeenCalled()

  amount = '2.00'
  await h.monitor.check()
  expect(h.monitor.view()).toMatchObject({ status: 'low', level: 'low',
    wallets: [{ currency: 'USD', remaining: '2.00', threshold: '2.00', level: 'low' }] })
  expect(h.writes.at(-1)).toMatchObject({ state: 'error', code: 'balanceLow' })
  expect(h.notify).toHaveBeenCalledOnce()

  amount = '1.00'
  await h.monitor.check()
  expect(h.monitor.view()).toMatchObject({ status: 'low', level: 'recommend',
    wallets: [{ currency: 'USD', remaining: '1.00', threshold: '1.00', level: 'recommend' }] })
  expect(h.writes.at(-1)).toMatchObject({ state: 'error', code: 'balanceRecommend' })
  expect(h.notify).toHaveBeenCalledTimes(2)

  amount = '0.50'
  await h.monitor.check()
  expect(h.monitor.view()).toMatchObject({ status: 'low', level: 'critical',
    wallets: [{ currency: 'USD', remaining: '0.50', threshold: '0.50', level: 'critical' }] })
  expect(h.writes.at(-1)).toMatchObject({ state: 'error', code: 'balanceCritical' })
  expect(h.notify).toHaveBeenCalledTimes(3)
  expect(JSON.stringify(h.notify.mock.calls.map(([name, value]) => [name, value]))).not.toContain('sk-test')
})

it('escalates immediately, repeats only after the cooldown, and resets after a recovery', async () => {
  let now = 1_700_000_000_000
  let amount = '1.50'
  const read = vi.fn(async () => apiBody(amount))
  const h = harness({ header: { provider: 'deepseek-official', model: 'deepseek-flash' }, credential: 'sk-test', read, now: () => now })
  await h.monitor.check()
  expect(h.monitor.view()).toMatchObject({ status: 'low', level: 'low' })
  expect(h.notify).toHaveBeenCalledOnce()

  now += 60_000; amount = '0.75'
  await h.monitor.check()
  expect(h.monitor.view()).toMatchObject({ status: 'low', level: 'recommend' })
  expect(h.notify).toHaveBeenCalledTimes(2)

  now += 60_000; amount = '0.25'
  await h.monitor.check()
  expect(h.monitor.view()).toMatchObject({ status: 'low', level: 'critical' })
  expect(h.notify).toHaveBeenCalledTimes(3)

  now += 60_000
  await h.monitor.check()
  expect(h.notify).toHaveBeenCalledTimes(3)
  now += 360 * 60_000
  await h.monitor.check()
  expect(h.notify).toHaveBeenCalledTimes(4)

  amount = '5.00'
  await h.monitor.check()
  expect(h.monitor.view()).toMatchObject({ status: 'ok', wallets: [{ level: 'ok' }] })
  amount = '1.50'
  await h.monitor.check()
  expect(h.monitor.view()).toMatchObject({ status: 'low', level: 'low' })
  expect(h.notify).toHaveBeenCalledTimes(5)
})

it('reports a missing credential or an unknown provider without a request or a warning', async () => {
  const missing = harness({ header: { provider: 'deepseek-official', model: 'deepseek-flash' }, credential: '' })
  await missing.monitor.check()
  expect(missing.monitor.view()).toMatchObject({ status: 'unconfigured', provider: 'deepseek-official' })
  expect(missing.monitor.view().detail).toContain('DEEPSEEK_API_KEY')
  expect(missing.read).not.toHaveBeenCalled()
  expect(missing.notify).not.toHaveBeenCalled()

  const other = harness({ header: { provider: 'another-provider', model: 'm' }, credential: 'sk-test' })
  await other.monitor.check()
  expect(other.monitor.view()).toMatchObject({ status: 'unsupported', provider: 'another-provider' })
  expect(other.read).not.toHaveBeenCalled()
  expect(other.notify).not.toHaveBeenCalled()
})

it('keeps the last low reading visible when a later check fails, and never surfaces the key', async () => {
  const read = vi.fn(async () => apiBody('1.50'))
  const h = harness({ header: { provider: 'deepseek-official', model: 'deepseek-flash' }, credential: 'sk-secret-value', read })
  await h.monitor.check()
  read.mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
  await h.monitor.check()
  expect(h.monitor.view()).toMatchObject({ status: 'low', level: 'low', checkedAt: expect.any(String), attemptedAt: expect.any(String) })
  expect(h.monitor.view().detail).toContain('HTTP 401')
  expect(h.monitor.view().detail).toContain('last successful check still applies')
  expect(h.notify).toHaveBeenCalledOnce()
  expect(JSON.stringify(h.monitor.view())).not.toContain('sk-secret-value')
  expect(JSON.stringify(h.writes)).not.toContain('sk-secret-value')
})

it('reports an unexpected body and a malformed amount without a warning', async () => {
  const bad = harness({ header: { provider: 'deepseek-official', model: 'deepseek-flash' }, credential: 'sk-test',
    read: vi.fn(async () => Response.json({ balance_infos: 'no' })) })
  await bad.monitor.check()
  expect(bad.monitor.view()).toMatchObject({ status: 'error', provider: 'deepseek-official' })
  expect(bad.writes.at(-1)).toMatchObject({ state: 'ready' })
  expect(bad.notify).not.toHaveBeenCalled()

  const amount = harness({ header: { provider: 'deepseek-official', model: 'deepseek-flash' }, credential: 'sk-test',
    read: vi.fn(async () => Response.json({ balance_infos: [{ currency: 'USD', total_balance: 'not-a-number' }] })) })
  await amount.monitor.check()
  expect(amount.monitor.view().status).toBe('error')
  expect(amount.monitor.view().detail).toContain('invalid amount')
})

it('reads the signed-in Platform wallets and sums recharge and bonus balances for one currency', async () => {
  const getBalance = vi.fn(async () => ({ status: 'ready', value: [{ currency: 'USD', balance: '0.25' }],
    bonusWallets: [{ currency: 'USD', balance: '0.50' }] }))
  const h = harness({ header: { provider: 'deepseek-account', model: 'deepseek-flash' }, account: { getBalance } })
  await h.monitor.check()
  expect(getBalance).toHaveBeenCalledWith(expect.objectContaining({ locale: 'en', timezoneOffsetSeconds: expect.any(Number) }))
  expect(h.monitor.view()).toMatchObject({ status: 'low', level: 'recommend', source: 'account',
    wallets: [{ currency: 'USD', remaining: '0.75', threshold: '1.00', level: 'recommend' }] })
  expect(h.notify).toHaveBeenCalledOnce()
})

it('checks CNY only when a CNY ladder is explicitly configured', async () => {
  const unconfigured = harness({ header: { provider: 'deepseek-official', model: 'deepseek-flash' }, credential: 'sk-test',
    read: vi.fn(async () => apiBody('15.00', 'CNY')) })
  await unconfigured.monitor.check()
  expect(unconfigured.monitor.view()).toMatchObject({ status: 'unconfigured', wallets: [] })
  expect(unconfigured.monitor.view().detail).toContain('CNY')
  expect(unconfigured.notify).not.toHaveBeenCalled()

  const configured = harness({ header: { provider: 'deepseek-official', model: 'deepseek-flash' }, credential: 'sk-test',
    read: vi.fn(async () => apiBody('15.00', 'CNY')), config: config({ thresholds: { USD: { ...USD },
      CNY: { low: 20, recommend: 10, critical: 5 } } }) })
  await configured.monitor.check()
  expect(configured.monitor.view()).toMatchObject({ status: 'low', level: 'low',
    wallets: [{ currency: 'CNY', remaining: '15.00', threshold: '20.00', level: 'low' }] })
  expect(configured.notify).toHaveBeenCalledOnce()
})

it('names an unknown currency without a ladder instead of guessing one', async () => {
  const h = harness({ header: { provider: 'deepseek-official', model: 'deepseek-flash' }, credential: 'sk-test',
    read: vi.fn(async () => apiBody('1.00', 'EUR')) })
  await h.monitor.check()
  expect(h.monitor.view()).toMatchObject({ status: 'unconfigured', wallets: [] })
  expect(h.monitor.view().detail).toContain('EUR')
  expect(h.notify).not.toHaveBeenCalled()
})

it('treats an unavailable account as critical even when it returns no wallet', async () => {
  const h = harness({ header: { provider: 'deepseek-official', model: 'deepseek-flash' }, credential: 'sk-test',
    read: vi.fn(async () => Response.json({ is_available: false, balance_infos: [] })) })
  await h.monitor.check()
  expect(h.monitor.view()).toMatchObject({ status: 'low', level: 'critical', wallets: [] })
  expect(h.monitor.view().detail).toContain('no available balance')
  expect(h.writes.at(-1)).toMatchObject({ state: 'error', code: 'balanceCritical' })
  expect(h.notify).toHaveBeenCalledOnce()
})

it('falls back from the role model to DSH\'s default selection when the main Session has no request header', async () => {
  const role = harness({ role: 'deepseek-official', credential: 'sk-test' })
  await role.monitor.check()
  expect(role.monitor.view()).toMatchObject({ status: 'low', level: 'low', provider: 'deepseek-official' })

  const fallback = harness({ defaultModel: { provider: 'deepseek-official', model: 'deepseek-flash' }, credential: 'sk-test' })
  await fallback.monitor.check()
  expect(fallback.monitor.view()).toMatchObject({ status: 'low', level: 'low', provider: 'deepseek-official' })
})
