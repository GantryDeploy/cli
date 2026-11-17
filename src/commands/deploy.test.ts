import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

const graphqlRequest = vi.hoisted(() => vi.fn())

vi.mock('../lib/client', () => ({
  formatApiError: (error: unknown) => (error instanceof Error ? error.message : 'API error'),
  graphqlRequest,
}))
vi.mock('../lib/listr', () => ({
  resolveRenderer: () => 'silent',
  shouldUseFallbackRenderer: () => false,
}))
vi.mock('../lib/project-identity', () => ({
  loadProjectIdentity: () => ({ id: 'p9ue62' }),
}))

const { registerDeployCommand, registerRollbackCommand, statusLines } = await import('./deploy')

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

function program(): Command {
  const root = new Command()
  root.exitOverride()
  registerRollbackCommand(root)
  registerDeployCommand(root)
  return root
}

async function run(args: string[]): Promise<void> {
  const pending = program().parseAsync(['node', 'gantry', ...args])
  const state = { settled: false }
  const markSettled = () => {
    state.settled = true
  }
  pending.then(markSettled, markSettled)
  for (let i = 0; i < 1000 && !state.settled; i++) {
    await vi.advanceTimersByTimeAsync(2000)
  }
  await pending
}

let errorSpy: MockInstance
let logSpy: MockInstance

function errors(): string {
  return errorSpy.mock.calls.flat().join(' ')
}

function variablesOf(operation: string): unknown {
  return graphqlRequest.mock.calls.find(([query]) => (query as string).includes(operation))?.[1]
}

/** The operation succeeds, then the deployment it starts reports each of `deployments` in turn. */
function respond(field: string, ...deployments: unknown[]) {
  graphqlRequest.mockImplementation((query: string) => {
    if (!query.includes('GetReleaseDeployment')) {
      return Promise.resolve({
        [field]: {
          success: true,
          message: 'Cutting production over to v42.',
          deploymentId: 'dep_7',
        },
      })
    }
    const next = deployments.length > 1 ? deployments.shift() : deployments[0]
    return next instanceof Error ? Promise.reject(next) : Promise.resolve({ deployment: next })
  })
}

const complete = { id: 'dep_7', status: 'COMPLETE', lastMessage: 'Routing applied' }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
  graphqlRequest.mockReset()
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new ExitError(code as number | undefined)
  })
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('release operations', () => {
  it.each([
    [['deploy', 'cutover', 'production'], 'cutover', { complete: undefined }],
    [['deploy', 'cutover', 'production', '--complete'], 'cutover', { complete: true }],
    [
      ['deploy', 'shift', 'production', '--percent', '25'],
      'shiftTraffic',
      { percent: 25, complete: undefined },
    ],
    [
      ['deploy', 'shift', 'production', '--percent', '0'],
      'shiftTraffic',
      { percent: 0, complete: undefined },
    ],
    [
      ['deploy', 'shift', 'production', '--percent', '100', '--complete'],
      'shiftTraffic',
      { percent: 100, complete: true },
    ],
    [['deploy', 'abort', 'production'], 'abortRelease', {}],
    [['deploy', 'complete', 'production'], 'completeRelease', {}],
    [['deploy', 'reapply', 'production'], 'reapplyRouting', {}],
    [['rollback', 'production'], 'rollback', { versionId: undefined }],
    [['rollback', 'production', '--version', 'q7mx2v'], 'rollback', { versionId: 'q7mx2v' }],
  ])('%j sends %s and waits for it to apply', async (args, field, extra) => {
    respond(field, { id: 'dep_7', status: 'RUNNING', lastMessage: 'Configuring routing' }, complete)

    await run(args)

    expect(variablesOf(`${field}(`)).toEqual({
      input: { projectId: 'p9ue62', environment: 'production', ...extra },
    })
    expect(variablesOf('GetReleaseDeployment')).toEqual({ id: 'dep_7' })
    expect(errors()).toBe('')
  })

  it.each([
    ['abc', '--percent must be a whole number from 0 to 100.'],
    ['-1', '--percent must be a whole number from 0 to 100.'],
    ['101', '--percent must be a whole number from 0 to 100.'],
    ['12.5', '--percent must be a whole number from 0 to 100.'],
  ])('refuses --percent %j without calling the API', async (percent, message) => {
    await expect(run(['deploy', 'shift', 'production', '--percent', percent])).rejects.toThrow(
      'process.exit(1)'
    )

    expect(errors()).toContain(message)
    expect(graphqlRequest).not.toHaveBeenCalled()
  })

  it('refuses --complete on a shift short of 100%', async () => {
    await expect(
      run(['deploy', 'shift', 'production', '--percent', '50', '--complete'])
    ).rejects.toThrow('process.exit(1)')

    expect(errors()).toContain('--complete is only valid with --percent 100.')
    expect(graphqlRequest).not.toHaveBeenCalled()
  })

  it('exits with the refusal the API gives', async () => {
    graphqlRequest.mockResolvedValue({
      cutover: {
        success: false,
        message: 'There is no release in progress in this environment.',
        deploymentId: null,
      },
    })

    await expect(run(['deploy', 'cutover', 'production'])).rejects.toThrow('process.exit(1)')

    expect(errors()).toContain('There is no release in progress in this environment.')
  })

  it.each([
    ['FAILED', 'Failed: Routing failed on the edge'],
    ['CANCELLED', 'Cancelled: Routing failed on the edge'],
    ['SKIPPED', 'Skipped: Routing failed on the edge'],
  ])('exits non-zero when the deployment ends %s', async (status, message) => {
    respond('cutover', { id: 'dep_7', status, lastMessage: 'Routing failed on the edge' })

    await expect(run(['deploy', 'cutover', 'production'])).rejects.toThrow('process.exit(1)')

    expect(errors()).toContain(message)
  })

  it('exits non-zero when the deployment disappears', async () => {
    respond('cutover', null)

    await expect(run(['deploy', 'cutover', 'production'])).rejects.toThrow('process.exit(1)')

    expect(errors()).toContain('Deployment dep_7 not found.')
  })

  it('keeps polling through a failed request', async () => {
    respond('abortRelease', new Error('socket hang up'), complete)

    await run(['deploy', 'abort', 'production'])

    expect(errors()).toBe('')
  })

  it('says the operation keeps running when it outlasts the wait', async () => {
    respond('cutover', { id: 'dep_7', status: 'RUNNING', lastMessage: 'Configuring routing' })

    await expect(run(['deploy', 'cutover', 'production'])).rejects.toThrow('process.exit(1)')

    expect(errors()).toContain(
      'Still running after 30 minutes. It keeps running; check it with `gantry deployments show dep_7`.'
    )
  })

  it('hides reapply from the deploy help', () => {
    const deploy = program().commands.find((command) => command.name() === 'deploy')

    expect(deploy?.helpInformation()).not.toContain('reapply')
    expect(deploy?.helpInformation()).toContain('cutover')
  })
})

describe('deploy status', () => {
  const stagedBlueGreen = {
    strategy: 'blue-green',
    state: 'STAGED' as const,
    since: '2026-11-14T09:12:00.000Z',
    versions: [
      {
        versionId: 'q7mx2v',
        number: 41,
        role: 'LIVE' as const,
        weight: 100,
        createdAt: '2026-11-10T08:00:00.000Z',
      },
      {
        versionId: 'r8ny3w',
        number: 42,
        role: 'STAGED' as const,
        weight: 0,
        createdAt: '2026-11-16T15:40:00.000Z',
      },
    ],
  }

  it('shows each version and the next step of a staged blue-green release', () => {
    expect(statusLines('production', stagedBlueGreen)).toEqual([
      'production  (blue-green)',
      '  live      v41    100%   since 2026-11-14 09:12 UTC',
      '  staged    v42      0%   lifted 2026-11-16 15:40 UTC',
      '  next:     gantry deploy cutover production',
    ])
  })

  it.each([
    ['STAGED' as const, 'canary', 'gantry deploy shift production --percent <percent>'],
    ['SPLIT' as const, 'canary', 'gantry deploy shift production --percent <percent>'],
    ['CUT_OVER' as const, 'blue-green', 'gantry deploy complete production'],
  ])('suggests the next step while %s under %s', (state, strategy, next) => {
    expect(statusLines('production', { ...stagedBlueGreen, state, strategy }).at(-1)).toBe(
      `  next:     ${next}`
    )
  })

  it('suggests nothing without a release in progress', () => {
    const lines = statusLines('production', {
      ...stagedBlueGreen,
      strategy: 'standard',
      state: 'NONE',
      versions: [stagedBlueGreen.versions[0]],
    })

    expect(lines).toEqual([
      'production  (standard)',
      '  live      v41    100%   since 2026-11-14 09:12 UTC',
    ])
  })

  it('prints the status of the project in the working directory', async () => {
    graphqlRequest.mockResolvedValue({ releaseStatus: stagedBlueGreen })

    await run(['deploy', 'status', 'production'])

    expect(variablesOf('ReleaseStatus')).toEqual({ projectId: 'p9ue62', environment: 'production' })
    expect(logSpy.mock.calls.flat()).toContain('  next:     gantry deploy cutover production')
  })

  it('says so when nothing is live', async () => {
    graphqlRequest.mockResolvedValue({ releaseStatus: null })

    await run(['deploy', 'status', 'production'])

    expect(logSpy).toHaveBeenCalledWith('Nothing is live in production yet.')
  })

  it('exits non-zero when the status cannot be read', async () => {
    graphqlRequest.mockRejectedValue(new Error("Environment 'production' not found."))

    await expect(run(['deploy', 'status', 'production'])).rejects.toThrow('process.exit(1)')

    expect(errors()).toContain("Environment 'production' not found.")
  })
})
