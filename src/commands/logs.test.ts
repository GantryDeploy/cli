import * as path from 'path'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

const mocks = vi.hoisted(() => ({
  graphqlRequest: vi.fn(),
  printError: vi.fn(),
  loadProjectIdentity: vi.fn(),
  resolveEnvironmentSlug: vi.fn(),
}))

vi.mock('chalk', () => ({ default: { dim: (text: string) => text } }))
vi.mock('../lib/client', () => ({
  formatApiError: (error: unknown) => (error instanceof Error ? error.message : 'API error'),
  graphqlRequest: mocks.graphqlRequest,
}))
vi.mock('../lib/output', () => ({ printError: mocks.printError }))
vi.mock('../lib/project-identity', () => ({
  loadProjectIdentity: mocks.loadProjectIdentity,
  resolveEnvironmentSlug: mocks.resolveEnvironmentSlug,
}))

const { registerLogsCommand } = await import('./logs')

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

const CURSOR_1 = 'eyJhZnRlciI6MTc5Mjk5OTk5NTAwMCwiaWRzIjpbXX0'
const CURSOR_2 = 'eyJhZnRlciI6MTc5MzAwMDAwMDAwMCwiaWRzIjpbXX0'
const CURSOR_3 = 'eyJhZnRlciI6MTc5MzAwMDAwNTAwMCwiaWRzIjpbXX0'

const IDENTITY = { id: 'p9ue62', environments: ['dev', 'production'] }

function page(cursor: string, ...messages: string[]) {
  return {
    serviceLogs: {
      cursor,
      lines: messages.map((message, index) => ({
        timestamp: `2026-10-26T20:41:0${String(index)}.118Z`,
        message,
      })),
    },
  }
}

describe('logs command', () => {
  let stdout: MockInstance
  let stderr: MockInstance

  function logsRun(...args: string[]): Promise<ExitError> {
    const program = new Command()
    program.exitOverride()
    registerLogsCommand(program)
    return program.parseAsync(['node', 'gantry', 'logs', ...args]).then(
      () => {
        throw new Error('expected the command to exit')
      },
      (caught: unknown) => {
        if (caught instanceof ExitError) return caught
        throw caught
      }
    )
  }

  const printed = () => stdout.mock.calls.map((call) => String(call[0])).join('')

  beforeEach(() => {
    mocks.graphqlRequest.mockReset()
    mocks.printError.mockReset()
    mocks.loadProjectIdentity.mockReset().mockReturnValue(IDENTITY)
    mocks.resolveEnvironmentSlug
      .mockReset()
      .mockImplementation((_identity: unknown, requested: string) => requested.toLowerCase())
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitError(typeof code === 'number' ? code : undefined)
    })
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('prints the last hour of a service in dev and exits', async () => {
    mocks.graphqlRequest.mockResolvedValueOnce(
      page(CURSOR_1, 'GET /checkout 200\n', 'GET /cart 500')
    )

    const exit = await logsRun('web')

    expect(exit.code).toBe(0)
    expect(printed()).toBe(
      '2026-10-26T20:41:00.118Z  GET /checkout 200\n2026-10-26T20:41:01.118Z  GET /cart 500\n'
    )
    expect(mocks.loadProjectIdentity).toHaveBeenCalledWith(process.cwd())
    expect(mocks.resolveEnvironmentSlug).toHaveBeenCalledWith(IDENTITY, 'dev')
    expect(mocks.graphqlRequest.mock.calls[0]?.[1]).toEqual({
      projectId: 'p9ue62',
      environmentSlug: 'dev',
      service: 'web',
      function: undefined,
      since: '1h',
      limit: undefined,
      grep: undefined,
      cursor: undefined,
    })
  })

  it('sends every filter it is given', async () => {
    mocks.graphqlRequest.mockResolvedValueOnce(page(CURSOR_1))

    await logsRun(
      '--env',
      'Production',
      '--function',
      'worker',
      '--since',
      '30m',
      '--limit',
      '50',
      '--grep',
      'PDOException',
      '--cwd',
      'apps/shop',
      'web'
    )

    expect(mocks.loadProjectIdentity).toHaveBeenCalledWith(path.resolve('apps/shop'))
    expect(mocks.graphqlRequest.mock.calls[0]?.[1]).toMatchObject({
      environmentSlug: 'production',
      service: 'web',
      function: 'worker',
      since: '30m',
      limit: 50,
      grep: 'PDOException',
    })
  })

  it('strips terminal control sequences from log lines', async () => {
    mocks.graphqlRequest.mockResolvedValueOnce(
      page(CURSOR_1, '\x1b]0;pwned\x07\x1b[2Jdeploy finished\x1b[31m')
    )

    await logsRun('--env', 'production', 'web')

    expect(printed()).toBe('2026-10-26T20:41:00.118Z  deploy finished\n')
  })

  it('says so on stderr when nothing matched', async () => {
    mocks.graphqlRequest.mockResolvedValueOnce(page(CURSOR_1))

    const exit = await logsRun('--env', 'production', '--since', '2d', 'web')

    expect(exit.code).toBe(0)
    expect(stdout).not.toHaveBeenCalled()
    expect(stderr).toHaveBeenCalledWith('No log lines for web in production in the last 2d.\n')
  })

  it('exits 1 with the API message when the request fails', async () => {
    mocks.graphqlRequest.mockRejectedValueOnce(new Error("Service 'api' not found in this project"))

    const exit = await logsRun('--env', 'production', 'api')

    expect(exit.code).toBe(1)
    expect(mocks.printError).toHaveBeenCalledWith("Service 'api' not found in this project")
  })

  it('sends nothing for an environment gantry.yml does not declare', async () => {
    mocks.resolveEnvironmentSlug.mockImplementationOnce(() => process.exit(1))

    const exit = await logsRun('--env', 'qa', 'web')

    expect(exit.code).toBe(1)
    expect(mocks.graphqlRequest).not.toHaveBeenCalled()
  })

  it('requires a service', async () => {
    await expect(logsRun('--env', 'production')).rejects.toThrow(
      "missing required argument 'service'"
    )
    expect(mocks.graphqlRequest).not.toHaveBeenCalled()
  })

  it.each(['0', '1001', '2.5', 'all'])('rejects --limit %s', async (limit) => {
    await expect(logsRun('--limit', limit, 'web')).rejects.toThrow(
      'Must be a whole number from 1 to 1000.'
    )
  })

  describe('--refresh', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    it('polls every 5s with the last cursor, prints only new lines, and stops on Ctrl-C', async () => {
      mocks.graphqlRequest
        .mockResolvedValueOnce(page(CURSOR_1, 'GET / 200'))
        .mockResolvedValueOnce(page(CURSOR_2))
        .mockResolvedValueOnce(page(CURSOR_3, 'GET /cart 500'))

      const run = logsRun('--env', 'production', '--refresh', 'web')
      await vi.advanceTimersByTimeAsync(4_999)
      expect(mocks.graphqlRequest).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(10_000)
      process.emit('SIGINT')
      const exit = await run

      expect(exit.code).toBe(0)
      expect(
        mocks.graphqlRequest.mock.calls.map((call) => (call[1] as { cursor?: string }).cursor)
      ).toEqual([undefined, CURSOR_1, CURSOR_2])
      expect(printed()).toBe(
        '2026-10-26T20:41:00.118Z  GET / 200\n2026-10-26T20:41:00.118Z  GET /cart 500\n'
      )
      expect(stderr).toHaveBeenCalledWith('Showing new lines every 5s. Press Ctrl-C to stop.\n')
      expect(process.listenerCount('SIGINT')).toBe(0)
    })

    it('exits 1 when a poll fails', async () => {
      mocks.graphqlRequest
        .mockResolvedValueOnce(page(CURSOR_1))
        .mockRejectedValueOnce(new Error('There was an error while loading the logs.'))

      const run = logsRun('--env', 'production', '--refresh', 'web')
      await vi.advanceTimersByTimeAsync(5_000)
      const exit = await run

      expect(exit.code).toBe(1)
      expect(mocks.printError).toHaveBeenCalledWith('There was an error while loading the logs.')
    })
  })
})
