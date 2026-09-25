import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

const graphqlRequest = vi.hoisted(() => vi.fn())
const password = vi.hoisted(() => vi.fn())
const readStdin = vi.hoisted(() => vi.fn())
const chmodSync = vi.hoisted(() => vi.fn())
const mkdirSync = vi.hoisted(() => vi.fn())
const writeFileSync = vi.hoisted(() => vi.fn())
const errors = vi.hoisted(() => {
  class AuthenticationError extends Error {}
  class GantryApiError extends Error {
    constructor(
      message: string,
      readonly errors?: unknown[],
      readonly statusCode?: number
    ) {
      super(message)
    }
  }
  return { AuthenticationError, GantryApiError }
})

vi.mock('fs', () => ({ chmodSync, mkdirSync, writeFileSync }))
vi.mock('@inquirer/prompts', () => ({ password }))
vi.mock('../lib/client', () => ({ ...errors, graphqlRequest }))
vi.mock('../lib/config', () => ({ credentialsPath: () => '/home/test/.gantry/credentials' }))
vi.mock('../lib/stdin', () => ({ readStdin }))

const { registerLoginCommand } = await import('./login')

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

const IDENTITY = {
  whoami: { teamIds: ['t1'], kind: 'personal', tokenName: 'laptop', authenticated: true },
}

async function run(args: string[]): Promise<void> {
  const program = new Command()
  registerLoginCommand(program)
  await program.parseAsync(['node', 'gantry', 'login', ...args])
}

describe('login command', () => {
  let errorSpy: MockInstance
  let logSpy: MockInstance

  beforeEach(() => {
    vi.clearAllMocks()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitError(typeof code === 'number' ? code : undefined)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function printedErrors(): string {
    return errorSpy.mock.calls.map((call) => String(call[0])).join('\n')
  }

  function printedOutput(): string {
    return logSpy.mock.calls.map((call) => String(call[0])).join('\n')
  }

  it('--token-stdin reads the token from stdin and trims the trailing newline', async () => {
    readStdin.mockResolvedValueOnce('gpat_fromstdin\n')
    graphqlRequest.mockResolvedValueOnce(IDENTITY)

    await run(['--token-stdin'])

    expect(password).not.toHaveBeenCalled()
    expect(graphqlRequest).toHaveBeenCalledWith(expect.any(String), {}, { token: 'gpat_fromstdin' })
    expect(writeFileSync.mock.calls[0]?.[1]).toBe('{\n  "token": "gpat_fromstdin"\n}\n')
  })

  it('--token-stdin with empty input fails without saving', async () => {
    readStdin.mockResolvedValueOnce('\n')

    await expect(run(['--token-stdin'])).rejects.toThrow(ExitError)

    expect(errorSpy).toHaveBeenCalledWith('\x1b[31mError:\x1b[0m No token given.')
    expect(graphqlRequest).not.toHaveBeenCalled()
    expect(writeFileSync).not.toHaveBeenCalled()
  })

  it('refuses --token together with --token-stdin', async () => {
    await expect(run(['--token', 'gpat_x', '--token-stdin'])).rejects.toThrow(ExitError)

    expect(printedErrors()).toContain('Pass either --token or --token-stdin, not both.')
    expect(readStdin).not.toHaveBeenCalled()
    expect(graphqlRequest).not.toHaveBeenCalled()
  })

  it('keeps the masked prompt as the default', async () => {
    password.mockResolvedValueOnce(' gpat_prompted ')
    graphqlRequest.mockResolvedValueOnce(IDENTITY)

    await run([])

    expect(password).toHaveBeenCalledWith(expect.objectContaining({ mask: true }))
    expect(readStdin).not.toHaveBeenCalled()
    expect(graphqlRequest).toHaveBeenCalledWith(expect.any(String), {}, { token: 'gpat_prompted' })
  })

  it('still accepts --token', async () => {
    graphqlRequest.mockResolvedValueOnce(IDENTITY)

    await run(['--token', 'gpat_flag'])

    expect(graphqlRequest).toHaveBeenCalledWith(expect.any(String), {}, { token: 'gpat_flag' })
  })

  it('creates ~/.gantry as 0700 and writes the credentials file as 0600', async () => {
    graphqlRequest.mockResolvedValueOnce(IDENTITY)

    await run(['--token', 'gpat_flag'])

    expect(mkdirSync).toHaveBeenCalledWith('/home/test/.gantry', { recursive: true, mode: 0o700 })
    expect(chmodSync).toHaveBeenCalledWith('/home/test/.gantry', 0o700)
    expect(writeFileSync).toHaveBeenCalledWith(
      '/home/test/.gantry/credentials',
      expect.any(String),
      { mode: 0o600 }
    )
    expect(chmodSync).toHaveBeenCalledWith('/home/test/.gantry/credentials', 0o600)
  })

  it('reports a single-team sign-in without the --team hint', async () => {
    graphqlRequest.mockResolvedValueOnce(IDENTITY)

    await run(['--token', 'gpat_flag'])

    expect(printedOutput()).toContain('Signed in as laptop (personal token, 1 team)')
    expect(printedOutput()).not.toContain('--team')
  })

  it('points a multi-team token at --team', async () => {
    graphqlRequest.mockResolvedValueOnce({
      whoami: { teamIds: ['t1', 't2'], kind: 'personal', tokenName: 'ci', authenticated: true },
    })

    await run(['--token', 'gpat_flag'])

    expect(printedOutput()).toContain('Signed in as ci (personal token, 2 teams)')
    expect(printedOutput()).toContain('Pass --team')
  })

  it.each([
    ['an AuthenticationError', new errors.AuthenticationError('Invalid or expired API token.')],
    ['an HTTP 401 with GraphQL errors', new errors.GantryApiError('x', [], 401)],
    ['an HTTP 403 with GraphQL errors', new errors.GantryApiError('x', [], 403)],
  ])('says the token was not accepted on %s', async (_label, error) => {
    graphqlRequest.mockRejectedValueOnce(error)

    await expect(run(['--token', 'gpat_bad'])).rejects.toThrow(ExitError)

    expect(errorSpy).toHaveBeenCalledWith('\x1b[31mError:\x1b[0m That token was not accepted.')
    expect(writeFileSync).not.toHaveBeenCalled()
  })

  it.each([
    ['a network failure', new Error('getaddrinfo ENOTFOUND api.internal.example')],
    [
      'a server error',
      new errors.GantryApiError('Gantry API error (HTTP 500): stack at db.ts:1', [], 500),
    ],
    ['an invalid API URL', new Error('GANTRY_API_URL must use https.')],
  ])('says the API could not be reached on %s, without internals', async (_label, error) => {
    graphqlRequest.mockRejectedValueOnce(error)

    await expect(run(['--token', 'gpat_x'])).rejects.toThrow(ExitError)

    expect(errorSpy).toHaveBeenCalledWith(
      '\x1b[31mError:\x1b[0m Could not reach the Gantry API to verify the token.'
    )
    expect(printedErrors()).not.toContain(error.message)
    expect(writeFileSync).not.toHaveBeenCalled()
  })

  it('reports a generic error when the credentials file cannot be written', async () => {
    graphqlRequest.mockResolvedValueOnce(IDENTITY)
    writeFileSync.mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied, open /home/test/.gantry/credentials')
    })

    await expect(run(['--token', 'gpat_flag'])).rejects.toThrow(ExitError)

    expect(errorSpy).toHaveBeenCalledWith(
      '\x1b[31mError:\x1b[0m Could not write the credentials file.'
    )
    expect(printedErrors()).not.toContain('EACCES')
  })
})
