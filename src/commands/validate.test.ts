import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

import { printError, printSuccess } from '../lib/output'
import { environmentNamesIn, resolveAllEnvironments, resolveYaml } from '../lib/resolve-yaml'

import { registerValidateCommand } from './validate'

vi.mock(import('../lib/resolve-yaml'), async (importOriginal) => ({
  ...(await importOriginal()),
  resolveAllEnvironments: vi.fn(),
  resolveYaml: vi.fn(),
}))
vi.mock('../lib/output', () => ({ printError: vi.fn(), printSuccess: vi.fn() }))

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

describe('validate command', () => {
  let workingDir: string
  let exitSpy: MockInstance

  async function validate(args: string[] = []) {
    const program = new Command()
    program.exitOverride()
    registerValidateCommand(program)
    await program.parseAsync(['node', 'gantry', 'validate', '--cwd', workingDir, ...args])
  }

  beforeEach(() => {
    workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-validate-'))
    fs.writeFileSync(path.join(workingDir, 'gantry.yml'), 'type: project\nid: p9ue62\n')
    vi.mocked(resolveYaml).mockReset()
    vi.mocked(resolveAllEnvironments).mockReset()
    vi.mocked(printError).mockReset()
    vi.mocked(printSuccess).mockReset()
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitError(code as number | undefined)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(workingDir, { recursive: true, force: true })
  })

  it('validates every environment in one request', async () => {
    vi.mocked(resolveAllEnvironments).mockResolvedValue({
      ok: true,
      environments: ['production', 'staging'],
    })

    await validate(['--var', 'domain=example.com'])

    expect(resolveAllEnvironments).toHaveBeenCalledWith({
      yamlPath: path.join(workingDir, 'gantry.yml'),
      cliVariables: { domain: 'example.com' },
    })
    expect(printSuccess).toHaveBeenCalledWith('gantry.yml is valid (2 environments)')
  })

  it('names the environment when there is only one', async () => {
    vi.mocked(resolveAllEnvironments).mockResolvedValue({ ok: true, environments: ['production'] })

    await validate()

    expect(printSuccess).toHaveBeenCalledWith('gantry.yml is valid (production)')
  })

  it('fails when the file declares no environments', async () => {
    vi.mocked(resolveAllEnvironments).mockResolvedValue({ ok: true, environments: [] })

    await expect(validate()).rejects.toThrow(ExitError)
    expect(printError).toHaveBeenCalledWith('gantry.yml declares no environments')
  })

  it('prints every error and exits non-zero', async () => {
    vi.mocked(resolveAllEnvironments).mockResolvedValue({
      ok: false,
      errors: [{ code: 'PROJECT_ID_MISMATCH', message: 'Mismatch.', path: 'id' }],
    })

    await expect(validate()).rejects.toThrow(ExitError)
    expect(printError).toHaveBeenCalledWith('Mismatch. (at id)')
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(printSuccess).not.toHaveBeenCalled()
  })

  it('validates a single environment from --file', async () => {
    fs.writeFileSync(path.join(workingDir, 'other.yml'), 'type: project\n')
    vi.mocked(resolveYaml).mockResolvedValue({
      ok: true,
      config: {},
      sourceYaml: '',
      resolvedYaml: '',
      variableProvenance: {},
      plan: { services: [], routing: [] },
    })

    await validate(['-e', 'staging', '-f', 'other.yml'])

    expect(resolveYaml).toHaveBeenCalledWith({
      yamlPath: path.join(workingDir, 'other.yml'),
      environment: 'staging',
      cliVariables: {},
    })
    expect(resolveAllEnvironments).not.toHaveBeenCalled()
    expect(printSuccess).toHaveBeenCalledWith('other.yml is valid (staging)')
  })

  it('names the invalid environment before its errors', async () => {
    vi.mocked(resolveYaml).mockResolvedValue({
      ok: false,
      errors: [{ code: 'X', message: 'Bad.', path: '' }],
    })

    await expect(validate(['-e', 'staging'])).rejects.toThrow(ExitError)
    expect(vi.mocked(printError).mock.calls).toEqual([
      ['Environment "staging" is invalid:'],
      ['Bad.'],
    ])
  })

  it('exits when there is no config file', async () => {
    fs.rmSync(path.join(workingDir, 'gantry.yml'))

    await expect(validate()).rejects.toThrow(ExitError)
    expect(printError).toHaveBeenCalledWith(`No gantry.yml or gantry.yaml found in ${workingDir}`)
  })

  it('rejects a malformed --var', async () => {
    await expect(validate(['--var', '=x'])).rejects.toThrow(ExitError)
    expect(printError).toHaveBeenCalledWith('Invalid --var "=x". Expected key=value.')
    expect(resolveAllEnvironments).not.toHaveBeenCalled()
  })

  it('honours the global --cwd and repeated --var flags', async () => {
    vi.mocked(resolveAllEnvironments).mockResolvedValue({ ok: true, environments: ['production'] })
    const program = new Command().option('-C, --cwd <directory>')
    program.exitOverride()
    registerValidateCommand(program)

    await program.parseAsync([
      'node',
      'gantry',
      '-C',
      workingDir,
      'validate',
      '--var',
      'a=1',
      '--var',
      'b=2',
    ])

    expect(resolveAllEnvironments).toHaveBeenCalledWith({
      yamlPath: path.join(workingDir, 'gantry.yml'),
      cliVariables: { a: '1', b: '2' },
    })
  })

  it('defaults to the current directory', async () => {
    vi.mocked(resolveAllEnvironments).mockResolvedValue({ ok: true, environments: ['production'] })
    vi.spyOn(process, 'cwd').mockReturnValue(workingDir)
    const program = new Command()
    program.exitOverride()
    registerValidateCommand(program)

    await program.parseAsync(['node', 'gantry', 'validate'])

    expect(resolveAllEnvironments).toHaveBeenCalledWith(
      expect.objectContaining({ yamlPath: path.join(workingDir, 'gantry.yml') })
    )
  })
})

describe('environmentNamesIn', () => {
  it('finds every environment key', () => {
    const yaml = `
type: project
id: cb_123
environments:
  staging:
    services: {}
  production:
    services: {}
`
    expect(environmentNamesIn(yaml)).toEqual(['staging', 'production'])
  })

  it('stops at the next top-level key', () => {
    const yaml = `
environments:
  production:
    services: {}
services:
  web:
    type: http
`
    expect(environmentNamesIn(yaml)).toEqual(['production'])
  })

  it('ignores nested keys at deeper indentation', () => {
    const yaml = `
environments:
  production:
    services:
      web:
        cluster: prod-ecs
    routing:
      - domain: example.com
`
    expect(environmentNamesIn(yaml)).toEqual(['production'])
  })

  it('returns nothing when there is no environments block', () => {
    expect(environmentNamesIn('type: project\nid: cb_123\n')).toEqual([])
  })

  it('returns nothing for a malformed document rather than throwing', () => {
    // The scan runs before validation, so it cannot assume the file parses.
    expect(environmentNamesIn(': : :\n\t\n')).toEqual([])
  })

  it('tolerates a trailing comment on the environments key', () => {
    const yaml = `
environments: # per-env overrides
  production:
    services: {}
`
    expect(environmentNamesIn(yaml)).toEqual(['production'])
  })

  it('does not treat a list item as an environment name', () => {
    const yaml = `
environments:
  production:
    routing:
      - domain: example.com
  staging:
    services: {}
`
    expect(environmentNamesIn(yaml)).toEqual(['production', 'staging'])
  })
})
