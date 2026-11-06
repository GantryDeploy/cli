import * as path from 'path'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

const mocks = vi.hoisted(() => ({
  graphqlRequest: vi.fn(),
  lambdaClientConfig: vi.fn(),
  lambdaSend: vi.fn(),
  loadProjectIdentity: vi.fn(),
  printError: vi.fn(),
  resolveEnvironmentSlug: vi.fn(),
  sleep: vi.fn(),
  spinner: { fail: vi.fn(), stop: vi.fn() },
}))

vi.mock('ora', () => ({
  default: () => ({ start: () => mocks.spinner }),
}))
vi.mock('timers/promises', () => ({ setTimeout: mocks.sleep }))
vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class {
    constructor(config: unknown) {
      mocks.lambdaClientConfig(config)
    }
    send = mocks.lambdaSend
  },
  InvokeCommand: class {
    constructor(readonly input: unknown) {}
  },
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

const { registerRunCommand } = await import('./run')

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

const IDENTITY = { id: 'p9ue62', environments: ['dev', 'production'] }
const RUN_ID = '0f3a9c1e7b2d4c6a8e5f1d2b3c4a5e6f'
const INVOCATION = {
  region: 'us-east-2',
  functionName: 'storefront-production-web-console',
  qualifier: '12',
  payload: "\"'migrate' '--force'\"",
  credentials: {
    accessKeyId: 'ASIAEXAMPLEKEY',
    secretAccessKey: 'secret-access-key',
    sessionToken: 'session-token',
  },
}

function lambdaResponse(body: unknown, functionError?: string) {
  return {
    FunctionError: functionError,
    Payload: new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

describe('run command', () => {
  let writeSpy: MockInstance

  async function run(...args: string[]): Promise<ExitError> {
    const program = new Command().enablePositionalOptions()
    program.exitOverride()
    registerRunCommand(program)
    const error: unknown = await program.parseAsync(['node', 'gantry', 'run', ...args]).then(
      () => undefined,
      (caught: unknown) => caught
    )
    if (!(error instanceof ExitError)) throw new Error('expected the command to exit')
    return error
  }

  function startsLambda() {
    mocks.graphqlRequest.mockResolvedValueOnce({
      startCommandRun: { success: true, message: null, runId: null, aws: INVOCATION },
    })
  }

  function startsPolledRun() {
    mocks.graphqlRequest.mockResolvedValueOnce({
      startCommandRun: { success: true, message: null, runId: RUN_ID, aws: null },
    })
  }

  function status(fields: Record<string, unknown>) {
    mocks.graphqlRequest.mockResolvedValueOnce({
      commandRun: {
        state: 'running',
        exitCode: null,
        output: '',
        outputCursor: null,
        message: null,
        ...fields,
      },
    })
  }

  function written(): string {
    return writeSpy.mock.calls.map((call) => String(call[0])).join('')
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.graphqlRequest.mockReset()
    mocks.lambdaSend.mockReset()
    mocks.sleep.mockResolvedValue(undefined)
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

  describe('starting a command', () => {
    it('opts out of the idempotency key, so credentials are never stored for replay', async () => {
      startsLambda()
      mocks.lambdaSend.mockResolvedValueOnce(lambdaResponse({ exitCode: 0, output: '' }))

      await run('web', '--', 'migrate')

      expect(mocks.graphqlRequest).toHaveBeenCalledWith(
        expect.stringContaining('startCommandRun'),
        expect.objectContaining({ command: ['migrate'] }),
        { idempotent: false }
      )
    })

    it('passes the command through verbatim, dropping only the leading separator', async () => {
      startsPolledRun()
      status({ state: 'finished', exitCode: 0 })
      status({ state: 'finished', exitCode: 0 })

      await run('web', '--', 'eval', `echo foo("it's");`, '--', '-x')

      expect(mocks.graphqlRequest.mock.calls[0]?.[1]).toMatchObject({
        command: ['eval', `echo foo("it's");`, '--', '-x'],
      })
    })

    it('targets the requested environment, variant and working directory', async () => {
      startsLambda()
      mocks.lambdaSend.mockResolvedValueOnce(lambdaResponse({ exitCode: 0, output: '' }))

      await run('--env', 'Production', '--variant', 'tasks', '--cwd', '/srv/app', 'web', '--', 'ls')

      expect(mocks.loadProjectIdentity).toHaveBeenCalledWith(path.resolve('/srv/app'))
      expect(mocks.graphqlRequest.mock.calls[0]?.[1]).toEqual({
        projectId: 'p9ue62',
        environmentSlug: 'production',
        service: 'web',
        command: ['ls'],
        variant: 'tasks',
      })
    })

    it('sends no variant by default, so the API picks the right one for the service', async () => {
      startsLambda()
      mocks.lambdaSend.mockResolvedValueOnce(lambdaResponse({ exitCode: 0, output: '' }))

      await run('web', '--', 'ls')

      expect(mocks.graphqlRequest.mock.calls[0]?.[1]).toMatchObject({ variant: undefined })
    })

    it('forwards options after the service to the remote command', async () => {
      startsLambda()
      mocks.lambdaSend.mockResolvedValueOnce(lambdaResponse({ exitCode: 0, output: '' }))

      await run('web', '--env', 'production', 'ls')

      expect(mocks.resolveEnvironmentSlug).toHaveBeenCalledWith(IDENTITY, 'dev')
      expect(mocks.graphqlRequest.mock.calls[0]?.[1]).toMatchObject({
        command: ['--env', 'production', 'ls'],
      })
    })

    it.each([[['web']], [['web', '--']]])('refuses %j without a command', async (args) => {
      const exit = await run(...args)

      expect(exit.code).toBe(1)
      expect(mocks.printError).toHaveBeenCalledWith(expect.stringContaining('No command provided'))
      expect(mocks.graphqlRequest).not.toHaveBeenCalled()
    })

    it('exits 1 with the server message when the command cannot start', async () => {
      mocks.graphqlRequest.mockResolvedValueOnce({
        startCommandRun: {
          success: false,
          message: 'There was an error while starting the command.',
          runId: null,
          aws: null,
        },
      })

      const exit = await run('web', '--', 'ls')

      expect(exit.code).toBe(1)
      expect(mocks.printError).toHaveBeenCalledWith(
        'There was an error while starting the command.'
      )
    })

    it('fails the spinner and exits 1 when the API call throws', async () => {
      mocks.graphqlRequest.mockRejectedValueOnce(new Error('Not authenticated.'))

      const exit = await run('web', '--', 'ls')

      expect(exit.code).toBe(1)
      expect(mocks.spinner.fail).toHaveBeenCalled()
      expect(mocks.printError).toHaveBeenCalledWith('Not authenticated.')
    })
  })

  describe('on Lambda', () => {
    beforeEach(() => {
      startsLambda()
    })

    it('invokes the live version once with retries off and a timeout past 15 minutes', async () => {
      mocks.lambdaSend.mockResolvedValueOnce(lambdaResponse({ exitCode: 0, output: 'ok\n' }))

      await run('web', '--', 'migrate')

      expect(mocks.lambdaSend).toHaveBeenCalledTimes(1)
      const command = mocks.lambdaSend.mock.calls[0]?.[0] as { input: Record<string, unknown> }
      expect(command.input).toMatchObject({
        FunctionName: INVOCATION.functionName,
        Qualifier: '12',
        InvocationType: 'RequestResponse',
      })
      expect(new TextDecoder().decode(command.input.Payload as Uint8Array)).toBe(INVOCATION.payload)
      const config = mocks.lambdaClientConfig.mock.calls[0]?.[0] as {
        maxAttempts: number
        requestHandler: { requestTimeout: number; throwOnRequestTimeout: boolean }
      }
      expect(config.maxAttempts).toBe(1)
      expect(config.requestHandler.requestTimeout).toBeGreaterThan(15 * 60_000)
      expect(config.requestHandler.throwOnRequestTimeout).toBe(true)
    })

    it('writes the output byte-for-byte and exits 0', async () => {
      const output = 'plain \x1b[31mred\x1b[0m\n'
      mocks.lambdaSend.mockResolvedValueOnce(lambdaResponse({ exitCode: 0, output }))

      const exit = await run('web', '--', 'migrate')

      expect(exit.code).toBe(0)
      expect(writeSpy).toHaveBeenCalledWith(output)
    })

    it('prints the failed command output and exits 1', async () => {
      mocks.lambdaSend.mockResolvedValueOnce(
        lambdaResponse(
          { errorType: 'Bref\\ConsoleRuntime\\CommandFailed', errorMessage: 'SQLSTATE[42S01]\n' },
          'Unhandled'
        )
      )

      const exit = await run('web', '--', 'migrate')

      expect(exit.code).toBe(1)
      expect(written()).toBe('SQLSTATE[42S01]\n')
    })

    it.each(['"plain string"', '42'])('prints the JSON value %s as it arrived', async (body) => {
      mocks.lambdaSend.mockResolvedValueOnce(lambdaResponse(body))

      const exit = await run('web', '--', 'migrate')

      expect(exit.code).toBe(0)
      expect(written()).toBe(`${body}\n`)
    })

    it('prints a response that is not the expected envelope', async () => {
      mocks.lambdaSend.mockResolvedValueOnce(lambdaResponse('not json'))

      const exit = await run('web', '--', 'migrate')

      expect(exit.code).toBe(0)
      expect(written()).toBe('not json\n')
    })

    it('reports a safe message when the connection fails, keeping AWS detail out', async () => {
      mocks.lambdaSend.mockRejectedValueOnce(new Error('AccessDeniedException: lambda:Invoke'))

      const exit = await run('web', '--', 'migrate')

      expect(exit.code).toBe(1)
      expect(mocks.printError).toHaveBeenCalledWith(
        'There was an error while running the command. It may still be running.'
      )
    })
  })

  describe('polling a run', () => {
    beforeEach(() => {
      startsPolledRun()
    })

    it('streams new output with the cursor and exits with the command exit code', async () => {
      status({ state: 'starting' })
      status({ output: 'Migrating\n', outputCursor: 'f/1' })
      status({ state: 'finished', exitCode: 3, output: 'Failed\n', outputCursor: 'f/2' })
      status({ state: 'finished', exitCode: 3, output: 'Late line\n', outputCursor: 'f/3' })
      status({ state: 'finished', exitCode: 3 })

      const exit = await run('web', '--', 'migrate')

      expect(exit.code).toBe(3)
      expect(written()).toBe('Migrating\nFailed\nLate line\n')
      expect(mocks.graphqlRequest.mock.calls[3]?.[1]).toMatchObject({
        runId: RUN_ID,
        outputCursor: 'f/1',
      })
      expect(mocks.graphqlRequest.mock.calls[4]?.[1]).toMatchObject({ outputCursor: 'f/2' })
      expect(mocks.lambdaSend).not.toHaveBeenCalled()
    })

    it('keeps polling past 30 seconds until the command finishes', async () => {
      const now = vi.spyOn(Date, 'now')
      now.mockReturnValue(0)
      status({ state: 'running' })
      now.mockReturnValue(45_000)
      status({ state: 'running' })
      status({ state: 'finished', exitCode: 0 })
      status({ state: 'finished', exitCode: 0 })

      const exit = await run('web', '--', 'sleep', '45')

      expect(exit.code).toBe(0)
    })

    it('waits while ECS has not shown the task yet', async () => {
      status({ state: 'not-found' })
      status({ state: 'finished', exitCode: 0 })
      status({ state: 'finished', exitCode: 0 })

      expect((await run('web', '--', 'ls')).code).toBe(0)
    })

    it('gives up when the task never appears', async () => {
      const now = vi.spyOn(Date, 'now')
      now.mockReturnValueOnce(0).mockReturnValue(61_000)
      status({ state: 'not-found' })

      const exit = await run('web', '--', 'ls')

      expect(exit.code).toBe(1)
      expect(mocks.printError).toHaveBeenCalledWith(`Command run ${RUN_ID} was not found.`)
    })

    it('exits 1 with the message when a task stops without an exit code', async () => {
      const message = 'The command stopped without reporting an exit code.'
      status({ state: 'finished', exitCode: null, message })
      status({ state: 'finished', exitCode: null, message })

      const exit = await run('web', '--', 'ls')

      expect(exit.code).toBe(1)
      expect(mocks.printError).toHaveBeenCalledWith(message)
    })

    it('reads every remaining page of output after the command finishes', async () => {
      status({ state: 'finished', exitCode: 0, output: 'page 1\n', outputCursor: 'f/1' })
      status({ state: 'finished', exitCode: 0, output: 'page 2\n', outputCursor: 'f/2' })
      status({ state: 'finished', exitCode: 0, output: '', outputCursor: 'f/3' })
      status({ state: 'finished', exitCode: 0, output: 'page 3\n', outputCursor: 'f/4' })
      status({ state: 'finished', exitCode: 0, output: '', outputCursor: 'f/4' })

      const exit = await run('web', '--', 'ls')

      expect(exit.code).toBe(0)
      expect(written()).toBe('page 1\npage 2\npage 3\n')
    })

    it('rides out a failed poll and still reports the real result', async () => {
      mocks.graphqlRequest.mockRejectedValueOnce(new Error('Throttled'))
      status({ state: 'finished', exitCode: 4, output: 'done\n' })
      status({ state: 'finished', exitCode: 4 })

      const exit = await run('web', '--', 'ls')

      expect(exit.code).toBe(4)
      expect(written()).toBe('done\n')
      expect(mocks.printError).not.toHaveBeenCalled()
    })

    it('names the run when polling keeps failing, since the command may still be running', async () => {
      const now = vi.spyOn(Date, 'now')
      now.mockReturnValueOnce(0).mockReturnValue(121_000)
      mocks.graphqlRequest.mockRejectedValueOnce(new Error('network down'))

      const exit = await run('web', '--', 'ls')

      expect(exit.code).toBe(1)
      expect(mocks.printError).toHaveBeenCalledWith(
        `There was an error while running the command. It may still be running (run ${RUN_ID}).`
      )
    })

    it('keeps a successful exit code when the final output read fails', async () => {
      status({ state: 'finished', exitCode: 0, output: 'done\n' })
      mocks.graphqlRequest.mockRejectedValueOnce(new Error('Throttled'))

      const exit = await run('web', '--', 'ls')

      expect(exit.code).toBe(0)
      expect(mocks.printError).toHaveBeenCalledWith(
        'The command finished, but the rest of its output could not be read.'
      )
    })
  })

  it('writes nothing for empty output', async () => {
    startsLambda()
    mocks.lambdaSend.mockResolvedValueOnce(lambdaResponse({ exitCode: 0, output: '' }))

    await run('web', '--', 'true')

    expect(writeSpy).not.toHaveBeenCalled()
  })

  it('reads gantry.yml from the current directory by default', async () => {
    startsLambda()
    mocks.lambdaSend.mockResolvedValueOnce(lambdaResponse({ exitCode: 0, output: '' }))

    await run('web', '--', 'ls')

    expect(mocks.loadProjectIdentity).toHaveBeenCalledWith(process.cwd())
  })

  it('shows options before the service in help', () => {
    const program = new Command().enablePositionalOptions()
    registerRunCommand(program)

    const help = program.commands[0]?.helpInformation() ?? ''

    expect(help).toContain('Usage:  run [options] <service> -- <command...>')
  })
})
