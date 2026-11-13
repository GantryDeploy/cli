import { existsSync, readFileSync, writeFileSync } from 'fs'
import * as path from 'path'

import { confirm } from '@inquirer/prompts'
import { Option } from 'commander'
import type { Command } from 'commander'

import type {
  EnvVarScopeEnum,
  EnvVarSourceEnum,
  EnvVarsQuery,
  EnvVarsQueryVariables,
  EnvVarTargetInput,
  ReplaceEnvVarsMutation,
  ReplaceEnvVarsMutationVariables,
  ResolvedServiceEnvQuery,
  ResolvedServiceEnvQueryVariables,
  SetEnvVarsMutation,
  SetEnvVarsMutationVariables,
  UnsetEnvVarsMutation,
  UnsetEnvVarsMutationVariables,
} from '../generated/graphql'
import { formatApiError, graphqlRequest } from '../lib/client'
import { globalCwd } from '../lib/command-options'
import { DotenvError, formatDotenv, parseAssignment, parseDotenv } from '../lib/dotenv'
import { createTable, formatDate, printError, printSuccess } from '../lib/output'
import { loadProjectIdentity, resolveEnvironmentSlug } from '../lib/project-identity'
import { redact, sanitizeTerminal } from '../lib/sanitize'
import { readStdin } from '../lib/stdin'
import { isInteractive } from '../lib/terminal'

const ENV_VARS_QUERY = /* GraphQL */ `
  query EnvVars($input: EnvVarTargetInput!) {
    envVars(input: $input) {
      key
      value
      updatedAt
    }
  }
`

const SET_ENV_VARS_MUTATION = /* GraphQL */ `
  mutation SetEnvVars($input: SetEnvVarsInput!) {
    setEnvVars(input: $input) {
      success
      message
      created
      updated
      removed
    }
  }
`

const REPLACE_ENV_VARS_MUTATION = /* GraphQL */ `
  mutation ReplaceEnvVars($input: SetEnvVarsInput!) {
    replaceEnvVars(input: $input) {
      success
      message
      created
      updated
      removed
    }
  }
`

const UNSET_ENV_VARS_MUTATION = /* GraphQL */ `
  mutation UnsetEnvVars($input: UnsetEnvVarsInput!) {
    unsetEnvVars(input: $input) {
      success
      message
      created
      updated
      removed
    }
  }
`

const RESOLVED_SERVICE_ENV_QUERY = /* GraphQL */ `
  query ResolvedServiceEnv($projectId: String!, $environmentSlug: String!, $service: String!) {
    resolvedServiceEnv(
      projectId: $projectId
      environmentSlug: $environmentSlug
      service: $service
    ) {
      versionNumber
      variables {
        key
        value
        source
        overrides
      }
    }
  }
`

const STDIN_PATH = '-'

interface ScopeOptions {
  teamWide?: boolean
  cloud?: string
  network?: string
  project?: boolean
  env?: string
  service?: string
}

interface Scope {
  target: EnvVarTargetInput
  /** How output names the scope: "staging", "staging/api", "the team". */
  label: string
  /** Default file for pull and push. */
  file: string
  /** Set for environment scopes, to suggest the redeploy. */
  environmentSlug?: string
}

const SOURCE_LABELS: Record<EnvVarSourceEnum, string> = {
  TEAM: 'team',
  CLOUD_ACCOUNT: 'cloud account',
  NETWORK: 'network',
  PROJECT: 'project',
  ENVIRONMENT: 'environment',
  SERVICE_YAML: 'gantry.yml service',
  ENVIRONMENT_YAML: 'gantry.yml environment',
  SERVICE_OVERRIDE: 'service override',
  SECRET: 'secret',
  BINDING: 'binding',
}

function fail(message: string, submittedValues: readonly string[] = []): never {
  printError(redact(message, submittedValues))
  process.exit(1)
}

function withScopeOptions(command: Command): Command {
  return command
    .addOption(new Option('--team-wide', 'Every project in the team'))
    .addOption(new Option('--cloud <id>', 'Every environment on a cloud account'))
    .addOption(new Option('--network <id>', 'Every environment on a network'))
    .addOption(new Option('--project', "Every environment of gantry.yml's project"))
    .addOption(new Option('--env <environment>', "One environment of gantry.yml's project"))
    .addOption(new Option('--service <name>', 'With --env: one service in that environment'))
}

function resolveScope(options: ScopeOptions, command: Command): Scope {
  const chosen = [
    options.teamWide === true && '--team-wide',
    options.cloud !== undefined && '--cloud',
    options.network !== undefined && '--network',
    options.project === true && '--project',
    options.env !== undefined && '--env',
  ].filter((flag): flag is string => flag !== false)

  if (chosen.length !== 1) {
    fail(
      chosen.length === 0
        ? 'Choose where the variables apply: --env <environment>, --project, --network <id>, --cloud <id> or --team-wide.'
        : `Choose one of ${chosen.join(', ')}.`
    )
  }
  if (options.service !== undefined && options.env === undefined) {
    fail('--service needs --env <environment>.')
  }

  const scope = (value: EnvVarScopeEnum, rest: Omit<EnvVarTargetInput, 'scope'> = {}) => ({
    scope: value,
    ...rest,
  })

  if (options.teamWide) {
    return { target: scope('TEAM'), label: 'the team', file: '.env.team' }
  }
  if (options.cloud !== undefined) {
    return {
      target: scope('CLOUD_ACCOUNT', { cloudAccountId: options.cloud }),
      label: `cloud account ${options.cloud}`,
      file: `.env.cloud-${options.cloud}`,
    }
  }
  if (options.network !== undefined) {
    return {
      target: scope('NETWORK', { networkId: options.network }),
      label: `network ${options.network}`,
      file: `.env.network-${options.network}`,
    }
  }

  const cwd = globalCwd(command)
  const identity = loadProjectIdentity(cwd ? path.resolve(cwd) : process.cwd())
  if (options.env !== undefined) {
    const slug = resolveEnvironmentSlug(identity, options.env)
    const service = options.service
    return {
      target: scope('ENVIRONMENT', { projectId: identity.id, environmentSlug: slug, service }),
      label: service ? `${slug}/${service}` : slug,
      file: service ? `.env.${slug}.${service}` : `.env.${slug}`,
      environmentSlug: slug,
    }
  }

  return {
    target: scope('PROJECT', { projectId: identity.id }),
    label: 'the project',
    file: '.env.project',
  }
}

function nextDeployHint(scope: Scope): string {
  return scope.environmentSlug
    ? `Takes effect on the next deploy of ${scope.environmentSlug}. Run \`gantry redeploy ${scope.environmentSlug}\` to apply it now.`
    : 'Takes effect on the next deploy of each environment it covers.'
}

function printChanges(
  scope: Scope,
  changes: { created: string[]; updated: string[]; removed: string[] }
): void {
  const parts = [
    changes.created.length > 0 && `added ${changes.created.join(', ')}`,
    changes.updated.length > 0 && `changed ${changes.updated.join(', ')}`,
    changes.removed.length > 0 && `removed ${changes.removed.join(', ')}`,
  ].filter((part): part is string => part !== false)

  if (parts.length === 0) {
    console.log(`No changes to ${sanitizeTerminal(scope.label)}.`)
    return
  }
  printSuccess(sanitizeTerminal(`${scope.label}: ${parts.join('; ')}.`))
  console.log(nextDeployHint(scope))
}

async function fetchVariables(target: EnvVarTargetInput): Promise<EnvVarsQuery['envVars']> {
  const data = await graphqlRequest<EnvVarsQuery, EnvVarsQueryVariables>(ENV_VARS_QUERY, {
    input: target,
  })
  return data.envVars
}

function toVariables(values: Record<string, string>): { key: string; value: string }[] {
  return Object.entries(values).map(([key, value]) => ({ key, value }))
}

async function readFileValues(file: string): Promise<Record<string, string>> {
  if (file === STDIN_PATH) return parseDotenv(await readStdin(), 'stdin')
  if (!existsSync(file))
    fail(`${file} does not exist. Run \`gantry env pull\` first, or pass --file.`)
  return parseDotenv(readFileSync(file, 'utf-8'), file)
}

async function printResolved(scope: Scope, key: string | undefined): Promise<void> {
  const { target } = scope
  if (target.service === undefined || target.service === null) {
    fail('--resolved needs --env <environment> and --service <name>.')
  }
  const data = await graphqlRequest<ResolvedServiceEnvQuery, ResolvedServiceEnvQueryVariables>(
    RESOLVED_SERVICE_ENV_QUERY,
    {
      projectId: target.projectId as string,
      environmentSlug: target.environmentSlug as string,
      service: target.service,
    }
  )
  const { versionNumber, variables } = data.resolvedServiceEnv
  const rows = key === undefined ? variables : variables.filter((v) => v.key === key)
  if (key !== undefined && rows.length === 0) {
    fail(`${key} is not set for ${scope.label} in version ${String(versionNumber)}.`)
  }

  console.log(sanitizeTerminal(`${scope.label}, live version ${String(versionNumber)}`))
  const table = createTable({ head: ['Key', 'Value', 'From', 'Overrides'] })
  for (const variable of rows) {
    table.push([
      sanitizeTerminal(variable.key),
      sanitizeTerminal(variable.value),
      SOURCE_LABELS[variable.source],
      variable.overrides.length > 0
        ? variable.overrides.map((source) => SOURCE_LABELS[source]).join(', ')
        : '-',
    ])
  }
  console.log(table.toString())
}

export function registerEnvCommand(program: Command): void {
  const envCmd = program
    .command('env')
    .description(
      'Manage environment variables kept outside gantry.yml. Each command takes one scope: --env, --project, --network, --cloud or --team-wide.'
    )

  withScopeOptions(
    envCmd
      .command('get [key]')
      .description('List the variables at a scope, or print one value')
      .option(
        '--resolved',
        'With --env and --service: every variable the live version runs with, and where each came from'
      )
  ).action(
    async (
      key: string | undefined,
      options: ScopeOptions & { resolved?: boolean },
      command: Command
    ) => {
      try {
        const scope = resolveScope(options, command)
        if (options.resolved) {
          await printResolved(scope, key)
          return
        }

        const variables = await fetchVariables(scope.target)
        if (key !== undefined) {
          const match = variables.find((variable) => variable.key === key)
          if (!match) fail(`${key} is not set for ${scope.label}.`)
          process.stdout.write(`${match.value}\n`)
          return
        }
        if (variables.length === 0) {
          console.log(sanitizeTerminal(`No variables are set for ${scope.label}.`))
          return
        }
        const table = createTable({ head: ['Key', 'Value', 'Updated'] })
        for (const variable of variables) {
          table.push([
            sanitizeTerminal(variable.key),
            sanitizeTerminal(variable.value),
            formatDate(variable.updatedAt),
          ])
        }
        console.log(table.toString())
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    }
  )

  withScopeOptions(
    envCmd
      .command('set [assignments...]')
      .description('Add or change variables: gantry env set --env staging LOG_LEVEL=debug TZ=UTC')
      .option('--from-file <path>', 'Read KEY=value lines from a file, or - for stdin')
  ).action(
    async (
      assignments: string[],
      options: ScopeOptions & { fromFile?: string },
      command: Command
    ) => {
      let submittedValues: string[] = []
      try {
        const scope = resolveScope(options, command)
        const values = options.fromFile ? await readFileValues(options.fromFile) : {}
        assignments.forEach((text, index) => {
          const [key, value] = parseAssignment(text, index + 1)
          values[key] = value
        })
        submittedValues = Object.values(values)
        if (Object.keys(values).length === 0) {
          fail('Nothing to set. Pass KEY=value arguments or --from-file.')
        }

        const data = await graphqlRequest<SetEnvVarsMutation, SetEnvVarsMutationVariables>(
          SET_ENV_VARS_MUTATION,
          { input: { ...scope.target, variables: toVariables(values) } }
        )
        const result = data.setEnvVars
        if (!result.success) fail(result.message ?? 'Failed to set variables.', submittedValues)
        printChanges(scope, result)
      } catch (error) {
        if (error instanceof DotenvError) fail(error.message)
        printError(formatApiError(error, submittedValues))
        process.exit(1)
      }
    }
  )

  withScopeOptions(envCmd.command('unset <keys...>').description('Remove variables')).action(
    async (keys: string[], options: ScopeOptions, command: Command) => {
      try {
        const scope = resolveScope(options, command)
        const data = await graphqlRequest<UnsetEnvVarsMutation, UnsetEnvVarsMutationVariables>(
          UNSET_ENV_VARS_MUTATION,
          { input: { ...scope.target, keys } }
        )
        const result = data.unsetEnvVars
        if (!result.success) fail(result.message ?? 'Failed to remove variables.')
        const missing = keys.filter((key) => !result.removed.includes(key))
        if (missing.length > 0) {
          console.log(sanitizeTerminal(`Not set for ${scope.label}: ${missing.join(', ')}`))
        }
        printChanges(scope, result)
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    }
  )

  withScopeOptions(
    envCmd
      .command('pull')
      .description('Write the variables at a scope to a .env file')
      .option('--file <path>', 'File to write (default: .env.<environment>, .env.project, ...)')
      .option('--force', 'Overwrite the file if it exists')
  ).action(async (options: ScopeOptions & { file?: string; force?: boolean }, command: Command) => {
    try {
      const scope = resolveScope(options, command)
      const file = options.file ?? scope.file
      if (existsSync(file) && !options.force) {
        fail(`${file} already exists. Pass --force to overwrite it.`)
      }

      const variables = await fetchVariables(scope.target)
      const values = Object.fromEntries(variables.map((v) => [v.key, v.value]))
      writeFileSync(file, formatDotenv(values), { mode: 0o600 })
      printSuccess(
        sanitizeTerminal(
          `Wrote ${String(variables.length)} variables for ${scope.label} to ${file}.`
        )
      )
      console.log('Keep it out of git: it holds the values in plain text.')
    } catch (error) {
      printError(formatApiError(error))
      process.exit(1)
    }
  })

  withScopeOptions(
    envCmd
      .command('push')
      .description(
        'Make a scope hold exactly the variables in a .env file. Variables missing from the file are removed.'
      )
      .option('--file <path>', 'File to read, or - for stdin (default: the file pull writes)')
      .option(
        '-y, --yes',
        'Remove variables missing from the file without asking (required without a TTY)'
      )
  ).action(async (options: ScopeOptions & { file?: string; yes?: boolean }, command: Command) => {
    let submittedValues: string[] = []
    try {
      const scope = resolveScope(options, command)
      const values = await readFileValues(options.file ?? scope.file)
      submittedValues = Object.values(values)

      const removing = (await fetchVariables(scope.target))
        .map((variable) => variable.key)
        .filter((key) => !Object.hasOwn(values, key))
      if (removing.length > 0 && !options.yes) {
        const list = sanitizeTerminal(removing.join(', '))
        if (!isInteractive()) {
          fail(`Push would remove ${list}. Re-run with --yes to confirm, or add them to the file.`)
        }
        console.log(`These variables are not in the file and will be removed: ${list}`)
        if (!(await confirm({ message: 'Remove them?', default: false }))) {
          console.log('Push cancelled. No changes were made.')
          return
        }
      }

      const data = await graphqlRequest<ReplaceEnvVarsMutation, ReplaceEnvVarsMutationVariables>(
        REPLACE_ENV_VARS_MUTATION,
        { input: { ...scope.target, variables: toVariables(values) } }
      )
      const result = data.replaceEnvVars
      if (!result.success) fail(result.message ?? 'Failed to push variables.', submittedValues)
      printChanges(scope, result)
    } catch (error) {
      if (error instanceof DotenvError) fail(error.message)
      printError(formatApiError(error, submittedValues))
      process.exit(1)
    }
  })
}
