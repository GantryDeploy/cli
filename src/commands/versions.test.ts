import { stripVTControlCharacters } from 'util'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

const graphqlRequest = vi.hoisted(() => vi.fn())

vi.mock('../lib/client', () => ({
  formatApiError: (error: unknown) => (error instanceof Error ? error.message : 'API error'),
  graphqlRequest,
}))
vi.mock('../lib/interactive-prompts', () => ({
  selectEnvironment: vi.fn(),
  selectProject: vi.fn(),
}))

const { registerVersionsCommand } = await import('./versions')
const { selectEnvironment, selectProject } = await import('../lib/interactive-prompts')

describe('versions list', () => {
  let logSpy: MockInstance

  beforeEach(() => {
    vi.clearAllMocks()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('selects Version.number and prints it', async () => {
    graphqlRequest.mockResolvedValueOnce({
      versionsByProject: [
        { id: 'q7mx2v', number: 42, gitRef: 'main', createdAt: '2026-01-01T00:00:00Z' },
      ],
    })

    const program = new Command()
    registerVersionsCommand(program)
    await program.parseAsync([
      'node',
      'gantry',
      'versions',
      'list',
      '--project',
      'p9ue62',
      '--environment',
      'e5rk2w',
    ])

    const query = String(graphqlRequest.mock.calls[0]?.[0])
    expect(query).toMatch(/\bnumber\b/)
    expect(query).not.toContain('versionNumber')
    expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({
      projectId: 'p9ue62',
      environmentId: 'e5rk2w',
    })

    const output = String(logSpy.mock.calls[0]?.[0])
    expect(output).toContain('q7mx2v')
    expect(output).toContain('42')
  })
})

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

describe('versions list branches', () => {
  let logSpy: MockInstance
  let errorSpy: MockInstance

  async function run(...args: string[]): Promise<void> {
    const program = new Command()
    program.exitOverride()
    registerVersionsCommand(program)
    await program.parseAsync(['node', 'gantry', 'versions', 'list', ...args])
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

  it('prompts for the project and environment and prints a dash for a missing git ref', async () => {
    vi.mocked(selectProject).mockResolvedValueOnce('p9ue62')
    vi.mocked(selectEnvironment).mockResolvedValueOnce('g3hm8p')
    graphqlRequest.mockResolvedValueOnce({
      versionsByProject: [
        { id: 's9wd2f', number: 2, gitRef: null, createdAt: '2026-02-10T12:00:00Z' },
        { id: 'r6tn4c', number: 1, gitRef: 'v1.0.0', createdAt: '2026-02-01T12:00:00Z' },
      ],
    })

    await run()

    expect(selectEnvironment).toHaveBeenCalledWith('p9ue62')
    expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({
      projectId: 'p9ue62',
      environmentId: 'g3hm8p',
    })
    const output = stripVTControlCharacters(String(logSpy.mock.calls[0]?.[0]))
    expect(output).toMatch(/s9wd2f\s*│\s*2\s*│\s*-\s*│\s*Feb 10, 2026/)
    expect(output).toMatch(/r6tn4c\s*│\s*1\s*│\s*v1\.0\.0\s*│\s*Feb 1, 2026/)
  })

  it('says so when there are no versions', async () => {
    graphqlRequest.mockResolvedValueOnce({ versionsByProject: [] })

    await run('--project', 'p9ue62', '--environment', 'g3hm8p')

    expect(logSpy).toHaveBeenCalledWith('No versions found.')
    expect(selectProject).not.toHaveBeenCalled()
  })

  it('exits with the API error', async () => {
    graphqlRequest.mockRejectedValueOnce(new Error('Project not found'))

    await expect(run('--project', 'j2vq7r', '--environment', 'g3hm8p')).rejects.toThrow(
      'process.exit(1)'
    )

    expect(errorSpy.mock.calls.flat().join(' ')).toContain('Project not found')
  })
})
