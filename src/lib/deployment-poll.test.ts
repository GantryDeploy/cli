import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const graphqlRequest = vi.hoisted(() => vi.fn())

vi.mock(import('./client'), async (importOriginal) => ({
  ...(await importOriginal()),
  graphqlRequest,
}))

const { serviceDeploymentSubtasks } = await import('./deployment-poll')

describe('serviceDeploymentSubtasks', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    graphqlRequest.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function subtasksFor(deploymentIds: string[], onFailure = vi.fn()) {
    return serviceDeploymentSubtasks<object>({
      versionId: 'w8fs2k',
      deploymentIds,
      names: new Map([['dep_api', 'api']]),
      taskContext: { cwd: '/srv/shop' },
      isCancelling: () => false,
      onFailure,
    })
  }

  it('settles a service that finished before its subtask started', async () => {
    graphqlRequest.mockResolvedValue({
      deploymentsByVersion: [{ id: 'dep_api', serviceName: 'api', status: 'COMPLETE', steps: [] }],
    })
    const [api] = subtasksFor(['dep_api'])

    await vi.advanceTimersByTimeAsync(10_000)
    const subtask = { title: '', output: '' }
    await api.task({}, subtask)

    expect(graphqlRequest).toHaveBeenCalledTimes(1)
  })

  it('reports a failed service once its subtask runs', async () => {
    graphqlRequest.mockResolvedValue({
      deploymentsByVersion: [
        {
          id: 'dep_api',
          serviceName: 'api',
          status: 'FAILED',
          lastMessage: 'There was an error while deploying the service.',
          steps: [],
        },
      ],
    })
    const onFailure = vi.fn()
    const [api] = subtasksFor(['dep_api'], onFailure)

    await vi.advanceTimersByTimeAsync(10_000)

    await expect(api.task({}, { title: '', output: '' })).rejects.toThrow(
      'api: Deployment failed - There was an error while deploying the service.'
    )
    expect(onFailure).toHaveBeenCalledWith(
      {},
      {
        id: 'dep_api',
        name: 'api',
        message: 'api: Deployment failed - There was an error while deploying the service.',
      }
    )
  })

  it("prints a release command's output beneath its service", async () => {
    const releasing = {
      id: 'dep_api',
      serviceName: 'api',
      status: 'RUNNING',
      steps: [{ id: 'stp_r4n8wc', stepType: 'release', status: 'PROCESSING', phase: 'DEPLOYING' }],
    }
    graphqlRequest.mockImplementation((query: string) =>
      Promise.resolve(
        query.includes('ReleaseOutput(')
          ? {
              releaseOutput: {
                lines: [{ deploymentId: 'dep_api', message: 'Migrated: 2026_11_12_add_orders' }],
                cursor: 'c1',
              },
            }
          : { deploymentsByVersion: [releasing] }
      )
    )
    const [api] = subtasksFor(['dep_api'])
    const subtask = { title: '', output: '' }
    void api.task({}, subtask)

    await vi.advanceTimersByTimeAsync(2_500)

    expect(subtask.output).toBe('Migrated: 2026_11_12_add_orders')
  })
})
