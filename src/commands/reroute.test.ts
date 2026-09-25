import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  graphqlRequest: vi.fn(),
  resolveYaml: vi.fn(),
  printError: vi.fn(),
}))

vi.mock('../lib/client', () => ({
  formatApiError: (error: unknown) => (error instanceof Error ? error.message : 'API error'),
  graphqlRequest: mocks.graphqlRequest,
}))
vi.mock('../lib/resolve-yaml', () => ({ resolveYaml: mocks.resolveYaml }))
vi.mock('../lib/output', () => ({ printError: mocks.printError }))
vi.mock('../lib/listr', () => ({
  resolveRenderer: () => 'silent',
  shouldUseFallbackRenderer: () => false,
}))

const { registerRerouteCommand } = await import('./reroute')

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

const CONFIG = { type: 'project', environments: { production: {} } }

describe('reroute command', () => {
  let workingDir: string

  async function reroute(environment = 'production') {
    const program = new Command()
    program.exitOverride()
    registerRerouteCommand(program)
    const run = program.parseAsync(['node', 'gantry', 'reroute', environment, '--cwd', workingDir])
    const state = { settled: false }
    const markSettled = () => {
      state.settled = true
    }
    run.then(markSettled, markSettled)
    for (let i = 0; i < 200 && !state.settled; i++) {
      await vi.advanceTimersByTimeAsync(2000)
    }
    await run
  }

  function respond(...deployments: unknown[]) {
    mocks.graphqlRequest.mockImplementation((query: string) => {
      if (query.includes('TriggerReroute')) {
        return Promise.resolve({
          triggerReroute: {
            success: true,
            deploymentId: 'dep_r',
            versionId: 'r6tn4c',
            versionNumber: 4,
          },
        })
      }
      const next = deployments.length > 1 ? deployments.shift() : deployments[0]
      return next instanceof Error ? Promise.reject(next) : Promise.resolve({ deployment: next })
    })
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
    workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-reroute-'))
    fs.writeFileSync(path.join(workingDir, 'gantry.yml'), 'type: project\nid: p9ue62\n')
    for (const mock of Object.values(mocks)) mock.mockReset()
    mocks.resolveYaml.mockResolvedValue({ ok: true, config: CONFIG })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitError(code as number | undefined)
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    fs.rmSync(workingDir, { recursive: true, force: true })
  })

  it('posts the composed config and polls routing until it completes', async () => {
    respond({ id: 'dep_r', status: 'PROCESSING' }, new Error('socket hang up'), {
      id: 'dep_r',
      status: 'COMPLETE',
      lastMessage: 'done',
    })

    await reroute()

    expect(mocks.resolveYaml).toHaveBeenCalledWith({
      yamlPath: path.join(workingDir, 'gantry.yml'),
      environment: 'production',
    })
    expect(mocks.graphqlRequest.mock.calls[0][1]).toEqual({
      config: CONFIG,
      environment: 'production',
    })
    expect(mocks.graphqlRequest.mock.calls.slice(1).map((call) => call[1] as unknown)).toEqual([
      { id: 'dep_r' },
      { id: 'dep_r' },
      { id: 'dep_r' },
    ])
    expect(mocks.printError).not.toHaveBeenCalled()
  })

  it('reads gantry.yaml when there is no gantry.yml', async () => {
    fs.renameSync(path.join(workingDir, 'gantry.yml'), path.join(workingDir, 'gantry.yaml'))
    respond({ id: 'dep_r', status: 'COMPLETE' })

    await reroute()

    expect(mocks.resolveYaml).toHaveBeenCalledWith(
      expect.objectContaining({ yamlPath: path.join(workingDir, 'gantry.yaml') })
    )
  })

  it('treats a skipped routing deployment as settled', async () => {
    respond({ id: 'dep_r', status: 'SKIPPED' })

    await reroute()

    expect(mocks.printError).not.toHaveBeenCalled()
  })

  it('exits with the routing failure', async () => {
    respond({ id: 'dep_r', status: 'FAILED', lastMessage: 'no certificate' })

    await expect(reroute()).rejects.toThrow(ExitError)
    expect(mocks.printError).toHaveBeenCalledWith('Routing failed - no certificate')
  })

  it('times out when routing never settles', async () => {
    respond({ id: 'dep_r', status: 'PROCESSING' })

    await expect(reroute()).rejects.toThrow(ExitError)
    expect(mocks.printError).toHaveBeenCalledWith('Routing timed out after 5 minutes')
  })

  it('stops when the routing deployment disappears', async () => {
    respond(null)

    await reroute()

    expect(mocks.printError).not.toHaveBeenCalled()
  })

  it('exits with the server message when the reroute is refused', async () => {
    mocks.graphqlRequest.mockResolvedValue({
      triggerReroute: { success: false, message: 'No live version.' },
    })

    await expect(reroute()).rejects.toThrow(ExitError)
    expect(mocks.printError).toHaveBeenCalledWith('No live version.')
    expect(mocks.graphqlRequest).toHaveBeenCalledOnce()
  })

  it('exits on resolution errors without calling the API', async () => {
    mocks.resolveYaml.mockResolvedValue({
      ok: false,
      errors: [{ code: 'X', message: 'Bad config.', path: 'services' }],
    })

    await expect(reroute()).rejects.toThrow(ExitError)
    expect(mocks.printError).toHaveBeenCalledWith('Bad config. (at services)')
    expect(mocks.graphqlRequest).not.toHaveBeenCalled()
  })

  it('exits when there is no config file', async () => {
    fs.rmSync(path.join(workingDir, 'gantry.yml'))

    await expect(reroute()).rejects.toThrow(ExitError)
    expect(mocks.printError).toHaveBeenCalledWith(
      `No gantry.yml or gantry.yaml found in ${workingDir}`
    )
  })

  it('uses a generic message when a refusal carries none', async () => {
    mocks.graphqlRequest.mockResolvedValue({
      triggerReroute: { success: true, message: null, deploymentId: null },
    })

    await expect(reroute()).rejects.toThrow(ExitError)
    expect(mocks.printError).toHaveBeenCalledWith('Failed to trigger reroute')
  })

  it('reads gantry.yml from the current directory by default', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(workingDir)
    respond({ id: 'dep_r', status: 'COMPLETE' })
    const program = new Command()
    program.exitOverride()
    registerRerouteCommand(program)

    const run = program.parseAsync(['node', 'gantry', 'reroute', 'production', '-v'])
    await vi.advanceTimersByTimeAsync(4000)
    await run

    expect(mocks.resolveYaml).toHaveBeenCalledWith({
      yamlPath: path.join(workingDir, 'gantry.yml'),
      environment: 'production',
    })
    expect(mocks.printError).not.toHaveBeenCalled()
  })
})
