import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

import type { Command } from 'commander'

import type {
  LiftPreviewEnvironmentMutation,
  LiftPreviewEnvironmentMutationVariables,
  PreviewEnvironmentsQuery,
  PreviewEnvironmentsQueryVariables,
  TeardownPreviewEnvironmentMutation,
  TeardownPreviewEnvironmentMutationVariables,
} from '../generated/graphql'
import { formatApiError, graphqlRequest } from '../lib/client'
import { globalCwd } from '../lib/command-options'
import { addExamples } from '../lib/examples'
import { createTable, printError, printSuccess } from '../lib/output'
import {
  exitWithResolutionErrors,
  findConfigPath,
  loadProjectIdentity,
} from '../lib/project-identity'
import { parseCliVarFlags, readProjectId } from '../lib/resolve-yaml'
import { sanitizeTerminal } from '../lib/sanitize'

import { addLiftOptions, runLift } from './lift'
import type { LiftOptions } from './lift'

const LIFT_PREVIEW_MUTATION = /* GraphQL */ `
  mutation LiftPreviewEnvironment($input: LiftPreviewEnvironmentInput!) {
    liftPreviewEnvironment(input: $input) {
      ok
      errors {
        code
        message
        path
        suggestion
      }
      created
      preview {
        id
        slug
        template
        name
        parentEnvironment
        services
        databases
        urls
        createdAt
      }
      resolved {
        environment
        config
        plan {
          builds {
            name
            architecture
          }
        }
      }
    }
  }
`

const PREVIEW_ENVIRONMENTS_QUERY = /* GraphQL */ `
  query PreviewEnvironments($projectId: String!, $template: String) {
    previewEnvironments(projectId: $projectId, template: $template) {
      id
      slug
      template
      name
      parentEnvironment
      services
      databases
      urls
      createdAt
    }
  }
`

const TEARDOWN_PREVIEW_MUTATION = /* GraphQL */ `
  mutation TeardownPreviewEnvironment($input: TeardownPreviewEnvironmentInput!) {
    teardownPreviewEnvironment(input: $input) {
      success
      message
      teardownId
    }
  }
`

type Preview = PreviewEnvironmentsQuery['previewEnvironments'][number]

interface PreviewLiftOptions extends LiftOptions {
  as?: string
  services?: string
  json?: boolean
}

interface PreviewListOptions {
  cwd?: string
  json?: boolean
}

interface PreviewTeardownOptions {
  cwd?: string
  as: string
}

function workingDirOf(command: Command, cwd: string | undefined): string {
  const dir = globalCwd(command) ?? cwd
  return dir ? path.resolve(dir) : process.cwd()
}

/** Branch and commit of the working directory, when it is a git repository. */
export function readSourceRef(
  workingDir: string
): { branch?: string; commit?: string } | undefined {
  const git = (args: string[]): string | undefined => {
    try {
      return execFileSync('git', args, { cwd: workingDir, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim()
    } catch {
      return undefined
    }
  }
  const commit = git(['rev-parse', 'HEAD'])
  if (commit === undefined) return undefined
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  return { commit, ...(branch && branch !== 'HEAD' ? { branch } : {}) }
}

/** `--services a,b` as names, or undefined when the flag was not given. */
export function parseServicesFlag(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined
  return value
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
}

export function previewSummary(preview: Preview): string[] {
  const database =
    preview.databases === 'own'
      ? 'its own'
      : preview.databases === 'shared'
        ? `shared with ${preview.parentEnvironment}`
        : null
  return [
    `Preview ${preview.template} as ${preview.name} (from ${preview.parentEnvironment})`,
    `  services: ${preview.services.join(', ')}`,
    ...(database ? [`  database: ${database}`] : []),
    ...preview.urls.map((url) => `  ${url}`),
  ].map(sanitizeTerminal)
}

function readYaml(workingDir: string, file: string | undefined): string {
  const yamlPath = file ? path.resolve(workingDir, file) : findConfigPath(workingDir)
  if (!yamlPath || !fs.existsSync(yamlPath)) {
    printError(`No gantry.yml or gantry.yaml found in ${workingDir}`)
    process.exit(1)
  }
  return fs.readFileSync(yamlPath, 'utf-8')
}

async function liftPreview(
  template: string,
  options: PreviewLiftOptions,
  command: Command
): Promise<void> {
  const workingDir = workingDirOf(command, options.cwd)
  const yaml = readYaml(workingDir, options.file)
  const projectId = readProjectId(yaml)
  if (!projectId) {
    printError('Failed to parse gantry.yml: missing a top-level `id:`.')
    process.exit(1)
  }

  let variables: Record<string, string>
  try {
    variables = parseCliVarFlags(options.var)
  } catch (error) {
    printError(error instanceof Error ? error.message : 'Failed to parse --var flags')
    process.exit(1)
  }

  let result: LiftPreviewEnvironmentMutation['liftPreviewEnvironment']
  try {
    result = (
      await graphqlRequest<LiftPreviewEnvironmentMutation, LiftPreviewEnvironmentMutationVariables>(
        LIFT_PREVIEW_MUTATION,
        {
          input: {
            projectId,
            yaml,
            template,
            name: options.as,
            services: parseServicesFlag(options.services),
            sourceRef: readSourceRef(workingDir),
            variables: Object.entries(variables).map(([name, value]) => ({ name, value })),
          },
        }
      )
    ).liftPreviewEnvironment
  } catch (error) {
    printError(formatApiError(error))
    process.exit(1)
  }

  const { preview, resolved } = result
  if (!result.ok || !preview || !resolved) {
    exitWithResolutionErrors(
      result.errors.map((err) => ({
        code: err.code,
        message: err.message,
        path: err.path,
        suggestion: err.suggestion ?? undefined,
      }))
    )
  }

  if (!options.json) {
    for (const line of previewSummary(preview)) console.log(line)
    console.log('')
  }

  await runLift({
    environment: resolved.environment,
    rawConfig: resolved.config,
    plannedBuilds: resolved.plan.builds,
    workingDir,
    options,
    quiet: options.json === true,
  })

  if (options.json) {
    console.log(JSON.stringify({ created: result.created === true, ...preview }, null, 2))
  }
}

async function listPreviews(
  template: string | undefined,
  options: PreviewListOptions,
  command: Command
): Promise<void> {
  const identity = loadProjectIdentity(workingDirOf(command, options.cwd))
  let previews: Preview[]
  try {
    previews = (
      await graphqlRequest<PreviewEnvironmentsQuery, PreviewEnvironmentsQueryVariables>(
        PREVIEW_ENVIRONMENTS_QUERY,
        { projectId: identity.id, template }
      )
    ).previewEnvironments
  } catch (error) {
    printError(formatApiError(error))
    process.exit(1)
  }

  if (options.json) {
    console.log(JSON.stringify(previews, null, 2))
    return
  }
  if (previews.length === 0) {
    console.log(template ? `No previews of ${sanitizeTerminal(template)}.` : 'No previews.')
    return
  }

  const table = createTable({ head: ['Template', 'Name', 'Parent', 'Services', 'URL'] })
  for (const preview of previews) {
    table.push(
      [
        preview.template,
        preview.name,
        preview.parentEnvironment,
        preview.services.join(', '),
        preview.urls.at(0) ?? '',
      ].map(sanitizeTerminal)
    )
  }
  console.log(table.toString())
}

async function teardownPreview(
  template: string,
  options: PreviewTeardownOptions,
  command: Command
): Promise<void> {
  const identity = loadProjectIdentity(workingDirOf(command, options.cwd))
  let result: TeardownPreviewEnvironmentMutation['teardownPreviewEnvironment']
  try {
    result = (
      await graphqlRequest<
        TeardownPreviewEnvironmentMutation,
        TeardownPreviewEnvironmentMutationVariables
      >(TEARDOWN_PREVIEW_MUTATION, {
        input: { projectId: identity.id, template, name: options.as },
      })
    ).teardownPreviewEnvironment
  } catch (error) {
    printError(formatApiError(error))
    process.exit(1)
  }

  if (!result.success) {
    printError(sanitizeTerminal(result.message))
    process.exit(1)
  }
  printSuccess(sanitizeTerminal(result.message))
}

export function registerPreviewCommand(program: Command): void {
  const previewCmd = program
    .command('preview')
    .description('Create, list and tear down preview environments from previews: templates')

  addExamples(previewCmd, [
    {
      command: 'gantry preview lift frontend --as pr-123',
      description: 'Create or redeploy the frontend preview named pr-123',
    },
    {
      command: 'gantry preview teardown frontend --as pr-123',
      description: 'Tear it down when the pull request closes',
    },
  ])

  const liftCmd = addLiftOptions(
    previewCmd
      .command('lift')
      .argument('<template>', 'Template name from previews: in gantry.yml')
      .description(
        'Create a preview from a template and deploy it, or redeploy the preview with that name'
      )
      .option(
        '--as <name>',
        'Preview name. Without it, a new preview is created and named by its id.'
      )
      .option(
        '--services <names>',
        "Services to deploy, comma-separated, in place of the template's"
      )
      .option('--json', 'Print the preview as JSON once the deploy finishes')
  ).action(liftPreview)

  addExamples(liftCmd, [
    {
      command: 'gantry preview lift frontend --as pr-123',
      description: 'Create or redeploy the frontend preview named pr-123',
    },
    {
      command: 'gantry preview lift full --as pr-123 --services web',
      description: 'Deploy only web to the full preview named pr-123',
    },
  ])

  const listCmd = previewCmd
    .command('list')
    .argument('[template]', 'Only previews of this template')
    .description("List the project's preview environments")
    .option('-C, --cwd <directory>', 'Change working directory')
    .option('--json', 'Print the previews as JSON')
    .action(listPreviews)

  addExamples(listCmd, [
    { command: 'gantry preview list', description: "List the project's previews" },
    {
      command: 'gantry preview list frontend --json',
      description: 'List frontend previews as JSON',
    },
  ])

  const teardownCmd = previewCmd
    .command('teardown')
    .argument('<template>', 'Template name from previews: in gantry.yml')
    .description(
      'Tear down a preview, its routing, DNS records, database users and own databases. Succeeds when it is already gone.'
    )
    .requiredOption('--as <name>', 'Preview name: its --as name, or its id')
    .option('-C, --cwd <directory>', 'Change working directory')
    .action(teardownPreview)

  addExamples(teardownCmd, [
    {
      command: 'gantry preview teardown frontend --as pr-123',
      description: 'Tear down the frontend preview named pr-123',
    },
  ])
}
