import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

const graphqlRequest = vi.hoisted(() => vi.fn())
const select = vi.hoisted(() => vi.fn())

vi.mock('@inquirer/prompts', () => ({ select }))
vi.mock('../lib/client', () => ({
  formatApiError: (error: unknown) => (error instanceof Error ? error.message : 'API error'),
  graphqlRequest,
}))
vi.mock('../lib/interactive-prompts', () => ({
  selectEnvironment: vi.fn(),
  selectProject: vi.fn(),
}))

const { selectEnvironment, selectProject } = await import('../lib/interactive-prompts')
const { registerDeploymentsCommand } = await import('./deployments')

describe('deployments list', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('labels version choices with Version.number', async () => {
    graphqlRequest
      .mockResolvedValueOnce({
        versionsByProject: [
          { id: 'q7mx2v', number: 7, gitRef: 'main', createdAt: '2026-01-01T00:00:00Z' },
        ],
      })
      .mockResolvedValueOnce({ deploymentsByVersion: [] })
    select.mockResolvedValueOnce('q7mx2v')

    const program = new Command()
    registerDeploymentsCommand(program)
    await program.parseAsync([
      'node',
      'gantry',
      'deployments',
      'list',
      '--project',
      'p9ue62',
      '--environment',
      'e5rk2w',
    ])

    const query = String(graphqlRequest.mock.calls[0]?.[0])
    expect(query).toMatch(/\bnumber\b/)
    expect(query).not.toContain('versionNumber')

    const selectArgs = select.mock.calls[0]?.[0] as { choices: { name: string; value: string }[] }
    expect(selectArgs.choices).toEqual([{ name: 'v7 (main)', value: 'q7mx2v' }])
    expect(graphqlRequest.mock.calls[1]?.[1]).toEqual({ versionId: 'q7mx2v' })
  })
})

describe('deployments show', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('strips terminal control sequences from server-provided fields', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    graphqlRequest.mockResolvedValueOnce({
      deployment: {
        id: 'd3pw8k',
        status: 'failed',
        projectName: 'shop\x1b]0;title\x07',
        lastMessage: 'build \x1b[2J\x1b[1Afailed\x9b2K',
        startedAt: '2026-01-01T00:00:00Z',
      },
    })

    const program = new Command()
    registerDeploymentsCommand(program)
    await program.parseAsync(['node', 'gantry', 'deployments', 'show', 'd3pw8k'])

    const printed = logSpy.mock.calls.map((call) => String(call[0]))
    expect(printed).toContain('  Message:     build failed')
    expect(printed).toContain('  Project:     shop')
    for (const control of ['\x1b', '\x07', '\x9b']) {
      expect(printed.join('\n')).not.toContain(control)
    }
  })
})

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

describe('deployments commands', () => {
  let logSpy: MockInstance
  let errorSpy: MockInstance

  async function run(...args: string[]): Promise<void> {
    const program = new Command()
    program.exitOverride()
    registerDeploymentsCommand(program)
    await program.parseAsync(['node', 'gantry', 'deployments', ...args])
  }

  function printed(): string {
    return logSpy.mock.calls.map((call) => String(call[0])).join('\n')
  }

  function errors(): string {
    return errorSpy.mock.calls.flat().join(' ')
  }

  beforeEach(() => {
    vi.clearAllMocks()
    graphqlRequest.mockReset()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitError(code as number | undefined)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows every deployment field', async () => {
    graphqlRequest.mockResolvedValueOnce({
      deployment: {
        id: 'k7dm3s',
        status: 'complete',
        lastMessage: 'Deployment complete',
        environmentId: 'e5rk2w',
        environmentName: 'Production',
        projectName: 'shop',
        deploymentType: 'service',
        startedAt: '2026-03-04T10:00:00Z',
        completedAt: '2026-03-05T10:00:00Z',
      },
    })

    await run('show', 'k7dm3s')

    expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({ id: 'k7dm3s' })
    const lines = logSpy.mock.calls.map((call) => String(call[0]))
    expect(lines).toEqual([
      '\nDeployment: k7dm3s',
      '  Status:      COMPLETE',
      '  Type:        service',
      '  Project:     shop',
      '  Environment: Production',
      '  Message:     Deployment complete',
      '  Started:     Mar 4, 2026',
      '  Completed:   Mar 5, 2026',
    ])
  })

  it('shows placeholders for missing fields', async () => {
    graphqlRequest.mockResolvedValueOnce({
      deployment: { id: 'k7dm3s', status: 'pending', startedAt: '2026-03-04T10:00:00Z' },
    })

    await run('show', 'k7dm3s')

    expect(printed()).toContain('  Type:        -')
    expect(printed()).toContain('  Environment: -')
    expect(printed()).toContain('  Completed:   -')
  })

  it('exits when the deployment does not exist', async () => {
    graphqlRequest.mockResolvedValueOnce({ deployment: null })

    await expect(run('show', 'dep_missing')).rejects.toThrow(ExitError)

    expect(errors()).toContain('Deployment not found: dep_missing')
  })

  it('exits with the API error when show fails', async () => {
    graphqlRequest.mockRejectedValueOnce(new Error('Not authenticated'))

    await expect(run('show', 'k7dm3s')).rejects.toThrow('process.exit(1)')

    expect(errors()).toContain('Not authenticated')
  })

  it('lists deployments for an explicit version as a table', async () => {
    graphqlRequest.mockResolvedValueOnce({
      deploymentsByVersion: [
        {
          id: 'dep_web',
          status: 'complete',
          environmentName: 'Production',
          deploymentType: 'service',
          startedAt: '2026-03-04T10:00:00Z',
          completedAt: '2026-03-04T10:05:00Z',
        },
        { id: 'dep_rt', status: 'processing\x1b[2J', startedAt: '2026-03-04T10:00:00Z' },
      ],
    })

    await run('list', '--version', 'u3ky7b')

    expect(graphqlRequest).toHaveBeenCalledOnce()
    expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({ versionId: 'u3ky7b' })
    expect(select).not.toHaveBeenCalled()
    const output = printed()
    expect(output).toContain('dep_web')
    expect(output).toContain('COMPLETE')
    expect(output).toContain('Production')
    expect(output).toContain('dep_rt')
    expect(output).toContain('PROCESSING')
    expect(output).not.toContain('\x1b[2J')
  })

  it('prompts for project and environment when neither is given', async () => {
    vi.mocked(selectProject).mockResolvedValueOnce('p9ue62')
    vi.mocked(selectEnvironment).mockResolvedValueOnce('g3hm8p')
    graphqlRequest
      .mockResolvedValueOnce({
        versionsByProject: [{ id: 'r6tn4c', number: 1, createdAt: '2026-01-01T00:00:00Z' }],
      })
      .mockResolvedValueOnce({ deploymentsByVersion: [] })
    select.mockResolvedValueOnce('r6tn4c')

    await run('list')

    expect(selectEnvironment).toHaveBeenCalledWith('p9ue62')
    expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({
      projectId: 'p9ue62',
      environmentId: 'g3hm8p',
    })
    const selectArgs = select.mock.calls[0]?.[0] as { choices: { name: string }[] }
    expect(selectArgs.choices).toEqual([{ name: 'v1', value: 'r6tn4c' }])
    expect(printed()).toContain('No deployments found.')
  })

  it('stops when the environment has no versions', async () => {
    graphqlRequest.mockResolvedValueOnce({ versionsByProject: [] })

    await run('list', '--project', 'p9ue62', '--environment', 'g3hm8p')

    expect(printed()).toContain('No versions found.')
    expect(graphqlRequest).toHaveBeenCalledOnce()
    expect(select).not.toHaveBeenCalled()
  })

  it('exits with the API error when listing fails', async () => {
    graphqlRequest.mockRejectedValueOnce(new Error('Version not found'))

    await expect(run('list', '--version', 'ver_404')).rejects.toThrow('process.exit(1)')

    expect(errors()).toContain('Version not found')
  })

  it('cancels a deployment', async () => {
    graphqlRequest.mockResolvedValueOnce({ cancelDeployment: { success: true, message: null } })

    await run('cancel', 'k7dm3s')

    expect(graphqlRequest.mock.calls[0]?.[0]).toContain('cancelDeployment(id: $id)')
    expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({ id: 'k7dm3s' })
    expect(printed()).toContain('Deployment cancelled successfully')
  })

  it('exits with the server message when the deployment already finished', async () => {
    graphqlRequest.mockResolvedValueOnce({
      cancelDeployment: { success: false, message: 'Deployment is already complete' },
    })

    await expect(run('cancel', 'k7dm3s')).rejects.toThrow(ExitError)

    expect(errors()).toContain('Deployment is already complete')
    expect(printed()).not.toContain('cancelled successfully')
  })

  it('uses a generic message when a cancel refusal has none', async () => {
    graphqlRequest.mockResolvedValueOnce({ cancelDeployment: { success: false, message: null } })

    await expect(run('cancel', 'k7dm3s')).rejects.toThrow(ExitError)

    expect(errors()).toContain('Failed to cancel deployment')
  })

  it('exits with the API error when cancel fails', async () => {
    graphqlRequest.mockRejectedValueOnce(new Error('Forbidden'))

    await expect(run('cancel', 'k7dm3s')).rejects.toThrow('process.exit(1)')

    expect(errors()).toContain('Forbidden')
  })
})
