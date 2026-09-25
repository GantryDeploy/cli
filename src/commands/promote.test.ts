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

const { registerPromoteCommand } = await import('./promote')

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

const environments = [
  { id: 'env-staging', name: 'Staging', slug: 'staging' },
  { id: 'env-prod', name: 'Production', slug: 'production' },
]

async function run(args: string[]): Promise<void> {
  const program = new Command()
  program.exitOverride()
  registerPromoteCommand(program)
  await program.parseAsync(['node', 'gantry', 'promote', ...args])
}

describe('promote command', () => {
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

  it('resolves the target environment from the project environments by slug', async () => {
    graphqlRequest.mockResolvedValueOnce({ environments }).mockResolvedValueOnce({
      promoteVersion: { success: true, newVersionId: 'b4ht9s', newVersionNumber: 2 },
    })

    await run(['Production', '--from', 'q7mx2v'])

    const envQuery = String(graphqlRequest.mock.calls[0]?.[0])
    expect(envQuery).toContain('environments(projectId: $projectId)')
    expect(envQuery).not.toContain('environmentBySlug')
    expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({ projectId: 'p9ue62' })

    expect(graphqlRequest.mock.calls[1]?.[1]).toEqual({
      input: { sourceVersionId: 'q7mx2v', targetEnvironmentId: 'env-prod' },
    })
  })

  it('starts the deployment with the resolved environment slug, not the raw input', async () => {
    graphqlRequest
      .mockResolvedValueOnce({ environments })
      .mockResolvedValueOnce({
        promoteVersion: {
          success: true,
          newVersionId: 'b4ht9s',
          newVersionNumber: 2,
          yamlSnapshot: '{"services":{}}',
        },
      })
      .mockResolvedValueOnce({ startDeployment: { success: false, message: 'stop here' } })

    await expect(run(['Production', '--from', 'q7mx2v'])).rejects.toThrow('process.exit(1)')

    expect(String(graphqlRequest.mock.calls[2]?.[0])).toContain('startDeployment')
    expect(graphqlRequest.mock.calls[2]?.[1]).toEqual({
      environment: 'production',
      config: { services: {} },
      versionId: 'b4ht9s',
    })
  })

  it('fails without promoting when the environment slug is unknown', async () => {
    graphqlRequest.mockResolvedValueOnce({ environments })

    await expect(run(['qa', '--from', 'q7mx2v'])).rejects.toThrow('process.exit(1)')

    expect(graphqlRequest).toHaveBeenCalledTimes(1)
    expect(errorSpy.mock.calls.flat().join(' ')).toContain(
      "Environment 'qa' not found for this project."
    )
  })
})

describe('promote command end to end', () => {
  let exitSpy: MockInstance
  let errorSpy: MockInstance

  async function runToSettle(args: string[]): Promise<void> {
    const pending = run(args)
    const state = { settled: false }
    const markSettled = () => {
      state.settled = true
    }
    pending.then(markSettled, markSettled)
    for (let i = 0; i < 400 && !state.settled; i++) {
      await vi.advanceTimersByTimeAsync(3000)
    }
    await pending
  }

  function respond(options: {
    promoteVersion?: unknown
    startDeployment?: unknown
    polls?: Record<string, unknown>[]
  }) {
    const polls = [...(options.polls ?? [])]
    let current: Record<string, unknown> = polls[0] ?? {}
    graphqlRequest.mockImplementation((query: string, variables: { id?: string }) => {
      if (query.includes('GetPromoteTargetEnvironments')) {
        return Promise.resolve({ environments })
      }
      if (query.includes('PromoteVersion')) {
        return Promise.resolve({
          promoteVersion: options.promoteVersion ?? {
            success: true,
            message: null,
            promotionId: 'prm_1',
            newVersionId: 'w8fs2k',
            newVersionNumber: 12,
            yamlSnapshot: '{"type":"project","services":{"web":{"type":"container"}}}',
          },
        })
      }
      if (query.includes('StartPromotedDeployment')) {
        return Promise.resolve({
          startDeployment: options.startDeployment ?? {
            success: true,
            message: null,
            deploymentIds: ['dep_web', 'dep_worker'],
            versionId: 'w8fs2k',
          },
        })
      }
      const id = variables.id ?? ''
      if (id === 'dep_web' && polls.length > 0) {
        current = polls.shift() ?? current
      }
      const next = current[id]
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
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('requires a source version before calling the API', async () => {
    await expect(runToSettle(['production'])).rejects.toThrow('process.exit(1)')

    expect(errors()).toContain('A source version ID is required.')
    expect(graphqlRequest).not.toHaveBeenCalled()
  })

  it('promotes, deploys and waits for every service to finish', async () => {
    respond({
      polls: [
        {
          dep_web: { id: 'dep_web', status: 'PROCESSING', serviceName: 'web' },
          dep_worker: new Error('socket hang up'),
        },
        {
          dep_web: { id: 'dep_web', status: 'COMPLETE', serviceName: 'web' },
          dep_worker: { id: 'dep_worker', status: 'SKIPPED', serviceName: null },
        },
      ],
    })

    await runToSettle(['staging', '--from', 't4bx9n', '--cwd', 'app', '-v'])

    expect(graphqlRequest.mock.calls[1]?.[1]).toEqual({
      input: { sourceVersionId: 't4bx9n', targetEnvironmentId: 'env-staging' },
    })
    expect(graphqlRequest.mock.calls[2]?.[1]).toEqual({
      environment: 'staging',
      config: { type: 'project', services: { web: { type: 'container' } } },
      versionId: 'w8fs2k',
    })
    expect(graphqlRequest.mock.calls.slice(3).map((call) => call[1] as unknown)).toEqual([
      { id: 'dep_web' },
      { id: 'dep_worker' },
      { id: 'dep_web' },
      { id: 'dep_worker' },
    ])
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('ignores deployments that no longer exist', async () => {
    respond({
      polls: [{ dep_web: { id: 'dep_web', status: 'COMPLETE', serviceName: 'web' } }],
    })

    await runToSettle(['staging', '--from', 't4bx9n'])

    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('fails once all services settle and one of them failed', async () => {
    respond({
      polls: [
        {
          dep_web: { id: 'dep_web', status: 'FAILED', serviceName: 'web' },
          dep_worker: { id: 'dep_worker', status: 'COMPLETE', serviceName: 'worker' },
        },
      ],
    })

    await expect(runToSettle(['staging', '--from', 't4bx9n'])).rejects.toThrow('process.exit(1)')

    expect(errors()).toContain('One or more service deployments failed')
  })

  it('times out after 15 minutes', async () => {
    respond({
      polls: [
        {
          dep_web: { id: 'dep_web', status: 'PROCESSING', serviceName: 'web' },
          dep_worker: { id: 'dep_worker', status: 'COMPLETE', serviceName: 'worker' },
        },
      ],
    })

    await expect(runToSettle(['staging', '--from', 't4bx9n'])).rejects.toThrow('process.exit(1)')

    expect(errors()).toContain('Deployment timed out after 15 minutes')
  })

  it('surfaces the server message when promotion is refused', async () => {
    respond({
      promoteVersion: { success: false, message: 'Version t4bx9n is not deployable.' },
    })

    await expect(runToSettle(['staging', '--from', 't4bx9n'])).rejects.toThrow('process.exit(1)')

    expect(errors()).toContain('Version t4bx9n is not deployable.')
    expect(graphqlRequest).toHaveBeenCalledTimes(2)
  })

  it('uses a generic message when promotion fails without one', async () => {
    respond({ promoteVersion: { success: true, message: null, newVersionId: null } })

    await expect(runToSettle(['staging', '--from', 't4bx9n'])).rejects.toThrow('process.exit(1)')

    expect(errors()).toContain('Failed to promote version')
  })

  it('reports a start failure after the version was created', async () => {
    respond({ startDeployment: { success: false, message: null, deploymentIds: null } })

    await expect(runToSettle(['staging', '--from', 't4bx9n'])).rejects.toThrow('process.exit(1)')

    expect(errors()).toContain('Failed to start deployment')
    expect(graphqlRequest).toHaveBeenCalledTimes(3)
  })

  it('treats a start with no deployments as a failure', async () => {
    respond({
      startDeployment: { success: true, message: 'Nothing to deploy', deploymentIds: [] },
    })

    await expect(runToSettle(['staging', '--from', 't4bx9n'])).rejects.toThrow('process.exit(1)')

    expect(errors()).toContain('Nothing to deploy')
  })

  it.each(['[]', '"project"', 'null', '42'])(
    'fails without starting a deployment when the snapshot %s is not a JSON object',
    async (yamlSnapshot) => {
      respond({
        promoteVersion: {
          success: true,
          message: null,
          newVersionId: 'w8fs2k',
          newVersionNumber: 12,
          yamlSnapshot,
        },
      })

      await expect(runToSettle(['staging', '--from', 't4bx9n'])).rejects.toThrow('process.exit(1)')

      expect(errors()).toContain('Version snapshot is invalid')
      expect(graphqlRequest).toHaveBeenCalledTimes(2)
    }
  )
})
