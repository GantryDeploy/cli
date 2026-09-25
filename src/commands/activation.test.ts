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

const { registerActivationCommands } = await import('./activation')

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

async function run(args: string[]): Promise<void> {
  const program = new Command()
  program.exitOverride()
  registerActivationCommands(program)
  await program.parseAsync(['node', 'gantry', ...args])
}

describe('canary --weight', () => {
  let errorSpy: MockInstance

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitError(code as number | undefined)
    })
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each(['', '   ', 'abc', '-1', '101'])('rejects %j without calling the API', async (weight) => {
    await expect(
      run(['canary', 'production', '--version', 'q7mx2v', '--weight', weight])
    ).rejects.toThrow('process.exit(1)')

    expect(errorSpy.mock.calls.flat().join(' ')).toContain(
      '--weight must be a number between 0 and 100.'
    )
    expect(graphqlRequest).not.toHaveBeenCalled()
  })

  it('accepts an explicit 0', async () => {
    graphqlRequest.mockResolvedValueOnce({ setCanary: { success: false, message: 'stop here' } })

    await expect(
      run(['canary', 'production', '--version', 'q7mx2v', '--weight', '0'])
    ).rejects.toThrow('process.exit(1)')

    expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({
      input: { projectId: 'p9ue62', environment: 'production', versionId: 'q7mx2v', weight: 0 },
    })
  })
})

describe('activation commands', () => {
  let exitSpy: MockInstance
  let errorSpy: MockInstance

  async function runToSettle(args: string[]): Promise<void> {
    const pending = run(args)
    const state = { settled: false }
    const markSettled = () => {
      state.settled = true
    }
    pending.then(markSettled, markSettled)
    for (let i = 0; i < 200 && !state.settled; i++) {
      await vi.advanceTimersByTimeAsync(2000)
    }
    await pending
  }

  function respond(field: string, ...deployments: unknown[]) {
    graphqlRequest.mockImplementation((query: string) => {
      if (!query.includes('GetActivationDeployment')) {
        return Promise.resolve({
          [field]: { success: true, message: null, deploymentId: 'dep_act_1' },
        })
      }
      const next = deployments.length > 1 ? deployments.shift() : deployments[0]
      return next instanceof Error ? Promise.reject(next) : Promise.resolve({ deployment: next })
    })
  }

  function errors(): string {
    return errorSpy.mock.calls.flat().join(' ')
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
    graphqlRequest.mockReset()
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitError(code as number | undefined)
    })
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('rolls back and polls through network errors until the activation completes', async () => {
    respond(
      'rollbackDeployment',
      { id: 'dep_act_1', status: 'PENDING', lastMessage: null },
      new Error('socket hang up'),
      { id: 'dep_act_1', status: 'PROCESSING', lastMessage: 'Updating routes' },
      { id: 'dep_act_1', status: 'COMPLETE', lastMessage: 'Routing updated' }
    )

    await runToSettle(['rollback', 'production', '--version', 'a8qe5z'])

    expect(graphqlRequest.mock.calls[0]?.[0]).toContain('rollbackDeployment(input: $input)')
    expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({
      input: { projectId: 'p9ue62', environment: 'production', versionId: 'a8qe5z' },
    })
    expect(graphqlRequest.mock.calls.slice(1).map((call) => call[1] as unknown)).toEqual([
      { id: 'dep_act_1' },
      { id: 'dep_act_1' },
      { id: 'dep_act_1' },
      { id: 'dep_act_1' },
    ])
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('sets a canary weight and applies it', async () => {
    respond('setCanary', { id: 'dep_act_1', status: 'COMPLETE', lastMessage: null })

    await runToSettle(['canary', 'staging', '--version', 'c2vj6m', '--weight', ' 25 ', '-v'])

    expect(graphqlRequest.mock.calls[0]?.[0]).toContain('setCanary(input: $input)')
    expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({
      input: { projectId: 'p9ue62', environment: 'staging', versionId: 'c2vj6m', weight: 25 },
    })
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('accepts the 100% boundary', async () => {
    respond('setCanary', { id: 'dep_act_1', status: 'COMPLETE' })

    await runToSettle(['canary', 'staging', '--version', 'c2vj6m', '--weight', '100'])

    expect(graphqlRequest.mock.calls[0]?.[1]).toMatchObject({ input: { weight: 100 } })
  })

  it('promotes the canary', async () => {
    respond('promoteCanary', { id: 'dep_act_1', status: 'COMPLETE' })

    await runToSettle(['canary:promote', 'production'])

    expect(graphqlRequest.mock.calls[0]?.[0]).toContain('promoteCanary(input: $input)')
    expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({
      input: { projectId: 'p9ue62', environment: 'production' },
    })
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('aborts the canary', async () => {
    respond('abortCanary', { id: 'dep_act_1', status: 'COMPLETE' })

    await runToSettle(['canary:abort', 'production'])

    expect(graphqlRequest.mock.calls[0]?.[0]).toContain('abortCanary(input: $input)')
    expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({
      input: { projectId: 'p9ue62', environment: 'production' },
    })
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('cuts over a blue-green deployment', async () => {
    respond('promoteBlueGreen', { id: 'dep_act_1', status: 'COMPLETE' })

    await runToSettle(['cutover', 'production', '--version', 'y7lp3h', '--cwd', 'app'])

    expect(graphqlRequest.mock.calls[0]?.[0]).toContain('promoteBlueGreen(input: $input)')
    expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({
      input: { projectId: 'p9ue62', environment: 'production', versionId: 'y7lp3h' },
    })
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it.each([
    ['rollbackDeployment', ['rollback', 'production', '--version', 'a8qe5z']],
    ['setCanary', ['canary', 'production', '--version', 'a8qe5z', '--weight', '10']],
    ['promoteCanary', ['canary:promote', 'production']],
    ['abortCanary', ['canary:abort', 'production']],
    ['promoteBlueGreen', ['cutover', 'production', '--version', 'a8qe5z']],
  ])('exits with the server message when %s is refused', async (field, args) => {
    graphqlRequest.mockResolvedValue({
      [field]: { success: false, message: 'No canary is in progress.', deploymentId: null },
    })

    await expect(runToSettle(args)).rejects.toThrow('process.exit(1)')

    expect(errors()).toContain('No canary is in progress.')
    expect(graphqlRequest).toHaveBeenCalledOnce()
  })

  it('falls back to a generic message when a refusal has none', async () => {
    graphqlRequest.mockResolvedValue({
      rollbackDeployment: { success: false, message: null, deploymentId: null },
    })

    await expect(runToSettle(['rollback', 'production', '--version', 'a8qe5z'])).rejects.toThrow(
      'process.exit(1)'
    )

    expect(errors()).toContain('Failed to roll back production')
  })

  it('treats success without a deployment id as a failure', async () => {
    graphqlRequest.mockResolvedValue({
      promoteCanary: { success: true, message: null, deploymentId: null },
    })

    await expect(runToSettle(['canary:promote', 'production'])).rejects.toThrow('process.exit(1)')

    expect(errors()).toContain('Failed to promote canary in production')
    expect(graphqlRequest).toHaveBeenCalledOnce()
  })

  it('exits with the failure message when the activation fails', async () => {
    respond('rollbackDeployment', {
      id: 'dep_act_1',
      status: 'FAILED',
      lastMessage: 'Target version has no image',
    })

    await expect(runToSettle(['rollback', 'production', '--version', 'a8qe5z'])).rejects.toThrow(
      'process.exit(1)'
    )

    expect(errors()).toContain('Activation failed - Target version has no image')
  })

  it('strips terminal escapes from the failure message', async () => {
    respond('rollbackDeployment', {
      id: 'dep_act_1',
      status: 'FAILED',
      lastMessage: 'bad\u001b[2Jimage',
    })

    await expect(runToSettle(['rollback', 'production', '--version', 'a8qe5z'])).rejects.toThrow(
      'process.exit(1)'
    )

    expect(errors()).not.toContain('\u001b[2J')
  })

  it.each(['CANCELLED', 'SKIPPED'])('settles quietly on %s', async (status) => {
    respond('abortCanary', { id: 'dep_act_1', status })

    await runToSettle(['canary:abort', 'production'])

    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('stops polling when the activation deployment disappears', async () => {
    respond('abortCanary', null)

    await runToSettle(['canary:abort', 'production'])

    expect(graphqlRequest).toHaveBeenCalledTimes(2)
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('rethrows not-found errors from the poll', async () => {
    respond('abortCanary', new Error('Deployment not found'))

    await expect(runToSettle(['canary:abort', 'production'])).rejects.toThrow('process.exit(1)')

    expect(errors()).toContain('Deployment not found')
  })

  it('times out when the activation never settles', async () => {
    respond('promoteCanary', { id: 'dep_act_1', status: 'PROCESSING' })

    await expect(runToSettle(['canary:promote', 'production'])).rejects.toThrow('process.exit(1)')

    expect(errors()).toContain('Activation timed out after 5 minutes')
  })
})
