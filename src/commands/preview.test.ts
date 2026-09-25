import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

import { printError } from '../lib/output'
import { resolveYaml } from '../lib/resolve-yaml'
import type { ResolveYamlResult } from '../lib/resolve-yaml'
import type { DeploymentPlan } from '../types'

import { registerPreviewCommand } from './preview'

vi.mock(import('../lib/resolve-yaml'), async (importOriginal) => ({
  ...(await importOriginal()),
  resolveYaml: vi.fn(),
}))
vi.mock(import('../lib/output'), async (importOriginal) => ({
  ...(await importOriginal()),
  printError: vi.fn(),
}))

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

function withPlan(plan: DeploymentPlan): ResolveYamlResult {
  return {
    ok: true,
    config: {},
    sourceYaml: '',
    resolvedYaml: '',
    variableProvenance: {},
    plan,
  }
}

describe('preview command', () => {
  let workingDir: string
  let logSpy: MockInstance

  async function preview(args: string[]) {
    const program = new Command()
    program.exitOverride()
    registerPreviewCommand(program)
    await program.parseAsync(['node', 'gantry', 'preview', ...args, '--cwd', workingDir])
  }

  function output() {
    return logSpy.mock.calls.map(([line]) => String(line ?? '')).join('\n')
  }

  beforeEach(() => {
    workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-preview-'))
    fs.writeFileSync(path.join(workingDir, 'gantry.yml'), 'type: project\nid: p9ue62\n')
    vi.mocked(resolveYaml).mockReset()
    vi.mocked(printError).mockReset()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitError(code as number | undefined)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(workingDir, { recursive: true, force: true })
  })

  it('renders services and the routing tree with each path’s hop chain', async () => {
    vi.mocked(resolveYaml).mockResolvedValue(
      withPlan({
        services: [
          { name: 'web', type: 'http', deploymentType: 'lambda', source: 'build', cluster: null },
          { name: 'api', type: 'http', deploymentType: 'ecs', source: 'build', cluster: 'main' },
        ],
        routing: [
          {
            domain: 'example.com',
            entryType: 'cloudfront',
            loadBalancer: 'edge-alb',
            paths: [
              {
                path: '/api',
                service: 'api',
                deploymentType: 'ecs',
                routeHops: ['cloudfront', 'alb', 'ecs'],
              },
              { path: '/', service: 'web', deploymentType: 'lambda', routeHops: [] },
            ],
          },
        ],
      })
    )

    await preview(['production'])

    const text = output()
    expect(text).toContain('Deployment Preview\x1b[0m: production')
    expect(text).toMatch(/web.*lambda.*build/)
    expect(text).toMatch(/api.*ecs.*build.*main/)
    expect(text).toContain('example.com\x1b[0m \x1b[2m[cloudfront (lb: edge-alb)]')
    expect(text).toContain('CloudFront → ALB → ECS')
    expect(text).toContain('└── \x1b[2mcloudfront\x1b[0m')
  })

  it('says so when the environment has no routing', async () => {
    vi.mocked(resolveYaml).mockResolvedValue(withPlan({ services: [], routing: [] }))

    await preview(['staging'])

    expect(output()).toContain('No routing configured for this environment.')
  })

  it('prints resolution errors and exits', async () => {
    vi.mocked(resolveYaml).mockResolvedValue({
      ok: false,
      errors: [{ code: 'X', message: 'Environment not declared.', path: 'environments' }],
    })

    await expect(preview(['qa'])).rejects.toThrow(ExitError)
    expect(printError).toHaveBeenCalledWith('Environment not declared. (at environments)')
  })

  it('exits when there is no config file', async () => {
    fs.rmSync(path.join(workingDir, 'gantry.yml'))

    await expect(preview(['production'])).rejects.toThrow(ExitError)
    expect(resolveYaml).not.toHaveBeenCalled()
  })

  it('rejects a malformed --var', async () => {
    await expect(preview(['production', '--var', 'nope'])).rejects.toThrow(ExitError)
    expect(printError).toHaveBeenCalledWith('Invalid --var "nope". Expected key=value.')
  })

  it('reads the config from --file and passes --var through', async () => {
    vi.mocked(resolveYaml).mockResolvedValue(withPlan({ services: [], routing: [] }))

    await preview(['production', '-f', 'alt.yml', '--var', 'a=b'])

    expect(resolveYaml).toHaveBeenCalledWith({
      yamlPath: path.join(workingDir, 'alt.yml'),
      environment: 'production',
      cliVariables: { a: 'b' },
    })
  })

  it('honours the global --cwd and repeated --var flags', async () => {
    vi.mocked(resolveYaml).mockResolvedValue(
      withPlan({
        services: [],
        routing: [
          {
            domain: 'shop.example.com',
            entryType: 'cloudfront',
            loadBalancer: null,
            paths: [{ path: '/', service: 'web', deploymentType: 'lambda', routeHops: [] }],
          },
        ],
      })
    )
    const program = new Command().option('-C, --cwd <directory>')
    program.exitOverride()
    registerPreviewCommand(program)

    await program.parseAsync([
      'node',
      'gantry',
      '-C',
      workingDir,
      'preview',
      'production',
      '--var',
      'a=1',
      '--var',
      'b=2',
    ])

    expect(resolveYaml).toHaveBeenCalledWith({
      yamlPath: path.join(workingDir, 'gantry.yml'),
      environment: 'production',
      cliVariables: { a: '1', b: '2' },
    })
    expect(output()).toContain('shop.example.com\x1b[0m \x1b[2m[cloudfront]')
  })

  it('defaults to the current directory', async () => {
    vi.mocked(resolveYaml).mockResolvedValue(withPlan({ services: [], routing: [] }))
    vi.spyOn(process, 'cwd').mockReturnValue(workingDir)
    const program = new Command()
    program.exitOverride()
    registerPreviewCommand(program)

    await program.parseAsync(['node', 'gantry', 'preview', 'production'])

    expect(resolveYaml).toHaveBeenCalledWith(
      expect.objectContaining({ yamlPath: path.join(workingDir, 'gantry.yml') })
    )
  })
})
