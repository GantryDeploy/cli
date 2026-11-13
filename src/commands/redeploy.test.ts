import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

const mocks = vi.hoisted(() => ({
  graphqlRequest: vi.fn(),
}))

vi.mock(import('../lib/client'), async (importOriginal) => ({
  ...(await importOriginal()),
  graphqlRequest: mocks.graphqlRequest,
}))
vi.mock('../lib/listr', () => ({
  resolveRenderer: () => 'silent',
  shouldUseFallbackRenderer: () => false,
}))
vi.mock('../lib/project-identity', () => ({
  loadProjectIdentity: () => ({ id: 'p9ue62' }),
}))

const { registerRedeployCommand } = await import('./redeploy')

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

type Handler = (variables: Record<string, unknown>) => unknown

const SNAPSHOT = '{"type":"project","services":{"web":{"type":"http"}}}'

describe('redeploy command', () => {
  let handlers: Record<string, Handler>
  let exitSpy: MockInstance
  let errorSpy: MockInstance

  function calls(operation: string): unknown[] {
    return mocks.graphqlRequest.mock.calls
      .filter(([query]) => String(query).includes(`${operation}(`))
      .map(([, variables]) => variables as unknown)
  }

  async function run(args: string[]): Promise<void> {
    const program = new Command()
    program.exitOverride()
    registerRedeployCommand(program)
    const pending = program.parseAsync(['node', 'gantry', 'redeploy', ...args])
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
    handlers = {
      RedeployVersion: () => ({
        redeployVersion: {
          success: true,
          message: 'Redeploying v12',
          newVersionId: 'x4hd7n',
          newVersionNumber: 12,
          yamlSnapshot: SNAPSHOT,
        },
      }),
      StartVersionDeployment: () => ({
        startDeployment: {
          success: true,
          message: null,
          deploymentIds: ['dep_web'],
          versionId: 'x4hd7n',
        },
      }),
      DeploymentsByVersion: () => ({
        deploymentsByVersion: [
          { id: 'dep_web', serviceName: 'web', status: 'COMPLETE', steps: [] },
          {
            id: 'dep_routing',
            scope: 'project-env',
            serviceName: null,
            status: 'RUNNING',
            steps: [],
          },
        ],
      }),
      GetRoutingDeployment: () => ({
        deployment: { id: 'dep_routing', status: 'COMPLETE', lastMessage: null },
      }),
      VersionRouteUrls: () => ({
        versionRouteUrls: [
          {
            url: 'https://shop.example.com/',
            domain: 'shop.example.com',
            path: '/',
            serviceName: 'web',
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

  it("deploys the environment's live build again with its own configuration", async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await run(['Production'])

    expect(calls('RedeployVersion')).toEqual([
      { input: { projectId: 'p9ue62', environment: 'Production' } },
    ])
    expect(calls('StartVersionDeployment')).toEqual([
      {
        environment: 'production',
        config: { type: 'project', services: { web: { type: 'http' } } },
        versionId: 'x4hd7n',
        options: { skipPreDeploy: false, skipPostDeploy: false },
      },
    ])
    expect(logSpy.mock.calls.flat().join('\n')).toContain('https://shop.example.com/')
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it.each([
    [['--skip-pre-deploy'], { skipPreDeploy: true, skipPostDeploy: false }],
    [['--skip-post-deploy'], { skipPreDeploy: false, skipPostDeploy: true }],
  ])('sends the deploy command skips for %j', async (flags, options) => {
    await run(['production', ...flags])

    expect(calls('StartVersionDeployment')).toEqual([expect.objectContaining({ options })])
  })

  it('refuses --skip-post-deploy with --post-deploy-async before redeploying', async () => {
    await expect(run(['production', '--skip-post-deploy', '--post-deploy-async'])).rejects.toThrow(
      /cannot be used with/
    )

    expect(calls('RedeployVersion')).toHaveLength(0)
  })

  it("exits with the API's reason when the environment can't be redeployed", async () => {
    handlers.RedeployVersion = () => ({
      redeployVersion: { success: false, message: 'production has no live version to redeploy.' },
    })

    await expect(run(['production'])).rejects.toThrow('process.exit(1)')

    expect(errorSpy.mock.calls.flat().join(' ')).toContain(
      'production has no live version to redeploy.'
    )
    expect(calls('StartVersionDeployment')).toHaveLength(0)
  })
})
