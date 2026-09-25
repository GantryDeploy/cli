import * as fs from 'fs'

import { parse as parseYaml } from 'yaml'

import type { ResolveProjectQuery, ResolveProjectQueryVariables } from '../generated/graphql'
import type { DeploymentPlan, ResolutionError, VariableProvenance, VariableValue } from '../types'

import { graphqlRequest } from './client'
import { isRecord } from './is-record'

const RESOLVE_PROJECT_QUERY = /* GraphQL */ `
  query ResolveProject($input: ResolveProjectInput!) {
    resolveProject(input: $input) {
      ok
      errors {
        code
        message
        path
        suggestion
      }
      blueprintReference
      environments {
        environment
        config
        resolvedYaml
        provenance {
          name
          type
          value
          source
        }
        plan {
          services {
            name
            type
            deploymentType
            source
            cluster
          }
          routing {
            domain
            entryType
            loadBalancer
            paths {
              path
              service
              deploymentType
              routeHops
            }
          }
        }
      }
    }
  }
`

type ResolvedEnvironment = ResolveProjectQuery['resolveProject']['environments'][number]

export type ResolveYamlResult =
  | {
      ok: true
      config: Record<string, unknown>
      sourceYaml: string
      resolvedYaml: string
      blueprintReference?: string
      variableProvenance: VariableProvenance
      plan: DeploymentPlan
    }
  | { ok: false; errors: ResolutionError[] }

export interface ResolveYamlArgs {
  yamlPath: string
  environment: string
  cliVariables?: Record<string, string>
}

/** The server parses, composes and plans, so a preview here cannot disagree with a deploy. */
export async function resolveYaml(args: ResolveYamlArgs): Promise<ResolveYamlResult> {
  let sourceYaml: string
  try {
    sourceYaml = fs.readFileSync(args.yamlPath, 'utf-8')
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return {
      ok: false,
      errors: [
        {
          code: 'FILE_READ_ERROR',
          message: `Failed to read ${args.yamlPath}: ${message}`,
          path: args.yamlPath,
        },
      ],
    }
  }

  const projectId = readProjectId(sourceYaml)
  if (!projectId) {
    return {
      ok: false,
      errors: [
        {
          code: 'MISSING_PROJECT_ID',
          message: 'gantry.yml is missing a top-level `id:`.',
          path: 'id',
          suggestion: 'Copy the project id from the Gantry console.',
        },
      ],
    }
  }

  let response: ResolveProjectQuery
  try {
    response = await graphqlRequest<ResolveProjectQuery, ResolveProjectQueryVariables>(
      RESOLVE_PROJECT_QUERY,
      {
        input: {
          projectId,
          yaml: sourceYaml,
          environment: args.environment,
          variables: toVariableInput(args.cliVariables),
        },
      }
    )
  } catch (error) {
    return {
      ok: false,
      errors: [
        {
          code: 'RESOLVE_REQUEST_FAILED',
          message: error instanceof Error ? error.message : 'Failed to resolve gantry.yml.',
          path: args.yamlPath,
        },
      ],
    }
  }

  const result = response.resolveProject
  if (!result.ok || result.environments.length === 0) {
    return {
      ok: false,
      errors:
        result.errors.length > 0
          ? toResolutionErrors(result.errors)
          : [
              {
                code: 'RESOLVE_FAILED',
                message: 'gantry.yml could not be resolved.',
                path: args.yamlPath,
              },
            ],
    }
  }

  const resolved = result.environments[0]

  return {
    ok: true,
    config: resolved.config,
    sourceYaml,
    resolvedYaml: resolved.resolvedYaml,
    blueprintReference: result.blueprintReference ?? undefined,
    variableProvenance: toProvenance(resolved.provenance),
    plan: resolved.plan,
  }
}

/** One call for every declared environment; the server reports all their errors together. */
export async function resolveAllEnvironments(args: {
  yamlPath: string
  cliVariables?: Record<string, string>
}): Promise<{ ok: true; environments: string[] } | { ok: false; errors: ResolutionError[] }> {
  let sourceYaml: string
  try {
    sourceYaml = fs.readFileSync(args.yamlPath, 'utf-8')
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return {
      ok: false,
      errors: [
        {
          code: 'FILE_READ_ERROR',
          message: `Failed to read ${args.yamlPath}: ${message}`,
          path: args.yamlPath,
        },
      ],
    }
  }

  const projectId = readProjectId(sourceYaml)
  if (!projectId) {
    return {
      ok: false,
      errors: [
        {
          code: 'MISSING_PROJECT_ID',
          message: 'gantry.yml is missing a top-level `id:`.',
          path: 'id',
          suggestion: 'Copy the project id from the Gantry console.',
        },
      ],
    }
  }

  let response: ResolveProjectQuery
  try {
    response = await graphqlRequest<ResolveProjectQuery, ResolveProjectQueryVariables>(
      RESOLVE_PROJECT_QUERY,
      {
        input: {
          projectId,
          yaml: sourceYaml,
          variables: toVariableInput(args.cliVariables),
        },
      }
    )
  } catch (error) {
    return {
      ok: false,
      errors: [
        {
          code: 'RESOLVE_REQUEST_FAILED',
          message: error instanceof Error ? error.message : 'Failed to resolve gantry.yml.',
          path: args.yamlPath,
        },
      ],
    }
  }

  const result = response.resolveProject
  if (!result.ok) return { ok: false, errors: toResolutionErrors(result.errors) }

  return { ok: true, environments: result.environments.map((env) => env.environment) }
}

/**
 * Read `id:` without validating the rest: the file may be malformed at this point, and the
 * server re-checks the ID against the YAML it receives.
 */
export function readProjectId(source: string): string | null {
  let parsed: unknown
  try {
    parsed = parseYaml(source)
  } catch {
    return null
  }

  if (!isRecord(parsed)) return null
  const { id } = parsed
  return typeof id === 'string' && id.length > 0 ? id : null
}

/** Whether the document declares itself a project, before anything else reads it. */
export function isProjectDocument(source: string): boolean {
  let parsed: unknown
  try {
    parsed = parseYaml(source)
  } catch {
    return false
  }

  if (!isRecord(parsed)) return false
  return parsed.type === 'project'
}

/** Environment names, read without going through the parser. */
export function environmentNamesIn(source: string): string[] {
  let parsed: unknown
  try {
    parsed = parseYaml(source)
  } catch {
    return []
  }

  if (!isRecord(parsed)) return []
  const { environments } = parsed
  if (!isRecord(environments)) return []
  return Object.keys(environments)
}

function toVariableInput(
  variables: Record<string, string> | undefined
): { name: string; value: string }[] | undefined {
  if (!variables) return undefined
  return Object.entries(variables).map(([name, value]) => ({ name, value }))
}

function toResolutionErrors(
  errors: ResolveProjectQuery['resolveProject']['errors']
): ResolutionError[] {
  return errors.map((error) => ({
    code: error.code,
    message: error.message,
    path: error.path,
    suggestion: error.suggestion ?? undefined,
  }))
}

function toProvenance(entries: ResolvedEnvironment['provenance']): VariableProvenance {
  const out: VariableProvenance = {}
  for (const entry of entries) {
    out[entry.name] = {
      type: entry.type,
      value: typedValue(entry.type, entry.value),
      source: entry.source,
    }
  }
  return out
}

/** Provenance crosses the wire as strings; restore the declared type for display. */
function typedValue(type: string, raw: string): VariableValue {
  if (type === 'number') {
    const n = Number(raw)
    return Number.isFinite(n) ? n : raw
  }
  if (type === 'boolean') return raw === 'true'
  return raw
}

/** Throws on a malformed `--var` (empty key or missing `=`). */
export function parseCliVarFlags(raws: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of raws ?? []) {
    const eq = raw.indexOf('=')
    if (eq <= 0) {
      throw new Error(`Invalid --var "${raw}". Expected key=value.`)
    }
    const key = raw.slice(0, eq).trim()
    const value = raw.slice(eq + 1)
    if (key === '') {
      throw new Error(`Invalid --var "${raw}". Empty key.`)
    }
    out[key] = value
  }
  return out
}

/**
 * Render a provenance map for `gantry resolve`: a `Variables (<label>):` header
 * followed by one column-aligned `key  type  value  (source)` row per variable,
 * with string values JSON-quoted. Returns '' when the map is empty.
 */
export function formatProvenanceTable(provenance: VariableProvenance, label: string): string {
  const entries = Object.entries(provenance)
  if (entries.length === 0) return ''
  const keyWidth = Math.max(...entries.map(([k]) => k.length), 4)
  const typeWidth = Math.max(...entries.map(([, v]) => v.type.length), 4)
  const valueStrings = entries.map(([, v]) => formatVarValue(v.value))
  const valueWidth = Math.max(...valueStrings.map((s) => s.length), 5)

  const lines = [`Variables (${label}):`]
  entries.forEach(([key, v], i) => {
    const valueStr = valueStrings[i]
    lines.push(
      `  ${key.padEnd(keyWidth)}  ${v.type.padEnd(typeWidth)}  ${valueStr.padEnd(valueWidth)}  (${v.source})`
    )
  })
  return lines.join('\n')
}

function formatVarValue(v: VariableValue): string {
  if (typeof v === 'string') return JSON.stringify(v)
  return String(v)
}
