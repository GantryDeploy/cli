import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

const mocks = vi.hoisted(() => ({
  graphqlRequest: vi.fn(),
  printError: vi.fn(),
  answer: vi.fn<() => string | undefined>(),
  close: vi.fn(),
  spinner: { start: vi.fn(), stop: vi.fn(), fail: vi.fn(), succeed: vi.fn() },
}))

vi.mock('../lib/client', () => ({
  formatApiError: (error: unknown) => (error instanceof Error ? error.message : 'API error'),
  graphqlRequest: mocks.graphqlRequest,
}))
vi.mock('../lib/output', () => ({ printError: mocks.printError }))
vi.mock('ora', () => ({ default: () => mocks.spinner }))
vi.mock('readline', () => ({
  createInterface: () => ({
    close: mocks.close,
    question: (_prompt: string, onAnswer: (answer: string) => void) => {
      const answer = mocks.answer()
      if (answer !== undefined) onAnswer(answer)
    },
  }),
}))

const { registerTeardownCommand } = await import('./teardown')

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

const PHRASE = 'goodbye infrastructure'

function preview(overrides: Record<string, unknown> = {}) {
  return {
    teardownPreview: {
      environmentId: 'g3hm8p',
      environmentName: 'Staging',
      resources: [
        { id: 'r1', resourceType: 's3-bucket', resourceId: 'site-bucket', status: 'active' },
        { id: 'r2', resourceType: 'lambda-function', status: 'active' },
      ],
      totalResources: 2,
      teardownToken: 'tok_123',
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      ...overrides,
    },
  }
}

describe('teardown command', () => {
  let workingDir: string
  let exitSpy: MockInstance
  let logSpy: MockInstance

  async function teardown(environment = 'staging') {
    const program = new Command()
    program.exitOverride()
    registerTeardownCommand(program)
    await program.parseAsync(['node', 'gantry', 'teardown', environment, '--cwd', workingDir])
  }

  function logged() {
    return logSpy.mock.calls.map((args) => args.map(String).join(' ')).join('\n')
  }

  beforeEach(() => {
    workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-teardown-'))
    fs.writeFileSync(
      path.join(workingDir, 'gantry.yml'),
      'type: project\nid: zx8n3d\nenvironments:\n  Staging: {}\n  production: {}\n'
    )
    mocks.graphqlRequest.mockReset()
    mocks.printError.mockReset()
    mocks.answer.mockReset().mockReturnValue(PHRASE)
    mocks.close.mockReset()
    for (const fn of Object.values(mocks.spinner)) fn.mockReset()
    mocks.spinner.start.mockReturnValue(mocks.spinner)
    vi.spyOn(Math, 'random').mockReturnValue(1 / 6)
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitError(code as number | undefined)
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    fs.rmSync(workingDir, { recursive: true, force: true })
  })

  it('previews the resources, requires the phrase, and starts the teardown with the preview token', async () => {
    mocks.graphqlRequest
      .mockResolvedValueOnce(preview())
      .mockResolvedValueOnce({ startTeardown: { success: true, teardownId: 't1' } })

    await teardown('STAGING')

    expect(mocks.graphqlRequest.mock.calls[0][1]).toEqual({
      projectId: 'zx8n3d',
      environmentSlug: 'Staging',
    })
    const text = logged()
    expect(text).toContain('S3 Bucket: site-bucket')
    expect(text).toContain('Lambda Function: r2')
    expect(text).toContain('Total: 2 resource(s)')
    expect(mocks.graphqlRequest.mock.calls[1][1]).toEqual({
      input: {
        projectId: 'zx8n3d',
        environmentSlug: 'Staging',
        teardownToken: 'tok_123',
        confirmationPhrase: PHRASE,
      },
    })
    expect(mocks.spinner.succeed).toHaveBeenCalledWith('Teardown started successfully')
  })

  it('accepts the phrase regardless of case and surrounding whitespace', async () => {
    mocks.answer.mockReturnValue('  GOODBYE Infrastructure ')
    mocks.graphqlRequest
      .mockResolvedValueOnce(preview())
      .mockResolvedValueOnce({ startTeardown: { success: true } })

    await teardown()

    expect(mocks.graphqlRequest).toHaveBeenCalledTimes(2)
  })

  it('cancels without starting anything when the phrase does not match', async () => {
    mocks.answer.mockReturnValue('goodbye')
    mocks.graphqlRequest.mockResolvedValueOnce(preview())

    await expect(teardown()).rejects.toThrow(ExitError)

    expect(exitSpy).toHaveBeenCalledWith(0)
    expect(logged()).toContain('Confirmation phrase did not match. Teardown cancelled.')
    expect(mocks.graphqlRequest).toHaveBeenCalledTimes(1)
  })

  it('gives up without starting anything when the confirmation window expires', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    mocks.answer.mockReturnValue(undefined)
    mocks.graphqlRequest.mockResolvedValueOnce(preview())

    const run = teardown()
    const settled = expect(run).rejects.toThrow(ExitError)
    await vi.advanceTimersByTimeAsync(5 * 60_000)

    await settled
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(mocks.close).toHaveBeenCalled()
    expect(logged()).toContain('The teardown session has expired.')
    expect(mocks.graphqlRequest).toHaveBeenCalledTimes(1)
  })

  it('exits cleanly when there is nothing to tear down', async () => {
    mocks.graphqlRequest.mockResolvedValueOnce(preview({ resources: [], totalResources: 0 }))

    await expect(teardown()).rejects.toThrow(ExitError)

    expect(exitSpy).toHaveBeenCalledWith(0)
    expect(mocks.answer).not.toHaveBeenCalled()
  })

  it('exits when the preview cannot be fetched', async () => {
    mocks.graphqlRequest.mockRejectedValueOnce(new Error('Forbidden.'))

    await expect(teardown()).rejects.toThrow(ExitError)

    expect(mocks.spinner.fail).toHaveBeenCalledWith('Failed to fetch infrastructure details')
    expect(mocks.printError).toHaveBeenCalledWith('Forbidden.')
  })

  it('exits with the server message when the teardown is refused', async () => {
    mocks.graphqlRequest
      .mockResolvedValueOnce(preview())
      .mockResolvedValueOnce({ startTeardown: { success: false, message: 'Token expired.' } })

    await expect(teardown()).rejects.toThrow(ExitError)

    expect(mocks.spinner.fail).toHaveBeenCalledWith('Token expired.')
  })

  it('exits when starting the teardown fails', async () => {
    mocks.graphqlRequest.mockResolvedValueOnce(preview()).mockRejectedValueOnce(new Error('502'))

    await expect(teardown()).rejects.toThrow(ExitError)

    expect(mocks.spinner.fail).toHaveBeenCalledWith('Failed to start teardown')
    expect(mocks.printError).toHaveBeenCalledWith('502')
  })

  it('refuses an environment the project does not declare, before calling the API', async () => {
    await expect(teardown('qa')).rejects.toThrow(ExitError)

    expect(mocks.graphqlRequest).not.toHaveBeenCalled()
  })

  it('falls back to a generic failure when the refusal has an empty message', async () => {
    mocks.graphqlRequest
      .mockResolvedValueOnce(preview())
      .mockResolvedValueOnce({ startTeardown: { success: false, message: '' } })

    await expect(teardown()).rejects.toThrow(ExitError)

    expect(mocks.spinner.fail).toHaveBeenCalledWith('Teardown failed')
    expect(mocks.spinner.succeed).not.toHaveBeenCalled()
  })

  it('reads gantry.yml from the current directory by default', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(workingDir)
    mocks.graphqlRequest.mockResolvedValueOnce(preview({ totalResources: 0, resources: [] }))
    const program = new Command()
    program.exitOverride()
    registerTeardownCommand(program)

    await expect(program.parseAsync(['node', 'gantry', 'teardown', 'STAGING'])).rejects.toThrow(
      'process.exit(0)'
    )

    expect(mocks.graphqlRequest.mock.calls[0]?.[1]).toEqual({
      projectId: 'zx8n3d',
      environmentSlug: 'Staging',
    })
  })
})
