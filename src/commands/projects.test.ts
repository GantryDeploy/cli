import { stripVTControlCharacters } from 'util'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

const graphqlRequest = vi.hoisted(() => vi.fn())
const input = vi.hoisted(() => vi.fn())
const select = vi.hoisted(() => vi.fn())

vi.mock('@inquirer/prompts', () => ({ input, select }))
vi.mock('../lib/client', () => ({
  formatApiError: (error: unknown) => (error instanceof Error ? error.message : 'API error'),
  graphqlRequest,
}))

const { registerProjectsCommand } = await import('./projects')

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

async function run(args: string[]): Promise<void> {
  const program = new Command()
  registerProjectsCommand(program)
  await program.parseAsync(['node', 'gantry', 'projects', ...args])
}

const project = {
  id: 'p9ue62',
  name: 'Storefront',
  slug: 'storefront',
  tag: 'ecommerce',
  cloudProvider: 'aws',
  createdAt: '2026-01-15T12:00:00Z',
}

describe('projects command', () => {
  let logSpy: MockInstance
  let errorSpy: MockInstance

  beforeEach(() => {
    vi.clearAllMocks()
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
    it('prints projects with a dash for a missing tag', async () => {
      graphqlRequest.mockResolvedValueOnce({
        projects: [
          project,
          { ...project, id: 'nth2lg', name: 'Blog\x1b]0;pwned\x07', slug: 'blog', tag: null },
        ],
      })

      await run([])

      expect(String(graphqlRequest.mock.calls[0]?.[0])).toContain('query GetProjects')
      expect(printed()).toContain('storefront')
      expect(printed()).toContain('ecommerce')
      expect(printed()).toContain('Blog')
      expect(stripVTControlCharacters(printed())).toMatch(/│ -\s+│/)
      expect(printed()).not.toContain('pwned')
    })

    it('reports when there are no projects', async () => {
      graphqlRequest.mockResolvedValueOnce({ projects: [] })

      await run([])

      expect(printed()).toBe('No projects found.')
    })

    it('prints the API error and exits non-zero', async () => {
      graphqlRequest.mockRejectedValueOnce(new Error('Unauthorized'))

      await expect(run([])).rejects.toThrow('process.exit(1)')

      expect(printedErrors()).toContain('Unauthorized')
    })
  })

  describe('show', () => {
    it('falls back to a slug lookup and prints details and environments', async () => {
      graphqlRequest
        .mockResolvedValueOnce({ project: null })
        .mockResolvedValueOnce({ project })
        .mockResolvedValueOnce({
          environments: [
            {
              id: 'e5rk2w',
              name: 'production',
              isProduction: true,
              createdAt: '2026-01-16T12:00:00Z',
            },
            {
              id: 'f8ty3n',
              name: 'staging',
              isProduction: false,
              createdAt: '2026-01-17T12:00:00Z',
            },
          ],
        })

      await run(['storefront'])

      expect(String(graphqlRequest.mock.calls[0]?.[0])).toContain('query GetProject(')
      expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({ id: 'storefront' })
      expect(graphqlRequest.mock.calls[1]?.[1]).toEqual({ slug: 'storefront' })
      expect(String(graphqlRequest.mock.calls[2]?.[0])).toContain('query GetProjectEnvironments')
      expect(graphqlRequest.mock.calls[2]?.[1]).toEqual({ projectId: project.id })
      expect(printed()).toContain('Project: Storefront')
      expect(printed()).toContain('Slug:           storefront')
      expect(printed()).toContain('Cloud Provider: aws')
      expect(printed()).toContain('Tag:            ecommerce')
      expect(printed()).toContain('Created:        Jan 15, 2026')
      expect(printed()).toContain('Environments:')
      expect(printed()).toContain('e5rk2w')
      expect(printed()).toContain('staging')
    })

    it('finds a project by its ID without a slug lookup, showing dashes and no environments', async () => {
      graphqlRequest
        .mockResolvedValueOnce({ project: { ...project, tag: null, cloudProvider: null } })
        .mockResolvedValueOnce({ environments: [] })

      await run(['p9ue62'])

      expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({ id: 'p9ue62' })
      expect(graphqlRequest.mock.calls[1]?.[1]).toEqual({ projectId: project.id })
      expect(printed()).toContain('Cloud Provider: -')
      expect(printed()).toContain('Tag:            -')
      expect(printed()).toContain('No environments found.')
    })

    it('strips terminal escapes from server fields', async () => {
      graphqlRequest
        .mockResolvedValueOnce({
          project: {
            ...project,
            name: 'Store\x1b]0;pwned\x07front',
            slug: 'storefront\x1b[2J',
            tag: 'tag\x1b[31m',
            cloudProvider: 'aws\x07',
          },
        })
        .mockResolvedValueOnce({
          environments: [
            {
              id: 'g3hm8p',
              name: 'prod\x1b]0;evil\x07',
              isProduction: true,
              createdAt: '2026-01-16T12:00:00Z',
            },
          ],
        })

      await run(['storefront'])

      expect(printed()).toContain('Project: Storefront')
      expect(printed()).not.toContain('pwned')
      expect(printed()).not.toContain('evil')
      expect(printed()).not.toContain('\x1b[2J')
      expect(printed()).not.toContain('\x07')
    })

    it('exits when neither the ID nor the slug lookup finds a project', async () => {
      graphqlRequest
        .mockResolvedValueOnce({ project: null })
        .mockResolvedValueOnce({ project: null })

      await expect(run(['ghost'])).rejects.toThrow('process.exit(1)')

      expect(printedErrors()).toContain('Project not found: ghost')
      expect(graphqlRequest).toHaveBeenCalledTimes(2)
      expect(graphqlRequest).toHaveBeenNthCalledWith(1, expect.any(String), { id: 'ghost' })
      expect(graphqlRequest).toHaveBeenNthCalledWith(2, expect.any(String), { slug: 'ghost' })
    })

    it('prints the API error when the lookup throws', async () => {
      graphqlRequest.mockRejectedValueOnce(new Error('Forbidden'))

      await expect(run(['storefront'])).rejects.toThrow('process.exit(1)')

      expect(printedErrors()).toContain('Forbidden')
    })
  })

  describe('create', () => {
    it('sends every flag without prompting', async () => {
      graphqlRequest.mockResolvedValueOnce({ createProject: { success: true, project } })

      await run(['create', '--name', 'Storefront', '--cloud-provider', 'aws', '--tag', 'ecommerce'])

      expect(input).not.toHaveBeenCalled()
      expect(select).not.toHaveBeenCalled()
      expect(String(graphqlRequest.mock.calls[0]?.[0])).toContain('mutation CreateProject')
      expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({
        input: { name: 'Storefront', cloudProvider: 'aws', tag: 'ecommerce' },
      })
      expect(printed()).toContain('Project created: Storefront (storefront)')
      expect(printed()).toContain(`ID: ${project.id}`)
    })

    it('prompts for missing values and drops a skipped tag', async () => {
      input.mockResolvedValueOnce('Edge App').mockResolvedValueOnce('')
      select.mockResolvedValueOnce('cloudflare')
      graphqlRequest.mockResolvedValueOnce({ createProject: { success: true, project } })

      await run(['create'])

      const { validate } = input.mock.calls[0]?.[0] as { validate: (v: string) => string | true }
      expect(validate(' ')).toBe('Name is required')
      expect(validate('x')).toBe(true)
      expect(select).toHaveBeenCalledWith(expect.objectContaining({ message: 'Cloud provider:' }))
      expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({
        input: { name: 'Edge App', cloudProvider: 'cloudflare', tag: undefined },
      })
    })

    it('strips terminal escapes from the returned ID', async () => {
      graphqlRequest.mockResolvedValueOnce({
        createProject: { success: true, project: { ...project, id: 'p9ue62\x1b]0;pwned\x07' } },
      })

      await run(['create', '--name', 'Storefront', '--cloud-provider', 'aws', '--tag', 'x'])

      expect(printed()).toContain('ID: p9ue62')
      expect(printed()).not.toContain('pwned')
    })

    it('exits with the server message when creation fails', async () => {
      graphqlRequest.mockResolvedValueOnce({
        createProject: { success: false, message: 'Project limit reached' },
      })

      await expect(
        run(['create', '--name', 'Storefront', '--cloud-provider', 'aws', '--tag', 'x'])
      ).rejects.toThrow('process.exit(1)')

      expect(printedErrors()).toContain('Project limit reached')
    })

    it('falls back to a generic message when no project is returned', async () => {
      graphqlRequest.mockResolvedValueOnce({ createProject: { success: true } })

      await expect(
        run(['create', '--name', 'Storefront', '--cloud-provider', 'aws', '--tag', 'x'])
      ).rejects.toThrow(ExitError)

      expect(printedErrors()).toContain('Failed to create project')
    })

    it('prints the API error when the mutation throws', async () => {
      graphqlRequest.mockRejectedValueOnce(new Error('Validation failed'))

      await expect(
        run(['create', '--name', 'Storefront', '--cloud-provider', 'aws', '--tag', 'x'])
      ).rejects.toThrow('process.exit(1)')

      expect(printedErrors()).toContain('Validation failed')
    })
  })
})
