import * as fs from 'fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { printError } from './output'
import {
  exitWithResolutionErrors,
  findConfigPath,
  loadProjectIdentity,
  resolveEnvironmentSlug,
} from './project-identity'

vi.mock('fs')
vi.mock('./output', () => ({ printError: vi.fn() }))

/** The blueprint supplies `services:`, so the local file declares none. */
const BLUEPRINT_PROJECT = `
type: project
id: k4rt7n
blueprint: "@gantry/nextjs:1"
blueprint_variables:
  domain: app.example.com
environments:
  production: {}
  Staging: {}
`

const PLAIN_PROJECT = `
type: project
id: 63wqfr
services:
  web:
    type: http
    port: 3000
environments:
  production:
    services:
      web:
        cluster: main
`

function mockConfigFile(contents: string, filename = 'gantry.yml') {
  vi.mocked(fs.existsSync).mockImplementation((p) => String(p).endsWith(filename))
  vi.mocked(fs.readFileSync).mockReturnValue(contents)
}

describe('loadProjectIdentity', () => {
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit')
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    exit.mockClear()
  })

  it('reads a blueprint-using project that declares no services', () => {
    mockConfigFile(BLUEPRINT_PROJECT)

    expect(loadProjectIdentity('/app')).toEqual({
      id: 'k4rt7n',
      environments: ['production', 'Staging'],
    })
  })

  it('reads a plain project the same way', () => {
    mockConfigFile(PLAIN_PROJECT)

    expect(loadProjectIdentity('/app')).toEqual({
      id: '63wqfr',
      environments: ['production'],
    })
  })

  it('needs no network or credentials, so a deleted blueprint cannot block it', () => {
    mockConfigFile(BLUEPRINT_PROJECT)

    // The blueprint is never fetched; identity comes from the local file alone.
    expect(loadProjectIdentity('/app').id).toBe('k4rt7n')
  })

  it('accepts gantry.yaml as well as gantry.yml', () => {
    mockConfigFile(BLUEPRINT_PROJECT, 'gantry.yaml')

    expect(loadProjectIdentity('/app').id).toBe('k4rt7n')
  })

  it('exits when no config file is present', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)

    expect(() => loadProjectIdentity('/app')).toThrow('process.exit')
  })

  it('exits on a project missing type: project', () => {
    mockConfigFile('id: zx8n3d\nenvironments:\n  production: {}\n')

    expect(() => loadProjectIdentity('/app')).toThrow('process.exit')
  })

  it('exits on a project missing an id', () => {
    mockConfigFile('type: project\nenvironments:\n  production: {}\n')

    expect(() => loadProjectIdentity('/app')).toThrow('process.exit')
  })
})

describe('resolveEnvironmentSlug', () => {
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit')
  })

  const identity = { id: 'k4rt7n', environments: ['production', 'Staging'] }

  afterEach(() => {
    exit.mockClear()
  })

  it('matches an exact slug', () => {
    expect(resolveEnvironmentSlug(identity, 'production')).toBe('production')
  })

  it('matches case-insensitively and returns the declared spelling', () => {
    expect(resolveEnvironmentSlug(identity, 'staging')).toBe('Staging')
    expect(resolveEnvironmentSlug(identity, 'PRODUCTION')).toBe('production')
  })

  it('exits on an environment the project does not declare', () => {
    expect(() => resolveEnvironmentSlug(identity, 'nope')).toThrow('process.exit')
  })
})

describe('findConfigPath', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('prefers gantry.yml over gantry.yaml', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)

    expect(findConfigPath('/app')).toBe('/app/gantry.yml')
  })

  it('returns null when neither exists', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)

    expect(findConfigPath('/app')).toBeNull()
  })
})

describe('loadProjectIdentity read failures', () => {
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit')
  })

  afterEach(() => {
    exit.mockClear()
    vi.mocked(printError).mockClear()
  })

  it('exits with the read error when the file cannot be read', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('EACCES: permission denied')
    })

    expect(() => loadProjectIdentity('/app')).toThrow('process.exit')
    expect(printError).toHaveBeenCalledWith(
      'Failed to read /app/gantry.yml: EACCES: permission denied'
    )
  })

  it('uses a generic reason when the read throws a non-Error', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw 'nope' as unknown as Error
    })

    expect(() => loadProjectIdentity('/app')).toThrow('process.exit')
    expect(printError).toHaveBeenCalledWith('Failed to read /app/gantry.yml: Unknown error')
  })
})

describe('exitWithResolutionErrors', () => {
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit')
  })
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

  afterEach(() => {
    exit.mockClear()
    stderr.mockClear()
    vi.mocked(printError).mockClear()
  })

  it('prints every error with its path and hint, then exits 1', () => {
    expect(() =>
      exitWithResolutionErrors([
        { code: 'A', message: 'Unknown variable.', path: 'variables.x', suggestion: 'Declare it.' },
        { code: 'B', message: 'Invalid YAML.', path: '' },
      ])
    ).toThrow('process.exit')

    expect(vi.mocked(printError).mock.calls).toEqual([
      ['Unknown variable. (at variables.x)'],
      ['Invalid YAML.'],
    ])
    expect(stderr).toHaveBeenCalledOnce()
    expect(stderr).toHaveBeenCalledWith('  hint: Declare it.\n')
    expect(exit).toHaveBeenCalledWith(1)
  })
})
