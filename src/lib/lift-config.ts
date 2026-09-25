import type { NamedBuildConfig } from '../types'

import { isRecord } from './is-record'

export interface LiftSetup {
  commands?: string | string[]
  working_dir?: string
  builds?: Record<string, NamedBuildConfig>
  use_gitignore?: boolean
}

export interface LiftConfig {
  environments: Record<string, unknown>
  setup?: LiftSetup
}

function invalid(path: string): Error {
  return new Error(`The resolved project config has an invalid "${path}".`)
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw invalid(path)
  return value
}

function optionalCommands(value: unknown, path: string): string | string[] | undefined {
  if (value === undefined || typeof value === 'string') return value
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value
  throw invalid(path)
}

function optionalStringRecord(value: unknown, path: string): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw invalid(path)
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw invalid(`${path}.${key}`)
    result[key] = item
  }
  return result
}

function readNamedBuild(value: unknown, path: string): NamedBuildConfig {
  if (!isRecord(value) || typeof value.dockerfile !== 'string') throw invalid(path)
  return {
    dockerfile: value.dockerfile,
    working_dir: optionalString(value.working_dir, `${path}.working_dir`),
    args: optionalStringRecord(value.args, `${path}.args`),
    docker_target: optionalString(value.docker_target, `${path}.docker_target`),
    depends_on: optionalString(value.depends_on, `${path}.depends_on`),
  }
}

function readSetup(value: unknown): LiftSetup | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw invalid('setup')

  let builds: Record<string, NamedBuildConfig> | undefined
  if (value.builds !== undefined) {
    if (!isRecord(value.builds)) throw invalid('setup.builds')
    builds = {}
    for (const [name, build] of Object.entries(value.builds)) {
      builds[name] = readNamedBuild(build, `setup.builds.${name}`)
    }
  }

  if (value.use_gitignore !== undefined && typeof value.use_gitignore !== 'boolean') {
    throw invalid('setup.use_gitignore')
  }

  return {
    commands: optionalCommands(value.commands, 'setup.commands'),
    working_dir: optionalString(value.working_dir, 'setup.working_dir'),
    builds,
    use_gitignore: value.use_gitignore,
  }
}

/** The parts of the server-resolved project config that `gantry lift` reads locally. */
export function readLiftConfig(config: Record<string, unknown>): LiftConfig {
  if (!isRecord(config.environments)) throw invalid('environments')
  return { environments: config.environments, setup: readSetup(config.setup) }
}
