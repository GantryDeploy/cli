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
    const subtask = { title: '' }
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

    await expect(api.task({}, { title: '' })).rejects.toThrow(
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
})
