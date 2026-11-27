/**
 * Deterministic classification of a worker tool failure that needs a person: an authentication, credential or permission
 * error. It reads only the failure identity the Session recorded (the tool, its error name/code/reason and the result text)
 * and returns a fixed category, reason and smallest action, so the runtime never publishes raw tool output that may hold a
 * secret. No model is involved.
 */

/** What a blocked tool failure is about, used as the deterministic alert key. */
export type ToolFailureCategory = 'authentication' | 'permission'
/** A tool failure that needs a person, described in fixed words that are safe to publish. */
export interface ToolFailureSignal {
  category: ToolFailureCategory
  /** The tool the worker was using, when the Session named it and it is a safe short name. */
  tool?: string
  /** A fixed description of the failure, without any raw tool output. */
  reason: string
  /** The smallest action the person must take. */
  action: string
}

/** Authentication, credential and token failures, including the HTTP status an API tool reports. */
const AUTHENTICATION = new RegExp([
  'unauthori[sz]ed', 'not (?:logged|signed) ?in', 'login required', 'not authenticated', 'authentication (?:failed|required|error)',
  'auth(?:entication)? failed', 'bad credentials', 'gh auth login', 'invalid (?:api )?(?:key|token|credential)', 'expired (?:api )?(?:key|token|credential)',
  'missing (?:api )?(?:key|token|credential)', 'no (?:api )?(?:key|token|credential) (?:is )?(?:set|configured|provided)',
  'credentials? (?:are )?(?:missing|not set|not configured|required)', '\\b401\\b',
].join('|'), 'i')

/** Permission failures that name access to a resource rather than an ordinary local file-mode error. */
const PERMISSION = new RegExp([
  'access denied', 'forbidden', 'insufficient (?:permission|privilege|scope)', 'permission denied.*(?:github|git|api|remote|repository|token|key)',
  '\\b403\\b',
].join('|'), 'i')

const SAFE_NAME = /^[A-Za-z0-9_.-]{1,40}$/

/** A tool name as a short safe identifier, or undefined when the Session did not name one. */
const safeTool = (value: string | undefined): string | undefined =>
  value && SAFE_NAME.test(value) ? value : undefined

/** A short safe error code to add to the fixed reason, or nothing. */
const safeCode = (value: string | undefined): string => value && SAFE_NAME.test(value) ? ` (code \`${value}\`)` : ''

/**
 * Classifies a `tool/result` failure that needs a person: its error identity and text decide the category, and the returned
 * signal carries only fixed words. A routine failure the worker can recover from, such as a missing file or a failing test,
 * is not classified and reports nothing.
 */
export function accessFailure(input: { tool?: string; error?: { name?: string; code?: string; reason?: string }; text?: string }): ToolFailureSignal | undefined {
  const tool = safeTool(input.tool)
  const code = safeCode(input.error?.code)
  const words = [input.error?.name, input.error?.code, input.error?.reason, input.text].filter(Boolean).join('\n')
  if (AUTHENTICATION.test(words)) {
    const named = tool ? `the \`${tool}\` tool` : 'a tool call'
    return { category: 'authentication', ...tool ? { tool } : {},
      reason: `${named} reported an authentication or credential failure${code}`,
      action: tool ? `sign in or provide the missing credential for \`${tool}\`, then retry the ticket.`
        : 'sign in or provide the missing credential, then retry the ticket.' }
  }
  if (PERMISSION.test(words)) {
    const named = tool ? `the \`${tool}\` tool` : 'a tool call'
    return { category: 'permission', ...tool ? { tool } : {},
      reason: `${named} reported that access was denied${code}`,
      action: tool ? `grant the agent account access to what \`${tool}\` needs, then retry the ticket.`
        : 'grant the agent account access to the resource, then retry the ticket.' }
  }
  return undefined
}
