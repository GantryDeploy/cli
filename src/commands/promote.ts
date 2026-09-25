import * as path from 'path'

import type { Command } from 'commander'
import { Listr } from 'listr2'

import type {
  GetPromotedDeploymentQuery,
  GetPromotedDeploymentQueryVariables,
  GetPromoteTargetEnvironmentsQuery,
  GetPromoteTargetEnvironmentsQueryVariables,
  PromoteVersionMutation,
  PromoteVersionMutationVariables,
  StartPromotedDeploymentMutation,
  StartPromotedDeploymentMutationVariables,
} from '../generated/graphql'
import { formatApiError, graphqlRequest } from '../lib/client'
import { globalCwd } from '../lib/command-options'
import { isTerminalStatus } from '../lib/deployment-status'
import { resolveRenderer, shouldUseFallbackRenderer, type CliRenderer } from '../lib/listr'
import { printError } from '../lib/output'
import { loadProjectIdentity } from '../lib/project-identity'
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
      deployment {
        id
        status
        lastMessage
        startedAt
        projectName
        serviceName
        environmentName
      }
    }
  }
`

const DEPLOYMENT_QUERY = /* GraphQL */ `
  query GetPromotedDeployment($id: String!) {
    deployment(id: $id) {
      id
      status
      lastMessage
      startedAt
      updatedAt
      completedAt
      projectName
      serviceName
      environmentName
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

const POLL_INTERVAL_MS = 3000
const DEPLOY_TIMEOUT_MS = 15 * 60 * 1000

interface PromoteOptions {
  cwd?: string
  from?: string
  version?: string
  verbose?: boolean
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface PromoteContext {
  newVersionId?: string
  newVersionNumber?: number
  yamlSnapshot?: string
  targetEnvSlug?: string
  deploymentIds?: string[]
}

export function registerPromoteCommand(program: Command): void {
  program
    .command('promote <targetEnvironment>')
    .description('Promote a version from one environment to another')
    .option('-C, --cwd <directory>', 'Change working directory')
    .option(
      '-f, --from <sourceVersionId>',
      'Source version ID to promote (defaults to live version)'
    )
    .option('-v, --verbose', 'Emit a log line per state change (useful for debugging and CI logs)')
    .action(async (targetEnvironment: string, options: PromoteOptions, command: Command) => {
      const cwd = globalCwd(command) ?? options.cwd
      const workingDir = cwd ? path.resolve(cwd) : process.cwd()

      // Read identity instead of resolving: promotion must not depend on the blueprint being
      // fetchable.
      const localConfig = loadProjectIdentity(workingDir)

      if (!options.from) {
        printError(
          'A source version ID is required. Use --from <versionId> to specify which version to promote.'
        )
        process.exit(1)
      }
      const sourceVersionId = options.from

      try {
        const tasks = new Listr<PromoteContext, CliRenderer>(
          [
            {
              title: 'Promote version',
              task: async (ctx, task) => {
                const envResult = await graphqlRequest<
                  GetPromoteTargetEnvironmentsQuery,
                  GetPromoteTargetEnvironmentsQueryVariables
                >(PROJECT_ENVIRONMENTS_QUERY, { projectId: localConfig.id })

                const targetSlug = targetEnvironment.toLowerCase()
                const targetEnv = envResult.environments.find((e) => e.slug === targetSlug)
                if (!targetEnv) {
                  throw new Error(`Environment '${targetEnvironment}' not found for this project.`)
                }

                const result = await graphqlRequest<
                  PromoteVersionMutation,
                  PromoteVersionMutationVariables
                >(PROMOTE_VERSION_MUTATION, {
                  input: {
                    sourceVersionId,
                    targetEnvironmentId: targetEnv.id,
                  },
                })

                const { promoteVersion } = result

                if (!promoteVersion.success || !promoteVersion.newVersionId) {
                  throw new Error(
                    sanitizeTerminal(promoteVersion.message ?? 'Failed to promote version')
                  )
                }

                ctx.newVersionId = promoteVersion.newVersionId
                ctx.newVersionNumber = promoteVersion.newVersionNumber ?? undefined
                ctx.yamlSnapshot = promoteVersion.yamlSnapshot ?? undefined
                ctx.targetEnvSlug = targetEnv.slug
                task.title = sanitizeTerminal(
                  `Promote version (v${String(promoteVersion.newVersionNumber)} → ${targetEnv.name})`
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

                const result = await graphqlRequest<
                  StartPromotedDeploymentMutation,
                  StartPromotedDeploymentMutationVariables
                >(START_DEPLOYMENT_MUTATION, {
                  environment: targetEnvSlug,
                  config,
                  versionId: ctx.newVersionId,
                })

                const { startDeployment } = result

                if (!startDeployment.success || !startDeployment.deploymentIds?.length) {
                  throw new Error(
                    sanitizeTerminal(startDeployment.message ?? 'Failed to start deployment')
                  )
                }

                ctx.deploymentIds = startDeployment.deploymentIds
                task.title = `Start deployment (${String(startDeployment.deploymentIds.length)} service(s))`
              },
            },
            {
              title: 'Wait for deployment',
              skip: (ctx) => !ctx.deploymentIds?.length,
              task: async (ctx, task) => {
                const startTime = Date.now()
                const { deploymentIds } = ctx
                if (!deploymentIds) {
                  throw new Error('No deployments to monitor')
                }

                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- intentional polling loop; exits via return or throw
                while (true) {
                  await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))

                  if (Date.now() - startTime > DEPLOY_TIMEOUT_MS) {
                    throw new Error('Deployment timed out after 15 minutes')
                  }

                  let allComplete = true
                  let anyFailed = false
                  const statusMessages: string[] = []

                  for (const deploymentId of deploymentIds) {
                    try {
                      const result = await graphqlRequest<
                        GetPromotedDeploymentQuery,
                        GetPromotedDeploymentQueryVariables
                      >(DEPLOYMENT_QUERY, { id: deploymentId })

                      const deployment = result.deployment
                      if (!deployment) continue

                      const statusMsg = `${deployment.serviceName ?? 'service'}: ${deployment.status}`
                      statusMessages.push(statusMsg)

                      if (!isTerminalStatus(deployment.status)) {
                        allComplete = false
                      } else if (deployment.status === 'FAILED') {
                        anyFailed = true
                      }
                    } catch {
                      allComplete = false
                    }
                  }

                  task.title = sanitizeTerminal(
                    `Wait for deployment (${statusMessages.join(', ')})`
                  )

                  if (allComplete) {
                    if (anyFailed) {
                      throw new Error('One or more service deployments failed')
                    }
                    task.title = 'Deployment complete'
                    return
                  }
                }
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

        await tasks.run()
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })
}
