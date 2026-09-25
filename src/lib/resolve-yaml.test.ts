import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { graphqlRequest } from './client'
import {
  formatProvenanceTable,
  isProjectDocument,
  parseCliVarFlags,
  readProjectId,
  resolveAllEnvironments,
  resolveYaml,
} from './resolve-yaml'

vi.mock('./client', () => ({ graphqlRequest: vi.fn() }))

const PROJECT_YAML = `type: project
id: k4rt7n
blueprint: "@gantry/nextjs:1"
environments:
  production: {}
  staging: {}
`

const PLAN = { services: [], routing: [] }

function resolvedEnvironment(overrides: Record<string, unknown> = {}) {
  return {
    environment: 'production',
    config: { services: { web: { type: 'http' } } },
    resolvedYaml: 'services:\n  web:\n    type: http\n',
    provenance: [],
    plan: PLAN,
    ...overrides,
  }
}

function respondWith(resolveProject: Record<string, unknown>) {
  vi.mocked(graphqlRequest).mockResolvedValueOnce({ resolveProject })
}

describe('resolve-yaml', () => {
  let dir: string
  let yamlPath: string

  beforeEach(() => {
    vi.mocked(graphqlRequest).mockReset()
    dir = mkdtempSync(join(tmpdir(), 'gantry-resolve-yaml-'))
    yamlPath = join(dir, 'gantry.yml')
    writeFileSync(yamlPath, PROJECT_YAML)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  describe('resolveYaml', () => {
    it('sends the file, its project id, the environment, and --var overrides', async () => {
      respondWith({ ok: true, errors: [], environments: [resolvedEnvironment()] })

      await resolveYaml({
        yamlPath,
        environment: 'production',
        cliVariables: { domain: 'example.com', replicas: '3' },
      })

      expect(graphqlRequest).toHaveBeenCalledOnce()
      const [query, variables] = vi.mocked(graphqlRequest).mock.calls[0]
      expect(query).toContain('resolveProject(input: $input)')
      expect(variables).toEqual({
        input: {
          projectId: 'k4rt7n',
          yaml: PROJECT_YAML,
          environment: 'production',
          variables: [
            { name: 'domain', value: 'example.com' },
            { name: 'replicas', value: '3' },
          ],
        },
      })
    })

    it('omits variables when none were given', async () => {
      respondWith({ ok: true, errors: [], environments: [resolvedEnvironment()] })

      await resolveYaml({ yamlPath, environment: 'production' })

      const [, variables] = vi.mocked(graphqlRequest).mock.calls[0]
      expect((variables as { input: { variables?: unknown } }).input.variables).toBeUndefined()
    })

    it('returns the first resolved environment with typed provenance', async () => {
      respondWith({
        ok: true,
        errors: [],
        blueprintReference: '@gantry/nextjs:1',
        environments: [
          resolvedEnvironment({
            provenance: [
              { name: 'replicas', type: 'number', value: '3', source: 'cli' },
              { name: 'ratio', type: 'number', value: 'not-a-number', source: 'profile' },
              { name: 'debug', type: 'boolean', value: 'true', source: 'value' },
              { name: 'quiet', type: 'boolean', value: 'false', source: 'value' },
              { name: 'domain', type: 'string', value: 'example.com', source: 'blueprint_default' },
            ],
          }),
        ],
      })

      const result = await resolveYaml({ yamlPath, environment: 'production' })

      expect(result).toEqual({
        ok: true,
        config: { services: { web: { type: 'http' } } },
        sourceYaml: PROJECT_YAML,
        resolvedYaml: 'services:\n  web:\n    type: http\n',
        blueprintReference: '@gantry/nextjs:1',
        variableProvenance: {
          replicas: { type: 'number', value: 3, source: 'cli' },
          ratio: { type: 'number', value: 'not-a-number', source: 'profile' },
          debug: { type: 'boolean', value: true, source: 'value' },
          quiet: { type: 'boolean', value: false, source: 'value' },
          domain: { type: 'string', value: 'example.com', source: 'blueprint_default' },
        },
        plan: PLAN,
      })
    })

    it('normalises a null blueprint reference to undefined', async () => {
      respondWith({
        ok: true,
        errors: [],
        blueprintReference: null,
        environments: [resolvedEnvironment()],
      })

      const result = await resolveYaml({ yamlPath, environment: 'production' })

      expect(result.ok && result.blueprintReference).toBeUndefined()
    })

    it('passes the server’s resolution errors through', async () => {
      const errors = [
        {
          code: 'PROJECT_ID_MISMATCH',
          message: 'The project id in gantry.yml does not match the project being resolved.',
          path: 'id',
        },
      ]
      respondWith({ ok: false, errors, environments: [] })

      await expect(resolveYaml({ yamlPath, environment: 'production' })).resolves.toEqual({
        ok: false,
        errors,
      })
    })

    it('fails explicitly when the server reports success with no environments', async () => {
      respondWith({ ok: true, errors: [], environments: [] })

      await expect(resolveYaml({ yamlPath, environment: 'production' })).resolves.toEqual({
        ok: false,
        errors: [
          { code: 'RESOLVE_FAILED', message: 'gantry.yml could not be resolved.', path: yamlPath },
        ],
      })
    })

    it('reports a failed request as a resolution error', async () => {
      vi.mocked(graphqlRequest).mockRejectedValueOnce(new Error('Not authenticated.'))

      await expect(resolveYaml({ yamlPath, environment: 'production' })).resolves.toEqual({
        ok: false,
        errors: [{ code: 'RESOLVE_REQUEST_FAILED', message: 'Not authenticated.', path: yamlPath }],
      })
    })

    it('uses a generic message when the request rejects with a non-Error', async () => {
      vi.mocked(graphqlRequest).mockRejectedValueOnce('boom')

      const result = await resolveYaml({ yamlPath, environment: 'production' })

      expect(result).toEqual({
        ok: false,
        errors: [
          {
            code: 'RESOLVE_REQUEST_FAILED',
            message: 'Failed to resolve gantry.yml.',
            path: yamlPath,
          },
        ],
      })
    })

    it('reports an unreadable file without calling the API', async () => {
      const missing = join(dir, 'missing.yml')

      const result = await resolveYaml({ yamlPath: missing, environment: 'production' })

      expect(result.ok).toBe(false)
      expect(!result.ok && result.errors[0]).toMatchObject({
        code: 'FILE_READ_ERROR',
        path: missing,
      })
      expect(graphqlRequest).not.toHaveBeenCalled()
    })

    it('refuses a file with no project id without calling the API', async () => {
      writeFileSync(yamlPath, 'type: project\nenvironments:\n  production: {}\n')

      const result = await resolveYaml({ yamlPath, environment: 'production' })

      expect(!result.ok && result.errors.map((error) => error.code)).toEqual(['MISSING_PROJECT_ID'])
      expect(graphqlRequest).not.toHaveBeenCalled()
    })
  })

  describe('resolveAllEnvironments', () => {
    it('resolves every environment in one request, with no environment named', async () => {
      respondWith({
        ok: true,
        errors: [],
        environments: [resolvedEnvironment(), resolvedEnvironment({ environment: 'staging' })],
      })

      const result = await resolveAllEnvironments({ yamlPath, cliVariables: { domain: 'x.com' } })

      expect(result).toEqual({ ok: true, environments: ['production', 'staging'] })
      const [, variables] = vi.mocked(graphqlRequest).mock.calls[0]
      expect(variables).toEqual({
        input: {
          projectId: 'k4rt7n',
          yaml: PROJECT_YAML,
          variables: [{ name: 'domain', value: 'x.com' }],
        },
      })
    })

    it('returns every environment’s errors together', async () => {
      const errors = [
        { code: 'ENVIRONMENT_NOT_FOUND', message: 'a', path: 'environments.production' },
        { code: 'ENVIRONMENT_NOT_FOUND', message: 'b', path: 'environments.staging' },
      ]
      respondWith({ ok: false, errors, environments: [] })

      await expect(resolveAllEnvironments({ yamlPath })).resolves.toEqual({ ok: false, errors })
    })

    it('reports a failed request as a resolution error', async () => {
      vi.mocked(graphqlRequest).mockRejectedValueOnce(new Error('Network down'))

      await expect(resolveAllEnvironments({ yamlPath })).resolves.toEqual({
        ok: false,
        errors: [{ code: 'RESOLVE_REQUEST_FAILED', message: 'Network down', path: yamlPath }],
      })
    })

    it('uses a generic message when the request rejects with a non-Error', async () => {
      vi.mocked(graphqlRequest).mockRejectedValueOnce(undefined)

      const result = await resolveAllEnvironments({ yamlPath })

      expect(!result.ok && result.errors[0].message).toBe('Failed to resolve gantry.yml.')
    })

    it('reports an unreadable file', async () => {
      const result = await resolveAllEnvironments({ yamlPath: join(dir, 'nope.yml') })

      expect(!result.ok && result.errors[0].code).toBe('FILE_READ_ERROR')
      expect(graphqlRequest).not.toHaveBeenCalled()
    })

    it('refuses a file with no project id', async () => {
      writeFileSync(yamlPath, 'id: ""\n')

      const result = await resolveAllEnvironments({ yamlPath })

      expect(!result.ok && result.errors[0].code).toBe('MISSING_PROJECT_ID')
      expect(graphqlRequest).not.toHaveBeenCalled()
    })
  })
})

describe('readProjectId', () => {
  it('reads a top-level string id', () => {
    expect(readProjectId('id: p9ue62\n')).toBe('p9ue62')
  })

  it.each([
    ['a numeric id', 'id: 42\n'],
    ['an empty id', 'id: ""\n'],
    ['no id', 'type: project\n'],
    ['a scalar document', 'just a string'],
    ['an empty document', ''],
    ['invalid YAML', 'id: [unclosed\n'],
  ])('returns null for %s', (_label, source) => {
    expect(readProjectId(source)).toBeNull()
  })
})

describe('isProjectDocument', () => {
  it('is true for type: project', () => {
    expect(isProjectDocument('type: project\n')).toBe(true)
  })

  it.each([
    ['another type', 'type: blueprint\n'],
    ['no type', 'id: p9ue62\n'],
    ['an empty document', ''],
    ['invalid YAML', 'type: [unclosed\n'],
  ])('is false for %s', (_label, source) => {
    expect(isProjectDocument(source)).toBe(false)
  })
})

describe('parseCliVarFlags', () => {
  it('returns an empty record for no flags', () => {
    expect(parseCliVarFlags(undefined)).toEqual({})
  })

  it('splits on the first equals sign and keeps the rest of the value', () => {
    expect(parseCliVarFlags(['domain=example.com', 'query=a=b', 'empty='])).toEqual({
      domain: 'example.com',
      query: 'a=b',
      empty: '',
    })
  })

  it('trims the key and lets a later flag win', () => {
    expect(parseCliVarFlags([' key =one', 'key=two'])).toEqual({ key: 'two' })
  })

  it.each(['novalue', '=value'])('rejects %s as missing a key=value pair', (raw) => {
    expect(() => parseCliVarFlags([raw])).toThrow(`Invalid --var "${raw}". Expected key=value.`)
  })

  it('rejects a key that is only whitespace', () => {
    expect(() => parseCliVarFlags(['  =value'])).toThrow('Invalid --var "  =value". Empty key.')
  })
})

describe('formatProvenanceTable', () => {
  it('returns an empty string for no variables', () => {
    expect(formatProvenanceTable({}, 'production')).toBe('')
  })

  it('aligns columns and quotes only string values', () => {
    const table = formatProvenanceTable(
      {
        domain: { type: 'string', value: 'example.com', source: 'cli' },
        n: { type: 'number', value: 3, source: 'profile' },
        debug: { type: 'boolean', value: false, source: 'value' },
      },
      'production'
    )

    expect(table.split('\n')).toEqual([
      'Variables (production):',
      '  domain  string   "example.com"  (cli)',
      '  n       number   3              (profile)',
      '  debug   boolean  false          (value)',
    ])
  })
})
