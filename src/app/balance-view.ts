/** Read-only provider balance state the management panel renders; imported by the client, so it carries no host imports. */

/** Warning severity, from the first warning to the most urgent. */
export type BalanceLevel = 'low' | 'recommend' | 'critical'

/** One currency's remaining amount and the threshold of the level it crossed, with both amounts as provider-formatted decimals. */
export interface BalanceWalletView {
  /** Currency code the provider reports, such as `CNY` or `USD`. */
  currency: string
  /** Remaining amount exactly as the provider or account service returned it, or a summed wallet total, to two decimals. */
  remaining: string
  /** Threshold of the crossed level, to two decimals; the first warning threshold while `level` is `ok`. */
  threshold: string
  /** `ok` above the low threshold, otherwise the highest level this wallet crossed. */
  level: 'ok' | BalanceLevel
}

/**
 * What the last balance check found. `low` is the only status the panel warns about; `level` says how urgent it is. The
 * other statuses explain why a warning cannot be produced without turning a missing capability into a false alarm.
 */
export interface BalanceView {
  /** `low` means at least one wallet crossed its low threshold; `error` means no warning was produced and none was known. */
  status: 'disabled' | 'checking' | 'ok' | 'low' | 'unsupported' | 'unconfigured' | 'error'
  /** Highest severity among the low wallets; absent unless `status` is `low`. */
  level?: BalanceLevel
  /** Provider route the main Session runs on, such as `deepseek-official` or `deepseek-account`. */
  provider?: string
  /** Model the main Session runs on, when known. */
  model?: string
  /** Where the amounts came from: the official API-key balance endpoint, or the signed-in Platform wallet. */
  source?: 'api-key' | 'account'
  /** Time of the last successful read, in ISO 8601. Omitted before the first read. */
  checkedAt?: string
  /** Time of the most recent attempt, in ISO 8601; differs from `checkedAt` after a failed check. */
  attemptedAt?: string
  /** Every currency the provider returned that has a configured ladder. */
  wallets: BalanceWalletView[]
  /** Why no warning is available, or a note about the last failed check while a previous low reading is kept. */
  detail?: string
}
