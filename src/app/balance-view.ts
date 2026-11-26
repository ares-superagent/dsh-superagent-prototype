/** Read-only provider balance state the management panel renders; imported by the client, so it carries no host imports. */

/** One currency's remaining amount and the configured warning threshold, with both amounts as provider-formatted decimals. */
export interface BalanceWalletView {
  /** Currency code the provider reports, such as `CNY` or `USD`. */
  currency: string
  /** Remaining amount exactly as the provider or account service returned it, or a summed wallet total, to two decimals. */
  remaining: string
  /** Configured absolute low-balance threshold for this currency, to two decimals. */
  threshold: string
  /** Whether `remaining` is at or below `threshold`. */
  low: boolean
}

/**
 * What the last balance check found. `low` is the only state the panel warns about; the others explain why a warning
 * cannot be produced without turning a missing capability into a false alarm.
 */
export interface BalanceView {
  /** `low` means at least one wallet is at or below its threshold; `error` means no warning was produced and none was known. */
  status: 'disabled' | 'checking' | 'ok' | 'low' | 'unsupported' | 'unconfigured' | 'error'
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
  /** Every currency the provider returned that has a configured threshold. */
  wallets: BalanceWalletView[]
  /** Why no warning is available, or a note about the last failed check while a previous low reading is kept. */
  detail?: string
}
