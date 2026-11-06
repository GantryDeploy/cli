import * as path from 'path'

import type { Command } from 'commander'
import { Listr } from 'listr2'

import type {
  GetPromoteTargetEnvironmentsQuery,
  GetPromoteTargetEnvironmentsQueryVariables,
  PromoteVersionInput,
  PromoteVersionMutation,
  PromoteVersionMutationVariables,
  StartPromotedDeploymentMutation,
  StartPromotedDeploymentMutationVariables,
} from '../generated/graphql'
import { formatApiError, graphqlRequest } from '../lib/client'
import { globalCwd } from '../lib/command-options'
import { serviceDeploymentNames, serviceDeploymentSubtasks } from '../lib/deployment-poll'
import type { ServiceFailure } from '../lib/deployment-poll'
import { resolveRenderer, shouldUseFallbackRenderer, type CliRenderer } from '../lib/listr'
import { printError } from '../lib/output'
import { loadProjectIdentity } from '../lib/project-identity'
import { printRoutingSummary, waitForRouting } from '../lib/routing-wait'
import type { RoutingResult } from '../lib/routing-wait'
import { sanitizeTerminal } from '../lib/sanitize'

const PROMOTE_VERSION_MUTATION = /* GraphQL */ `
  mutation PromoteVersion($input: PromoteVersionInput!) {
    promoteVersion(input: $input) {
      success
      message
      promotionId
      newVersionId
      newVersionNumber
      yamlSnapshot
    }
  }
`

const START_DEPLOYMENT_MUTATION = /* GraphQL */ `
  mutation StartPromotedDeployment(
    $environment: String!
    $config: JSON!
    $versionId: String
    $options: DeploymentOptionsInput
  ) {
    startDeployment(
      input: {
        environment: $environment
        config: $config
        versionId: $versionId
        options: $options
      }
    ) {
      success
      message
      deploymentIds
      versionId
    }
  }
`

const PROJECT_ENVIRONMENTS_QUERY = /* GraphQL */ `
  query GetPromoteTargetEnvironments($projectId: String!) {
    environments(projectId: $projectId) {
      id
      name
      slug
    }
  }
`

// GraphQL Int is 32-bit, so nine digits always fit.
const BUILD_NUMBER = /^v([1-9]\d{0,8})$/

type ProjectEnvironment = GetPromoteTargetEnvironmentsQuery['environments'][number]

interface PromoteOptions {
  cwd?: string
  from?: string
  verbose?: boolean
}

interface PromoteContext {
  newVersionId?: string
  yamlSnapshot?: string
  targetEnvSlug?: string
  versionId?: string
  deploymentIds?: string[]
  failedServices?: ServiceFailure[]
  routing?: RoutingResult
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function findEnvironment(
  environments: ProjectEnvironment[],
  name: string
): ProjectEnvironment | undefined {
  const slug = name.toLowerCase()
  return environments.find((environment) => environment.slug === slug)
}

/**
 * `--from` names an environment, whose live build is promoted, or a build as `v<number>`. An
 * environment slug wins, so an environment called `v2` stays reachable.
 */
export function promoteSource(
  from: string,
  environments: ProjectEnvironment[]
): Pick<PromoteVersionInput, 'sourceEnvironmentId' | 'buildNumber'> {
  const environment = findEnvironment(environments, from)
  if (environment) return { sourceEnvironmentId: environment.id }

  const build = BUILD_NUMBER.exec(from)
  if (build) return { buildNumber: Number(build[1]) }

  throw new Error(`Environment '${from}' not found for this project.`)
}

export function registerPromoteCommand(program: Command): void {
  program
    .command('promote <targetEnvironment>')
    .description('Deploy a build that already exists to another environment')
    .option(
      '-f, --from <source>',
      'Environment whose live build is promoted, or a build number such as v12'
    )
    .option('-C, --cwd <directory>', 'Change working directory')
    .option('-v, --verbose', 'Emit a log line per state change (useful for debugging and CI logs)')
    .action(async (targetEnvironment: string, options: PromoteOptions, command: Command) => {
      const cwd = globalCwd(command) ?? options.cwd
      const workingDir = cwd ? path.resolve(cwd) : process.cwd()

      // Read identity instead of resolving: promotion must not depend on the blueprint being
      // fetchable.
      const localConfig = loadProjectIdentity(workingDir)

      const { from } = options
      if (!from) {
        printError(
          'A source is required. Use --from <environment> or --from v<number> to choose the build.'
        )
        process.exit(1)
      }

      let finalCtx: PromoteContext
      try {
        const tasks = new Listr<PromoteContext, CliRenderer>(
          [
            {
              title: 'Promote build',
              task: async (ctx, task) => {
                const { environments } = await graphqlRequest<
                  GetPromoteTargetEnvironmentsQuery,
                  GetPromoteTargetEnvironmentsQueryVariables
                >(PROJECT_ENVIRONMENTS_QUERY, { projectId: localConfig.id })

                const targetEnv = findEnvironment(environments, targetEnvironment)
                if (!targetEnv) {
                  throw new Error(`Environment '${targetEnvironment}' not found for this project.`)
                }

                const { promoteVersion } = await graphqlRequest<
                  PromoteVersionMutation,
                  PromoteVersionMutationVariables
                >(PROMOTE_VERSION_MUTATION, {
                  input: {
                    ...promoteSource(from, environments),
                    targetEnvironmentId: targetEnv.id,
                  },
                })

                if (!promoteVersion.success || !promoteVersion.newVersionId) {
                  throw new Error(
                    sanitizeTerminal(promoteVersion.message ?? 'Failed to promote version')
                  )
                }

                ctx.newVersionId = promoteVersion.newVersionId
                ctx.yamlSnapshot = promoteVersion.yamlSnapshot ?? undefined
                ctx.targetEnvSlug = targetEnv.slug
                task.title = sanitizeTerminal(
                  `Promote build (v${String(promoteVersion.newVersionNumber)} → ${targetEnv.name})`
                )
              },
            },
            {
              title: 'Start deployment',
              skip: (ctx) => !ctx.newVersionId || !ctx.yamlSnapshot,
              task: async (ctx, task) => {
                const { targetEnvSlug, yamlSnapshot } = ctx
                if (!yamlSnapshot) {
                  throw new Error('Version snapshot is missing')
                }
                if (!targetEnvSlug) {
                  throw new Error('Target environment is missing')
                }
                const config: unknown = JSON.parse(yamlSnapshot)
                if (!isJsonObject(config)) {
                  throw new Error('Version snapshot is invalid')
                }

                const { startDeployment } = await graphqlRequest<
                  StartPromotedDeploymentMutation,
                  StartPromotedDeploymentMutationVariables
                >(START_DEPLOYMENT_MUTATION, {
                  environment: targetEnvSlug,
                  config,
                  versionId: ctx.newVersionId,
                })

                if (!startDeployment.success || !startDeployment.deploymentIds?.length) {
                  throw new Error(
                    sanitizeTerminal(startDeployment.message ?? 'Failed to start deployment')
                  )
                }

                ctx.deploymentIds = startDeployment.deploymentIds
                ctx.versionId = startDeployment.versionId ?? ctx.newVersionId
                task.title = `Start deployment (${String(startDeployment.deploymentIds.length)} service(s))`
              },
            },
            {
              title: 'Deploy services',
              skip: (ctx) => !ctx.deploymentIds?.length,
              task: async (ctx, task) => {
                const { versionId, deploymentIds } = ctx
                if (!versionId || !deploymentIds) {
                  throw new Error('No deployments to monitor')
                }

                const subtasks = serviceDeploymentSubtasks<PromoteContext>({
                  versionId,
                  deploymentIds,
                  names: await serviceDeploymentNames(versionId),
                  taskContext: { cwd: workingDir },
                  isCancelling: () => false,
                  onFailure: (subCtx, failure) => {
                    subCtx.failedServices = subCtx.failedServices ?? []
                    subCtx.failedServices.push(failure)
                  },
                })

                // exitOnError: false lets every service finish when a sibling fails.
                return task.newListr(subtasks, { concurrent: true, exitOnError: false })
              },
            },
            {
              title: 'Configure routing',
              // Keeps every post-deploy command line on screen beneath the task.
              rendererOptions: { outputBar: Infinity, persistentOutput: true },
              skip: (ctx) => {
                if (!ctx.versionId) return true
                const failed = ctx.failedServices?.length ?? 0
                return failed > 0
                  ? `${String(failed)} service${failed === 1 ? '' : 's'} failed, routing not applied`
                  : false
              },
              task: async (ctx, task) => {
                if (!ctx.versionId) throw new Error('Routing started without a version ID')
                ctx.routing = await waitForRouting(
                  ctx.versionId,
                  () => false,
                  (title) => {
                    task.title = title
                  },
                  (line) => {
                    task.output = line
                  }
                )
              },
            },
          ],
          {
            renderer: resolveRenderer(options.verbose ?? false),
            fallbackRenderer: 'simple',
            fallbackRendererCondition: shouldUseFallbackRenderer,
            rendererOptions: {
              collapseSubtasks: false,
            },
          }
        )

        finalCtx = await tasks.run()
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }

      if (finalCtx.routing) printRoutingSummary(finalCtx.routing)

      if (finalCtx.failedServices?.length) {
        for (const failure of finalCtx.failedServices) {
          printError(failure.message)
        }
        process.exit(1)
      }
    })
}
