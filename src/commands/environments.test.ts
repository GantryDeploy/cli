import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

const graphqlRequest = vi.hoisted(() => vi.fn())
const input = vi.hoisted(() => vi.fn())
const select = vi.hoisted(() => vi.fn())
const selectCloud = vi.hoisted(() => vi.fn())
const selectNetwork = vi.hoisted(() => vi.fn())
const selectProject = vi.hoisted(() => vi.fn())
const selectRegion = vi.hoisted(() => vi.fn())

vi.mock('@inquirer/prompts', () => ({ input, select }))
vi.mock('../lib/client', () => ({
  formatApiError: (error: unknown) => (error instanceof Error ? error.message : 'API error'),
  graphqlRequest,
}))
vi.mock('../lib/interactive-prompts', () => ({
  selectCloud,
  selectNetwork,
  selectProject,
  selectRegion,
}))

const { registerEnvironmentsCommand } = await import('./environments')

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

async function run(args: string[]): Promise<void> {
  const program = new Command()
  registerEnvironmentsCommand(program)
  await program.parseAsync(['node', 'gantry', ...args])
}

function respondTo(responses: Record<string, unknown>): void {
  graphqlRequest.mockImplementation((query: string) => {
    const match = Object.keys(responses).find((name) => query.includes(name))
    return match ? Promise.resolve(responses[match]) : Promise.reject(new Error('unexpected'))
  })
}

describe('environments command', () => {
  let logSpy: MockInstance
  let errorSpy: MockInstance

  beforeEach(() => {
    vi.clearAllMocks()
    graphqlRequest.mockReset()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitError(typeof code === 'number' ? code : undefined)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function printed(): string {
    return logSpy.mock.calls.map((call) => String(call[0])).join('\n')
  }

  function printedErrors(): string {
    return errorSpy.mock.calls.map((call) => String(call[0])).join('\n')
  }

  describe('list', () => {
    it('filters by project and joins project names into the table', async () => {
      respondTo({
        'query GetEnvironments(': {
          environments: [
            {
              id: 'e5rk2w',
              projectId: 'p9ue62',
              name: 'production\x1b]0;pwned\x07',
              isProduction: true,
              createdAt: '2026-04-01T12:00:00Z',
            },
            {
              id: 'env_orphan',
              projectId: 'w4kz8c',
              name: 'preview',
              isProduction: false,
              createdAt: '2026-04-02T12:00:00Z',
            },
          ],
        },
        'query GetEnvironmentProjects': { projects: [{ id: 'p9ue62', name: 'Storefront' }] },
      })

      await run(['envs', 'list', '--project', 'p9ue62'])

      const envCall = graphqlRequest.mock.calls.find((call) =>
        String(call[0]).includes('query GetEnvironments(')
      )
      expect(envCall?.[1]).toEqual({ projectId: 'p9ue62' })
      expect(printed()).toContain('Storefront (p9ue62)')
      expect(printed()).toContain('Unknown (w4kz8c)')
      expect(printed()).toContain('✓')
      expect(printed()).toContain('✗')
      expect(printed()).not.toContain('pwned')
    })

    it('sends no filter via the environments alias and reports an empty list', async () => {
      respondTo({
        'query GetEnvironments(': { environments: [] },
        'query GetEnvironmentProjects': { projects: [] },
      })

      await run(['environments', 'list'])

      const envCall = graphqlRequest.mock.calls.find((call) =>
        String(call[0]).includes('query GetEnvironments(')
      )
      expect(envCall?.[1]).toEqual({})
      expect(printed()).toBe('No environments found.')
    })

    it('prints the API error and exits non-zero', async () => {
      graphqlRequest.mockRejectedValue(new Error('Unauthorized'))

      await expect(run(['envs', 'list'])).rejects.toThrow('process.exit(1)')

      expect(printedErrors()).toContain('Unauthorized')
    })
  })

  describe('create', () => {
    const created = {
      success: true,
      environment: { id: 'env_new', name: 'Staging', createdAt: '2026-04-01T12:00:00Z' },
    }

    it('sends every flag without prompting', async () => {
      graphqlRequest.mockResolvedValueOnce({ createEnvironment: created })

      await run([
        'envs',
        'create',
        '--project',
        'p9ue62',
        '--cloud',
        'cloud_1',
        '--region',
        'us-east-1',
        '--name',
        'Staging',
        '--slug',
        'stg',
        '--network',
        'h4nw8r',
        '--color',
        'blue',
        '--production',
      ])

      expect(input).not.toHaveBeenCalled()
      expect(select).not.toHaveBeenCalled()
      expect(String(graphqlRequest.mock.calls[0]?.[0])).toContain('mutation CreateEnvironment')
      expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({
        input: {
          projectId: 'p9ue62',
          cloudAccountId: 'cloud_1',
          region: 'us-east-1',
          name: 'Staging',
          slug: 'stg',
          networkId: 'h4nw8r',
          color: 'blue',
          isProduction: true,
        },
      })
      expect(printed()).toContain('Environment created: Staging')
      expect(printed()).toContain('ID: env_new')
    })

    it('prompts for everything and drops a skipped colour', async () => {
      selectProject.mockResolvedValueOnce('p9ue62')
      selectCloud.mockResolvedValueOnce('cloud_1')
      selectRegion.mockResolvedValueOnce('eu-west-1')
      input.mockResolvedValueOnce('QA Env').mockResolvedValueOnce('')
      selectNetwork.mockResolvedValueOnce(undefined)
      select.mockResolvedValueOnce(false)
      graphqlRequest.mockResolvedValueOnce({ createEnvironment: created })

      await run(['envs', 'create'])

      const { validate } = input.mock.calls[0]?.[0] as { validate: (v: string) => string | true }
      expect(validate('')).toBe('Name is required')
      expect(validate('QA')).toBe(true)
      expect(selectNetwork).toHaveBeenCalledWith('cloud_1', { allowNone: true })
      expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({
        input: {
          projectId: 'p9ue62',
          cloudAccountId: 'cloud_1',
          region: 'eu-west-1',
          name: 'QA Env',
          slug: 'qa-env',
          networkId: undefined,
          color: undefined,
          isProduction: false,
        },
      })
    })

    it('strips terminal escapes from the returned ID', async () => {
      graphqlRequest.mockResolvedValueOnce({
        createEnvironment: {
          ...created,
          environment: { ...created.environment, id: 'env_new\x1b]0;pwned\x07' },
        },
      })

      await run(fullFlags())

      expect(printed()).toContain('ID: env_new')
      expect(printed()).not.toContain('pwned')
    })

    it('exits with the server message when creation fails', async () => {
      graphqlRequest.mockResolvedValueOnce({
        createEnvironment: { success: false, message: 'Slug already taken' },
      })

      await expect(run(fullFlags())).rejects.toThrow('process.exit(1)')

      expect(printedErrors()).toContain('Slug already taken')
    })

    it('falls back to a generic message when no environment is returned', async () => {
      graphqlRequest.mockResolvedValueOnce({ createEnvironment: { success: true } })

      await expect(run(fullFlags())).rejects.toThrow(ExitError)

      expect(printedErrors()).toContain('Failed to create environment')
    })

    it('prints the API error when the mutation throws', async () => {
      graphqlRequest.mockRejectedValueOnce(new Error('Project not found'))

      await expect(run(fullFlags())).rejects.toThrow('process.exit(1)')

      expect(printedErrors()).toContain('Project not found')
    })
  })
})

function fullFlags(): string[] {
  return [
    'envs',
    'create',
    '--project',
    'p9ue62',
    '--cloud',
    'cloud_1',
    '--region',
    'us-east-1',
    '--name',
    'Staging',
    '--network',
    'h4nw8r',
    '--color',
    'green',
    '--production',
  ]
}
