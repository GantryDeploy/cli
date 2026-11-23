import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

import { graphqlRequest } from '../lib/client'
import { printError } from '../lib/output'

import { runLift } from './lift'
import { parseServicesFlag, previewSummary, readSourceRef, registerPreviewCommand } from './preview'

vi.mock(import('../lib/client'), async (importOriginal) => ({
  ...(await importOriginal()),
  graphqlRequest: vi.fn(),
}))
vi.mock(import('../lib/output'), async (importOriginal) => ({
  ...(await importOriginal()),
  printError: vi.fn(),
}))
vi.mock(import('./lift'), async (importOriginal) => ({
  ...(await importOriginal()),
  runLift: vi.fn(),
}))

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

const PROJECT_YAML = `type: project
id: prj_7f3k2m
services:
  web:
    type: http
environments:
  staging: {}
previews:
  frontend:
    environment: staging
    hostnames:
      staging.example.com: \${preview}.preview.example.com
`

const preview = {
  id: 'env_k3j9x2',
  slug: 'frontend-pr-123',
  template: 'frontend',
  name: 'pr-123',
  parentEnvironment: 'staging',
  services: ['web'],
  databases: 'shared',
  urls: ['https://pr-123.preview.example.com'],
  createdAt: '2026-11-23T09:00:00.000Z',
}

let workingDir: string
let logs: string[]
let exitSpy: MockInstance

function run(...args: string[]): Promise<Command> {
  const program = new Command().exitOverride()
  registerPreviewCommand(program)
  return program.parseAsync(['node', 'gantry', 'preview', ...args, '--cwd', workingDir])
}

beforeEach(() => {
  vi.clearAllMocks()
  workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-preview-'))
  fs.writeFileSync(path.join(workingDir, 'gantry.yml'), PROJECT_YAML)
  logs = []
  vi.spyOn(console, 'log').mockImplementation((line: string) => {
    logs.push(line)
  })
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new ExitError(code as number | undefined)
  })
})

afterEach(() => {
  fs.rmSync(workingDir, { recursive: true, force: true })
  exitSpy.mockRestore()
})

describe('gantry preview lift', () => {
  it('creates or finds the preview, then deploys it with the config the API resolved', async () => {
    vi.mocked(graphqlRequest).mockResolvedValue({
      liftPreviewEnvironment: {
        ok: true,
        errors: [],
        created: true,
        preview,
        resolved: {
          environment: 'frontend-pr-123',
          config: { environments: { 'frontend-pr-123': {} } },
          plan: { builds: [] },
        },
      },
    })

    await run('lift', 'frontend', '--as', 'pr-123', '--services', 'web')

    expect(vi.mocked(graphqlRequest).mock.calls[0][1]).toMatchObject({
      input: {
        projectId: 'prj_7f3k2m',
        template: 'frontend',
        name: 'pr-123',
        services: ['web'],
        yaml: PROJECT_YAML,
      },
    })
    expect(logs[0]).toBe('Preview frontend as pr-123 (from staging)')
    expect(vi.mocked(runLift)).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: 'frontend-pr-123',
        rawConfig: { environments: { 'frontend-pr-123': {} } },
        workingDir,
        quiet: false,
      })
    )
  })

  it('prints the API refusal and deploys nothing', async () => {
    vi.mocked(graphqlRequest).mockResolvedValue({
      liftPreviewEnvironment: {
        ok: false,
        errors: [
          {
            code: 'PLAN_LIMIT_REACHED',
            message: 'Your plan allows a maximum of 5 preview environments.',
            path: 'previews',
            suggestion: null,
          },
        ],
        created: null,
        preview: null,
        resolved: null,
      },
    })

    await expect(run('lift', 'frontend')).rejects.toThrow(ExitError)
    expect(vi.mocked(printError)).toHaveBeenCalledWith(
      'Your plan allows a maximum of 5 preview environments. (at previews)'
    )
    expect(vi.mocked(runLift)).not.toHaveBeenCalled()
  })

  it('prints only the preview as JSON with --json', async () => {
    vi.mocked(graphqlRequest).mockResolvedValue({
      liftPreviewEnvironment: {
        ok: true,
        errors: [],
        created: false,
        preview,
        resolved: { environment: 'frontend-pr-123', config: {}, plan: { builds: [] } },
      },
    })

    await run('lift', 'frontend', '--as', 'pr-123', '--json')

    expect(vi.mocked(runLift)).toHaveBeenCalledWith(expect.objectContaining({ quiet: true }))
    expect(logs).toHaveLength(1)
    expect(JSON.parse(logs[0])).toMatchObject({ created: false, slug: 'frontend-pr-123' })
  })
})

describe('gantry preview list', () => {
  it('lists the previews of a template', async () => {
    vi.mocked(graphqlRequest).mockResolvedValue({ previewEnvironments: [preview] })

    await run('list', 'frontend')

    expect(vi.mocked(graphqlRequest).mock.calls[0][1]).toEqual({
      projectId: 'prj_7f3k2m',
      template: 'frontend',
    })
    expect(logs[0]).toContain('pr-123')
    expect(logs[0]).toContain('https://pr-123.preview.example.com')
  })

  it('says so when there are none', async () => {
    vi.mocked(graphqlRequest).mockResolvedValue({ previewEnvironments: [] })

    await run('list')

    expect(logs).toEqual(['No previews.'])
  })
})

describe('gantry preview teardown', () => {
  it('tears the preview down by template and name', async () => {
    vi.mocked(graphqlRequest).mockResolvedValue({
      teardownPreviewEnvironment: {
        success: true,
        message: 'Tearing down frontend-pr-123.',
        teardownId: 'dep_7xq2mz',
      },
    })

    await run('teardown', 'frontend', '--as', 'pr-123')

    expect(vi.mocked(graphqlRequest).mock.calls[0][1]).toEqual({
      input: { projectId: 'prj_7f3k2m', template: 'frontend', name: 'pr-123' },
    })
  })

  it('needs --as', async () => {
    await expect(run('teardown', 'frontend')).rejects.toThrow(/--as/)
    expect(vi.mocked(graphqlRequest)).not.toHaveBeenCalled()
  })
})

describe('preview helpers', () => {
  it.each([
    [undefined, undefined],
    ['web', ['web']],
    ['web, api,', ['web', 'api']],
  ])('reads --services %s', (flag, services) => {
    expect(parseServicesFlag(flag)).toEqual(services)
  })

  it('summarises a preview with its database and URLs', () => {
    expect(previewSummary(preview)).toEqual([
      'Preview frontend as pr-123 (from staging)',
      '  services: web',
      '  database: shared with staging',
      '  https://pr-123.preview.example.com',
    ])
  })

  it('reads no source ref outside a git repository', () => {
    expect(readSourceRef(workingDir)).toBeUndefined()
  })
})
