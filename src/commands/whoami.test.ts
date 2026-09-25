import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const graphqlRequest = vi.hoisted(() => vi.fn())

vi.mock('../lib/client', () => ({
  formatApiError: (error: unknown) => (error instanceof Error ? error.message : 'API error'),
  graphqlRequest,
}))

const { registerWhoamiCommand } = await import('./whoami')

describe('whoami command', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('strips control sequences from server fields but keeps its own styling', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    graphqlRequest.mockResolvedValueOnce({
      whoami: {
        teamId: 'p9ue62',
        teamIds: ['p9ue62'],
        kind: 'personal',
        tokenName: 'laptop\x1b]0;owned\x07\x1b[2J',
        authenticated: true,
        isAdmin: false,
        access: [{ resource: 'projects\x9b31m', level: 'write\x1b[1A' }],
      },
    })

    const program = new Command()
    registerWhoamiCommand(program)
    await program.parseAsync(['node', 'gantry', 'whoami'])

    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n')
    expect(output).toContain('Token:           \x1b[36mlaptop\x1b[0m (personal token)')
    expect(output).toContain('    \x1b[36mprojects\x1b[0m: write')
    expect(output).not.toContain('owned')
    expect(output).not.toContain('\x1b[2J')
    expect(output).not.toContain('\x9b')
  })

  async function runWhoami(): Promise<string> {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const program = new Command()
    registerWhoamiCommand(program)
    await program.parseAsync(['node', 'gantry', 'whoami'])
    return logSpy.mock.calls.map((call) => String(call[0])).join('\n')
  }

  it('prints a team token with admin role, teams, the acting team and sorted access', async () => {
    graphqlRequest.mockResolvedValueOnce({
      whoami: {
        teamId: 'nth2lg',
        teamIds: ['nth2lg', '63wqfr'],
        kind: 'team',
        tokenName: 'deploy-bot',
        authenticated: true,
        isAdmin: true,
        access: [
          { resource: 'secrets', level: 'read' },
          { resource: 'clouds', level: 'write' },
        ],
      },
    })

    const output = await runWhoami()

    expect(output).toContain('Token:           \x1b[36mdeploy-bot\x1b[0m (team token)')
    expect(output).toContain('Role:            \x1b[36mAdmin\x1b[0m')
    expect(output).toContain('Teams:           \x1b[36mnth2lg, 63wqfr\x1b[0m')
    expect(output).toContain('Acting on:       \x1b[36mnth2lg\x1b[0m')
    expect(output).toContain('\x1b[1mAccess\x1b[0m (2)')
    expect(output.indexOf('clouds')).toBeLessThan(output.indexOf('secrets'))
  })

  it('shows no teams and asks for --team when none is settled', async () => {
    graphqlRequest.mockResolvedValueOnce({
      whoami: {
        teamId: null,
        teamIds: [],
        kind: 'personal',
        tokenName: 'laptop',
        authenticated: true,
        isAdmin: false,
        access: [],
      },
    })

    const output = await runWhoami()

    expect(output).toContain('Role:            \x1b[36mMember\x1b[0m')
    expect(output).toContain('Teams:           \x1b[36mnone\x1b[0m')
    expect(output).toContain('Acting on:       \x1b[36mnot set (pass --team)\x1b[0m')
    expect(output).toContain('(0)')
  })

  it('reports an API failure and exits non-zero', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    graphqlRequest.mockRejectedValueOnce(new Error('Invalid or expired API token.'))

    await runWhoami()

    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('Invalid or expired API token.')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})
