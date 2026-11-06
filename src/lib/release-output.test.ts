import { beforeEach, describe, expect, it, vi } from 'vitest'

const graphqlRequest = vi.hoisted(() => vi.fn())
vi.mock('./client', () => ({ graphqlRequest }))

const { RELEASE_OUTPUT_QUERY, followReleaseOutput } = await import('./release-output')

const VERSION_ID = 'v9Kq2'

function deployments(releaseStatus?: string) {
  return [
    {
      id: 'dep_8Kq2mZ',
      status: 'IN_PROGRESS',
      scope: 'service-env',
      deploymentType: 'deploy',
      lastMessage: null,
      serviceName: 'web',
      steps: [
        {
          id: 'st_9Lm3',
          stepType: 'ecs-deploy',
          status: 'COMPLETE',
          phase: 'DEPLOYING',
          executor: 'WORKER',
          cliTask: null,
          cliStatus: null,
          sequence: 7,
        },
        ...(releaseStatus
          ? [
              {
                id: 'st_4Rw1',
                stepType: 'release',
                status: releaseStatus,
                phase: 'DEPLOYING',
                executor: 'WORKER',
                cliTask: null,
                cliStatus: null,
                sequence: 8,
              },
            ]
          : []),
      ],
    },
  ] as never
}

function page(messages: string[], cursor?: string) {
  return {
    releaseOutput: {
      lines: messages.map((message) => ({ message, deploymentId: 'dep_8Kq2mZ' })),
      cursor,
    },
  }
}

describe('followReleaseOutput', () => {
  const written: [string, string][] = []
  const write = (deploymentId: string, line: string) => {
    written.push([deploymentId, line])
  }

  beforeEach(() => {
    vi.clearAllMocks()
    written.length = 0
  })

  it('asks for nothing until a release step starts', async () => {
    const follow = followReleaseOutput(VERSION_ID, write)

    await follow(deployments())
    await follow(deployments('QUEUED'))

    expect(graphqlRequest).not.toHaveBeenCalled()
  })

  it('prints each new line once, reading on from the last cursor', async () => {
    graphqlRequest
      .mockResolvedValueOnce(page(['   INFO  Running migrations.'], 'c1'))
      .mockResolvedValueOnce(page(['  2026_11_01_120000_add_invoice_status ... DONE'], 'c2'))
    const follow = followReleaseOutput(VERSION_ID, write)

    await follow(deployments('PROCESSING'))
    await follow(deployments('PROCESSING'))

    expect(graphqlRequest).toHaveBeenNthCalledWith(1, RELEASE_OUTPUT_QUERY, {
      versionId: VERSION_ID,
      after: undefined,
    })
    expect(graphqlRequest).toHaveBeenNthCalledWith(2, RELEASE_OUTPUT_QUERY, {
      versionId: VERSION_ID,
      after: 'c1',
    })
    expect(written).toEqual([
      ['dep_8Kq2mZ', '   INFO  Running migrations.'],
      ['dep_8Kq2mZ', '  2026_11_01_120000_add_invoice_status ... DONE'],
    ])
  })

  it('stops asking once the step has finished and no lines remain', async () => {
    graphqlRequest
      .mockResolvedValueOnce(page(['Nothing to migrate.'], 'c1'))
      .mockResolvedValueOnce(page([], 'c1'))
    const follow = followReleaseOutput(VERSION_ID, write)

    await follow(deployments('COMPLETE'))
    await follow(deployments('COMPLETE'))
    await follow(deployments('COMPLETE'))

    expect(graphqlRequest).toHaveBeenCalledTimes(2)
    expect(written).toEqual([['dep_8Kq2mZ', 'Nothing to migrate.']])
  })
})

describe('followReleaseOutput past unrelated logs', () => {
  it('keeps reading while a page with no release lines still moves the cursor', async () => {
    graphqlRequest
      .mockResolvedValueOnce(page([], 'c1'))
      .mockResolvedValueOnce(page(['Nothing to migrate.'], 'c2'))
      .mockResolvedValueOnce(page([], 'c2'))
    const lines: string[] = []
    const follow = followReleaseOutput(VERSION_ID, (_deploymentId, line) => lines.push(line))

    await follow(deployments('COMPLETE'))
    await follow(deployments('COMPLETE'))
    await follow(deployments('COMPLETE'))
    await follow(deployments('COMPLETE'))

    expect(lines).toEqual(['Nothing to migrate.'])
    expect(graphqlRequest).toHaveBeenCalledTimes(3)
  })
})
