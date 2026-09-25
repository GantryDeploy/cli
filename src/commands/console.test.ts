import * as path from 'path'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

const mocks = vi.hoisted(() => ({
  graphqlRequest: vi.fn(),
  loadProjectIdentity: vi.fn(),
  printError: vi.fn(),
  resolveEnvironmentSlug: vi.fn(),
  spinner: { fail: vi.fn(), stop: vi.fn() },
}))

vi.mock('ora', () => ({
  default: () => ({ start: () => mocks.spinner }),
}))
vi.mock('../lib/client', () => ({
  formatApiError: (error: unknown) => (error instanceof Error ? error.message : 'API error'),
  graphqlRequest: mocks.graphqlRequest,
}))
vi.mock('../lib/output', () => ({ printError: mocks.printError }))
vi.mock('../lib/project-identity', () => ({
  loadProjectIdentity: mocks.loadProjectIdentity,
  resolveEnvironmentSlug: mocks.resolveEnvironmentSlug,
}))

const { registerConsoleCommand } = await import('./console')

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

const IDENTITY = { id: 'p9ue62', environments: ['dev', 'production'] }

describe('console command', () => {
  let writeSpy: MockInstance

  async function consoleRun(...args: string[]): Promise<ExitError> {
    const program = new Command().enablePositionalOptions()
    program.exitOverride()
    registerConsoleCommand(program)
    const error: unknown = await program.parseAsync(['node', 'gantry', 'console', ...args]).then(
      () => undefined,
      (caught: unknown) => caught
    )
    if (!(error instanceof ExitError)) throw new Error('expected the command to exit')
    return error
  }

  function succeed(result: Record<string, unknown>) {
    mocks.graphqlRequest.mockResolvedValueOnce({
      runConsoleCommand: { success: true, exitCode: 0, output: '', message: null, ...result },
    })
  }

  beforeEach(() => {
    for (const mock of [
      mocks.graphqlRequest,
      mocks.loadProjectIdentity,
      mocks.printError,
      mocks.resolveEnvironmentSlug,
      mocks.spinner.fail,
      mocks.spinner.stop,
    ]) {
      mock.mockReset()
    }
    mocks.loadProjectIdentity.mockReturnValue(IDENTITY)
    mocks.resolveEnvironmentSlug.mockImplementation((_identity: unknown, requested: string) =>
      requested.toLowerCase()
    )
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitError(typeof code === 'number' ? code : undefined)
    })
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes the remote output byte-for-byte, escape sequences included', async () => {
    const output = '\x1b[32mgreen\x1b[0m \x1b]0;title\x07\x9b2J\r\n'
    succeed({ output })

    const exit = await consoleRun('web', '--', 'plugin', 'list')

    expect(writeSpy).toHaveBeenCalledWith(output)
    expect(writeSpy).toHaveBeenCalledOnce()
    expect(exit.code).toBe(0)
  })

  it('passes the command through verbatim, dropping only the leading separator', async () => {
    succeed({ output: 'ok\n' })

    await consoleRun('web', '--', 'wp', 'option', 'get', 'home', '--format=json', '--', 'x')

    expect(mocks.graphqlRequest.mock.calls[0]?.[1]).toEqual({
      projectId: 'p9ue62',
      environmentSlug: 'dev',
      service: 'web',
      command: ['wp', 'option', 'get', 'home', '--format=json', '--', 'x'],
      variant: 'console',
    })
    expect(mocks.spinner.stop).toHaveBeenCalledOnce()
  })

  it('sends operands given without a separator', async () => {
    succeed({})

    await consoleRun('worker', 'php', 'artisan', 'queue:restart')

    expect(mocks.graphqlRequest.mock.calls[0]?.[1]).toMatchObject({
      service: 'worker',
      command: ['php', 'artisan', 'queue:restart'],
    })
  })

  it('targets the requested environment, variant and working directory', async () => {
    succeed({})

    await consoleRun(
      '--env',
      'Production',
      '--variant',
      'default',
      '--cwd',
      'apps/site',
      'web',
      '--',
      'ls'
    )

    expect(mocks.loadProjectIdentity).toHaveBeenCalledWith(path.resolve('apps/site'))
    expect(mocks.resolveEnvironmentSlug).toHaveBeenCalledWith(IDENTITY, 'Production')
    expect(mocks.graphqlRequest.mock.calls[0]?.[1]).toMatchObject({
      environmentSlug: 'production',
      variant: 'default',
    })
  })

  it('forwards flags after the service to the remote command', async () => {
    succeed({})

    await consoleRun('web', '--env', 'production', 'ls')

    expect(mocks.resolveEnvironmentSlug).toHaveBeenCalledWith(IDENTITY, 'dev')
    expect(mocks.graphqlRequest.mock.calls[0]?.[1]).toMatchObject({
      command: ['--env', 'production', 'ls'],
    })
  })

  it('reads gantry.yml from the current directory by default', async () => {
    succeed({})

    await consoleRun('web', '--', 'ls')

    expect(mocks.loadProjectIdentity).toHaveBeenCalledWith(process.cwd())
    expect(mocks.resolveEnvironmentSlug).toHaveBeenCalledWith(IDENTITY, 'dev')
  })

  it.each([[['web']], [['web', '--']]])('refuses %j without a command', async (args) => {
    const exit = await consoleRun(...args)

    expect(exit.code).toBe(1)
    expect(mocks.printError).toHaveBeenCalledWith(
      'No command provided. Usage: gantry console <service> -- <command...>'
    )
    expect(mocks.graphqlRequest).not.toHaveBeenCalled()
  })

  it('appends a trailing newline when the output lacks one', async () => {
    succeed({ output: 'Success: 3 plugins' })

    await consoleRun('web', '--', 'plugin', 'list')

    expect(writeSpy).toHaveBeenCalledWith('Success: 3 plugins\n')
  })

  it('writes nothing for empty output', async () => {
    succeed({ output: '' })

    await consoleRun('web', '--', 'true')

    expect(writeSpy).not.toHaveBeenCalled()
  })

  it('propagates the remote exit code', async () => {
    succeed({ output: 'Error: no such command\n', exitCode: 2 })

    const exit = await consoleRun('web', '--', 'nope')

    expect(exit.code).toBe(2)
    expect(writeSpy).toHaveBeenCalledWith('Error: no such command\n')
  })

  it('exits with the failure exit code and message', async () => {
    mocks.graphqlRequest.mockResolvedValueOnce({
      runConsoleCommand: {
        success: false,
        exitCode: 124,
        output: '',
        message: 'Console command timed out',
      },
    })

    const exit = await consoleRun('web', '--', 'sleep', '900')

    expect(exit.code).toBe(124)
    expect(mocks.printError).toHaveBeenCalledWith('Console command timed out')
    expect(writeSpy).not.toHaveBeenCalled()
  })

  it('exits 1 with a generic message when a failure has neither', async () => {
    mocks.graphqlRequest.mockResolvedValueOnce({
      runConsoleCommand: { success: false, exitCode: 0, output: '', message: null },
    })

    const exit = await consoleRun('web', '--', 'ls')

    expect(exit.code).toBe(1)
    expect(mocks.printError).toHaveBeenCalledWith(
      'There was an error while running the console command.'
    )
  })

  it('fails the spinner and exits 1 when the API call throws', async () => {
    mocks.graphqlRequest.mockRejectedValueOnce(new Error('Service web has no console variant'))

    const exit = await consoleRun('web', '--', 'ls')

    expect(exit.code).toBe(1)
    expect(mocks.spinner.fail).toHaveBeenCalledWith('Failed to run console command')
    expect(mocks.printError).toHaveBeenCalledWith('Service web has no console variant')
    expect(writeSpy).not.toHaveBeenCalled()
  })
})
