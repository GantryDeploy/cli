import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

import { printError } from '../lib/output'
import { resolveYaml } from '../lib/resolve-yaml'
import type { ResolveYamlResult } from '../lib/resolve-yaml'

import { registerResolveCommand } from './resolve'

vi.mock(import('../lib/resolve-yaml'), async (importOriginal) => ({
  ...(await importOriginal()),
  resolveYaml: vi.fn(),
}))
vi.mock('../lib/output', () => ({ printError: vi.fn() }))

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

const RESOLVED: ResolveYamlResult = {
  ok: true,
  config: { services: { web: { type: 'http' } } },
  sourceYaml: '',
  resolvedYaml: '',
  blueprintReference: '@gantry/nextjs:1',
  variableProvenance: {
    domain: { type: 'string', value: 'example.com', source: 'blueprint_variables' },
    replicas: { type: 'number', value: 2, source: 'env_override' },
    debug: { type: 'boolean', value: true, source: 'cli' },
  },
  plan: { services: [], routing: [] },
}

describe('resolve command', () => {
  let workingDir: string
  let stdout: MockInstance
  let stderr: MockInstance

  async function resolve(args: string[]) {
    const program = new Command()
    program.exitOverride()
    registerResolveCommand(program)
    await program.parseAsync(['node', 'gantry', 'resolve', ...args, '--cwd', workingDir])
  }

  function stderrText() {
    return stderr.mock.calls.map(([chunk]) => String(chunk)).join('')
  }

  beforeEach(() => {
    workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-resolve-'))
    fs.writeFileSync(path.join(workingDir, 'gantry.yml'), 'type: project\nid: p9ue62\n')
    vi.mocked(resolveYaml).mockReset().mockResolvedValue(RESOLVED)
    vi.mocked(printError).mockReset()
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitError(code as number | undefined)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(workingDir, { recursive: true, force: true })
  })

  it('prints the composed YAML to stdout and provenance to stderr', async () => {
    await resolve(['production', '--var', 'debug=true'])

    expect(resolveYaml).toHaveBeenCalledWith({
      yamlPath: path.join(workingDir, 'gantry.yml'),
      environment: 'production',
      cliVariables: { debug: 'true' },
    })
    expect(stdout).toHaveBeenCalledWith('services:\n  web:\n    type: http\n')
    const text = stderrText()
    expect(text).toContain('✓ Blueprint @gantry/nextjs:1 loaded\n✓ 3 variables resolved')
    expect(text).toContain('Variables (blueprint):\n  domain')
    expect(text).toContain('debug')
    expect(text).toContain('Variables (project):\n  replicas')
  })

  it('omits the blueprint line and empty tables for a plain project', async () => {
    vi.mocked(resolveYaml).mockResolvedValue({
      ...RESOLVED,
      blueprintReference: undefined,
      variableProvenance: {},
    })

    await resolve(['production'])

    expect(stderrText()).toBe('✓ 0 variables resolved\n\n')
  })

  it('writes to --output instead of stdout', async () => {
    await resolve(['production', '-o', 'resolved.yml'])

    expect(fs.readFileSync(path.join(workingDir, 'resolved.yml'), 'utf-8')).toBe(
      'services:\n  web:\n    type: http\n'
    )
    expect(stdout).not.toHaveBeenCalled()
    expect(stderrText()).toContain(
      `Wrote resolved YAML to ${path.join(workingDir, 'resolved.yml')}`
    )
  })

  it('exits when --output cannot be written', async () => {
    await expect(resolve(['production', '-o', 'missing-dir/out.yml'])).rejects.toThrow(ExitError)

    expect(printError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to write resolved YAML: ENOENT')
    )
  })

  it('prints resolution errors with hints to stderr and exits', async () => {
    vi.mocked(resolveYaml).mockResolvedValue({
      ok: false,
      errors: [
        { code: 'A', message: 'Unknown variable.', path: 'variables.x', suggestion: 'Declare it.' },
        { code: 'B', message: 'Invalid.', path: '' },
      ],
    })

    await expect(resolve(['production'])).rejects.toThrow(ExitError)

    expect(stderrText()).toBe('Unknown variable. (at variables.x)\n  hint: Declare it.\nInvalid.\n')
    expect(stdout).not.toHaveBeenCalled()
  })

  it('exits when there is no config file', async () => {
    fs.rmSync(path.join(workingDir, 'gantry.yml'))

    await expect(resolve(['production'])).rejects.toThrow(ExitError)
    expect(printError).toHaveBeenCalledWith(`No gantry.yml or gantry.yaml found in ${workingDir}`)
  })

  it('rejects a malformed --var', async () => {
    await expect(resolve(['production', '--var', 'x'])).rejects.toThrow(ExitError)
    expect(resolveYaml).not.toHaveBeenCalled()
  })

  it('reads the config from --file', async () => {
    await resolve(['production', '-f', 'custom.yml'])

    expect(vi.mocked(resolveYaml).mock.calls[0][0].yamlPath).toBe(
      path.join(workingDir, 'custom.yml')
    )
  })

  it('honours the global --cwd and repeated --var flags', async () => {
    const program = new Command().option('-C, --cwd <directory>')
    program.exitOverride()
    registerResolveCommand(program)

    await program.parseAsync([
      'node',
      'gantry',
      '-C',
      workingDir,
      'resolve',
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
  })

  it('defaults to the current directory', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(workingDir)
    const program = new Command()
    program.exitOverride()
    registerResolveCommand(program)

    await program.parseAsync(['node', 'gantry', 'resolve', 'production'])

    expect(resolveYaml).toHaveBeenCalledWith(
      expect.objectContaining({ yamlPath: path.join(workingDir, 'gantry.yml') })
    )
  })
})
