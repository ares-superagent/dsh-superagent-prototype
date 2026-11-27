/**
 * Deterministic classification of a worker tool failure that needs a person: an access, credential or permission error is
 * reported in fixed words, a routine failure the worker can recover from is not, and raw tool output is never published.
 */
import { describe, expect, it } from 'vitest'
import { accessFailure } from '../src/infra/tool-failure.ts'

describe('tool failure classification', () => {
  it('classifies an authentication failure and names the tool', () => {
    const signal = accessFailure({ tool: 'gh', error: { name: 'CommandError', code: 'AUTH', reason: 'gh auth login required' } })
    expect(signal).toMatchObject({ category: 'authentication', tool: 'gh' })
    expect(signal!.reason).toContain('authentication or credential failure')
    expect(signal!.action).toContain('sign in or provide the missing credential')
    expect(signal!.reason).toContain('`AUTH`')
  })
  it('reads an HTTP 401 or a credential phrase in the result text', () => {
    expect(accessFailure({ tool: 'bash', text: 'fatal: Authentication failed for https://github.com/acme/widgets' }))
      .toMatchObject({ category: 'authentication' })
    expect(accessFailure({ tool: 'bash', text: 'Request failed: 401 Unauthorized' }))
      .toMatchObject({ category: 'authentication' })
  })
  it('classifies a permission failure without treating a local file-mode error as blocking', () => {
    expect(accessFailure({ tool: 'bash', text: 'remote: Permission denied (publickey) for git@github.com' }))
      .toMatchObject({ category: 'permission' })
    expect(accessFailure({ tool: 'bash', text: 'API error 403 Forbidden: insufficient scope' }))
      .toMatchObject({ category: 'permission' })
    expect(accessFailure({ tool: 'bash', text: "EACCES: permission denied, open '/tmp/notes.txt'" })).toBeUndefined()
  })
  it('leaves a routine failure the worker can recover from unclassified', () => {
    expect(accessFailure({ tool: 'bash', text: 'ENOENT: no such file or directory' })).toBeUndefined()
    expect(accessFailure({ tool: 'bash', text: '1 test failed: expected 2 to be 3', error: { name: 'ToolError', code: 'TOOL_ERROR' } })).toBeUndefined()
  })
  it('publishes fixed words, never the raw tool output or an unsafe tool name', () => {
    const signal = accessFailure({ tool: 'bad name with spaces', text: 'bad credentials SECRET-TOKEN-VALUE' })
    expect(signal).toMatchObject({ category: 'authentication' })
    expect(signal!.tool).toBeUndefined()
    expect(signal!.reason).not.toContain('SECRET')
    expect(signal!.reason).not.toContain('TOKEN-VALUE')
    expect(signal!.action).not.toContain('SECRET')
  })
})
