import * as fs from 'fs'
import * as path from 'path'

import type { ResolutionError } from '../types'

import { printError } from './output'
import { environmentNamesIn, isProjectDocument, readProjectId } from './resolve-yaml'

export interface ProjectIdentity {
  id: string
  /** Environment slugs, in declaration order. */
  environments: string[]
}

/** `gantry.yml` or `gantry.yaml` in `workingDir`, or null when neither exists. */
export function findConfigPath(workingDir: string): string | null {
  return (
    [path.join(workingDir, 'gantry.yml'), path.join(workingDir, 'gantry.yaml')].find((candidate) =>
      fs.existsSync(candidate)
    ) ?? null
  )
}

/**
 * Read the project ID and environment slugs from gantry.yml without resolving it, so this needs
 * no API call and keeps working when the blueprint is gone or the network is down. Exits with a
 * printed message on any failure.
 */
export function loadProjectIdentity(workingDir: string): ProjectIdentity {
  const configPath = findConfigPath(workingDir)

  if (!configPath) {
    printError(`No gantry.yml or gantry.yaml found in ${workingDir}`)
    process.exit(1)
  }

  let contents: string
  try {
    contents = fs.readFileSync(configPath, 'utf-8')
  } catch (error) {
    printError(
      `Failed to read ${configPath}: ${error instanceof Error ? error.message : 'Unknown error'}`
    )
    process.exit(1)
  }

  if (!isProjectDocument(contents)) {
    printError('Failed to parse gantry.yml: expected a top-level `type: project`.')
    process.exit(1)
  }

  const id = readProjectId(contents)
  if (!id) {
    printError('Failed to parse gantry.yml: missing a top-level `id:`.')
    process.exit(1)
  }

  return { id, environments: environmentNamesIn(contents) }
}

export function exitWithResolutionErrors(errors: ResolutionError[]): never {
  for (const err of errors) {
    const pathLabel = err.path ? ` (at ${err.path})` : ''
    printError(`${err.message}${pathLabel}`)
    if (err.suggestion) {
      process.stderr.write(`  hint: ${err.suggestion}\n`)
    }
  }
  process.exit(1)
}

/** Case-insensitive; returns the declared spelling. */
export function resolveEnvironmentSlug(identity: ProjectIdentity, requested: string): string {
  const match = identity.environments.find((slug) => slug.toLowerCase() === requested.toLowerCase())

  if (!match) {
    printError(
      `Environment '${requested}' not found in gantry.yml. Available: ${identity.environments.join(', ')}`
    )
    process.exit(1)
  }

  return match
}
