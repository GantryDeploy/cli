import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

import type { ArtifactUploadInputs, TaskResult } from '../lib/tasks'

const mocks = vi.hoisted(() => ({
  graphqlRequest: vi.fn(),
  executeCliTask: vi.fn(),
}))

vi.mock(import('../lib/client'), async (importOriginal) => ({
  ...(await importOriginal()),
  graphqlRequest: mocks.graphqlRequest,
}))
vi.mock(import('../lib/tasks'), async (importOriginal) => ({
  ...(await importOriginal()),
  executeCliTask: mocks.executeCliTask,
}))
vi.mock('../lib/listr', () => ({
  resolveRenderer: () => 'silent',
  shouldUseFallbackRenderer: () => false,
}))
vi.mock('../lib/project-identity', () => ({
  loadProjectIdentity: () => ({ id: 'p9ue62' }),
}))

const { promoteSource, registerPromoteCommand } = await import('./promote')

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

type Handler = (variables: Record<string, unknown>) => unknown

const environments = [
  { id: 'k3x9qa', name: 'Staging', slug: 'staging' },
  { id: 'b9t4rk', name: 'Production', slug: 'production' },
]

const COPY_STEP = {
  id: 'stp_q7m2pd',
  status: 'AWAITING_CLI',
  cliStatus: 'PENDING',
  executor: 'CLI',
  cliTask: 'artifact-upload',
  phase: 'UPLOADING',
}

const COPY_INPUTS: ArtifactUploadInputs = {
  __typename: 'ArtifactUploadCliInputs',
  stepId: 'stp_q7m2pd',
  provider: 'aws',
  bucketName: 'shop-api-artifacts-euw1-b9t4rk',
  objectKey: 'api/v12/artifact.zip',
  region: 'eu-west-1',
  maxArtifactBytes: 52428800,
  packageSourcePath: null,
  excludePatterns: null,
  aws: { accessKeyId: 'ASIATARGET', secretAccessKey: 'target-secret', sessionToken: 'target' },
  source: {
    bucketName: 'shop-api-artifacts-use1-k3x9qa',
    objectKey: 'api/v12/artifact.zip',
    region: 'us-east-1',
    aws: { accessKeyId: 'ASIASOURCE', secretAccessKey: 'source-secret', sessionToken: 'source' },
  },
}

const COPY_RESULT: TaskResult = {
  outputs: {
    artifactUpload: {
      bucketName: 'shop-api-artifacts-euw1-b9t4rk',
      objectKey: 'api/v12/artifact.zip',
      zipSize: 18_400_000,
      success: true,
    },
  },
}

function deployment(overrides: Record<string, unknown> = {}) {
  return { id: 'dep_api', serviceName: 'api', status: 'RUNNING', steps: [], ...overrides }
}

const ROUTING = {
  id: 'dep_routing',
  scope: 'project-env',
  serviceName: null,
  status: 'RUNNING',
  steps: [],
}

function withRouting(...services: unknown[]) {
  return [...services, ROUTING]
}

describe('promoteSource', () => {
  it.each([
    ['staging', { sourceEnvironmentId: 'k3x9qa' }],
    ['Staging', { sourceEnvironmentId: 'k3x9qa' }],
    ['v12', { buildNumber: 12 }],
    ['v999999999', { buildNumber: 999999999 }],
  ])('reads --from %s', (from, expected) => {
    expect(promoteSource(from, environments)).toEqual(expected)
  })

  it('prefers an environment whose slug looks like a build number', () => {
    expect(
      promoteSource('v2', [...environments, { id: 'r5n8wc', name: 'V2', slug: 'v2' }])
    ).toEqual({ sourceEnvironmentId: 'r5n8wc' })
  })

  it.each(['12', 'v0', 'v', 'V12', 'v1234567890', 'qa'])(
    'rejects --from %s as an unknown environment',
    (from) => {
      expect(() => promoteSource(from, environments)).toThrow(
        `Environment '${from}' not found for this project.`
      )
    }
  )
})

describe('promote command', () => {
  let handlers: Record<string, Handler>
  let byVersion: unknown[][]
  let exitSpy: MockInstance
  let errorSpy: MockInstance

  function sequence(...responses: unknown[][]) {
    byVersion = responses
  }

  function calls(operation: string): unknown[] {
    return mocks.graphqlRequest.mock.calls
      .filter(([query]) => String(query).includes(`${operation}(`))
      .map(([, variables]) => variables as unknown)
  }

  function errors(): string {
    return errorSpy.mock.calls.flat().join(' ')
  }

  async function run(args: string[]): Promise<void> {
    const program = new Command()
    program.exitOverride()
    registerPromoteCommand(program)
    const pending = program.parseAsync(['node', 'gantry', 'promote', ...args])
    const state = { settled: false }
    const markSettled = () => {
      state.settled = true
    }
    pending.then(markSettled, markSettled)
    for (let i = 0; i < 400 && !state.settled; i++) {
      await vi.advanceTimersByTimeAsync(2000)
    }
    await pending
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
    mocks.graphqlRequest.mockReset()
    mocks.executeCliTask.mockReset().mockResolvedValue(COPY_RESULT)
    sequence(withRouting(deployment({ status: 'COMPLETE' })))
    handlers = {
      GetPromoteTargetEnvironments: () => ({ environments }),
      PromoteVersion: () => ({
        promoteVersion: {
          success: true,
          message: null,
          promotionId: 'prm_w8fs2k',
          newVersionId: 'w8fs2k',
          newVersionNumber: 12,
          yamlSnapshot: '{"type":"project","services":{"api":{"type":"http"}}}',
        },
      }),
      StartPromotedDeployment: () => ({
        startDeployment: {
          success: true,
          message: null,
          deploymentIds: ['dep_api'],
          versionId: 'w8fs2k',
        },
      }),
      DeploymentsByVersion: () => ({
        deploymentsByVersion: byVersion.length > 1 ? byVersion.shift() : byVersion[0],
      }),
      ClaimStep: () => ({
        claimStep: { success: true, step: { ...COPY_STEP, cliInputs: COPY_INPUTS } },
      }),
      CompleteCliStep: () => ({ completeCliStep: { success: true } }),
      FailCliStep: () => ({ failCliStep: { success: true } }),
      GetRoutingDeployment: () => ({
        deployment: { id: 'dep_routing', status: 'COMPLETE', lastMessage: null },
      }),
      VersionRouteUrls: () => ({
        versionRouteUrls: [
          {
            url: 'https://shop.example.com/api',
            domain: 'shop.example.com',
            path: '/api',
            serviceName: 'api',
            cache: false,
          },
        ],
      }),
      VersionDnsRecords: () => ({ versionDnsRecords: [] }),
    }
    mocks.graphqlRequest.mockImplementation((query: string, variables: Record<string, unknown>) => {
      const operation = Object.keys(handlers).find((name) => query.includes(`${name}(`))
      if (!operation) throw new Error(`Unexpected query: ${query}`)
      return Promise.resolve().then(() => handlers[operation](variables))
    })
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

  it('promotes the live build of an environment to the target environment', async () => {
    await run(['Production', '--from', 'staging'])

    expect(calls('GetPromoteTargetEnvironments')).toEqual([{ projectId: 'p9ue62' }])
    expect(calls('PromoteVersion')).toEqual([
      { input: { sourceEnvironmentId: 'k3x9qa', targetEnvironmentId: 'b9t4rk' } },
    ])
    expect(calls('StartPromotedDeployment')).toEqual([
      {
        environment: 'production',
        config: { type: 'project', services: { api: { type: 'http' } } },
        versionId: 'w8fs2k',
      },
    ])
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('waits for routing and prints the live routes', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await run(['production', '--from', 'staging'])

    expect(calls('GetRoutingDeployment')).toEqual([{ id: 'dep_routing' }])
    expect(logSpy.mock.calls.flat().join('\n')).toContain('https://shop.example.com/api')
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('fails when routing fails after every service deployed', async () => {
    handlers.GetRoutingDeployment = () => ({
      deployment: {
        id: 'dep_routing',
        status: 'FAILED',
        lastMessage: 'There was an error while updating the load balancer.',
      },
    })

    await expect(run(['production', '--from', 'staging'])).rejects.toThrow('process.exit(1)')

    expect(errors()).toContain(
      'Routing failed - There was an error while updating the load balancer.'
    )
  })

  it('applies no routing when a service fails', async () => {
    sequence(withRouting(deployment({ status: 'FAILED' })))

    await expect(run(['production', '--from', 'staging'])).rejects.toThrow('process.exit(1)')

    expect(calls('GetRoutingDeployment')).toEqual([])
  })

  it('promotes a build by number', async () => {
    await run(['production', '--from', 'v12'])

    expect(calls('PromoteVersion')).toEqual([
      { input: { buildNumber: 12, targetEnvironmentId: 'b9t4rk' } },
    ])
  })

  it('claims a copy step and runs it without project files', async () => {
    sequence(
      withRouting(deployment()),
      withRouting(deployment({ steps: [COPY_STEP] })),
      withRouting(
        deployment({ steps: [{ ...COPY_STEP, status: 'COMPLETE', cliStatus: 'COMPLETE' }] })
      ),
      withRouting(deployment({ status: 'COMPLETE' }))
    )

    await run(['production', '--from', 'staging', '--cwd', '/srv/shop'])

    expect(calls('ClaimStep')).toEqual([{ stepId: 'stp_q7m2pd' }])
    expect(mocks.executeCliTask).toHaveBeenCalledWith(COPY_INPUTS, { cwd: '/srv/shop' })
    expect(calls('CompleteCliStep')).toEqual([
      { stepId: 'stp_q7m2pd', outputs: COPY_RESULT.outputs, fileResults: null },
    ])
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('fails the step and the promote when the copy fails', async () => {
    sequence(
      withRouting(deployment()),
      withRouting(deployment({ steps: [COPY_STEP] })),
      withRouting(
        deployment({ status: 'FAILED', lastMessage: 'There was an error while uploading.' })
      )
    )
    mocks.executeCliTask.mockRejectedValueOnce(new Error('AccessDenied reading the source zip'))

    await expect(run(['production', '--from', 'staging'])).rejects.toThrow('process.exit(1)')

    expect(calls('FailCliStep')).toEqual([
      { stepId: 'stp_q7m2pd', error: 'AccessDenied reading the source zip' },
    ])
    expect(errors()).toContain('api: Deployment failed - There was an error while uploading.')
  })

  it('requires --from before calling the API', async () => {
    await expect(run(['production'])).rejects.toThrow('process.exit(1)')

    expect(errors()).toContain('A source is required.')
    expect(mocks.graphqlRequest).not.toHaveBeenCalled()
  })

  it.each([
    ['qa', 'staging'],
    ['production', '2'],
  ])('stops before promoting when %s or --from %s names no environment', async (target, from) => {
    await expect(run([target, '--from', from])).rejects.toThrow('process.exit(1)')

    expect(calls('PromoteVersion')).toEqual([])
    expect(errors()).toMatch(/Environment '(qa|2)' not found for this project\./)
  })

  it('surfaces the server message when the promote is refused', async () => {
    handlers.PromoteVersion = () => ({
      promoteVersion: { success: false, message: 'Build 12 has no package for eu-west-1.' },
    })

    await expect(run(['production', '--from', 'v12'])).rejects.toThrow('process.exit(1)')

    expect(errors()).toContain('Build 12 has no package for eu-west-1.')
    expect(calls('StartPromotedDeployment')).toEqual([])
  })

  it('reports a start that returns no deployments', async () => {
    handlers.StartPromotedDeployment = () => ({
      startDeployment: { success: true, message: 'Nothing to deploy', deploymentIds: [] },
    })

    await expect(run(['production', '--from', 'staging'])).rejects.toThrow('process.exit(1)')

    expect(errors()).toContain('Nothing to deploy')
  })

  it.each(['[]', '"project"', 'null', '42'])(
    'starts no deployment when the snapshot %s is not a JSON object',
    async (yamlSnapshot) => {
      handlers.PromoteVersion = () => ({
        promoteVersion: {
          success: true,
          newVersionId: 'w8fs2k',
          newVersionNumber: 12,
          yamlSnapshot,
        },
      })

      await expect(run(['production', '--from', 'staging'])).rejects.toThrow('process.exit(1)')

      expect(errors()).toContain('Version snapshot is invalid')
      expect(calls('StartPromotedDeployment')).toEqual([])
    }
  )
})
