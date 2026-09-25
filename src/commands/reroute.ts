import * as path from 'path'

import type { Command } from 'commander'
import { Listr } from 'listr2'

import type {
  GetRerouteDeploymentQuery,
  GetRerouteDeploymentQueryVariables,
  TriggerRerouteMutation,
  TriggerRerouteMutationVariables,
} from '../generated/graphql'
import { formatApiError, graphqlRequest } from '../lib/client'
import { globalCwd } from '../lib/command-options'
import { isTerminalStatus } from '../lib/deployment-status'
import { resolveRenderer, shouldUseFallbackRenderer, type CliRenderer } from '../lib/listr'
import { printError } from '../lib/output'
import { exitWithResolutionErrors, findConfigPath } from '../lib/project-identity'
import { resolveYaml } from '../lib/resolve-yaml'
import { sanitizeTerminal } from '../lib/sanitize'

const TRIGGER_REROUTE_MUTATION = /* GraphQL */ `
  mutation TriggerReroute($config: JSON!, $environment: String!) {
    triggerReroute(input: { config: $config, environment: $environment }) {
      success
      message
      deploymentId
      versionId
      versionNumber
    }
  }
`

const DEPLOYMENT_QUERY = /* GraphQL */ `
  query GetRerouteDeployment($id: String!) {
    deployment(id: $id) {
      id
      teamId
      environmentId
      status
      lastMessage
      startedAt
      updatedAt
      completedAt
      projectName
      projectId
      projectName
      projectId
      environmentName
      serviceName
    }
  }
`

const POLL_INTERVAL_MS = 2000

const ROUTING_TIMEOUT_MS = 5 * 60 * 1000

interface RerouteOptions {
  cwd?: string
  verbose?: boolean
}

interface RerouteContext {
  deploymentId?: string
  versionId?: string
  versionNumber?: number
}

export function registerRerouteCommand(program: Command): void {
  program
    .command('reroute <environment>')
    .description('Re-run routing for the current live version of a project')
    .option('-C, --cwd <directory>', 'Change working directory')
    .option('-v, --verbose', 'Emit a log line per state change (useful for debugging and CI logs)')
    .action(async (environment: string, options: RerouteOptions, command: Command) => {
      const cwd = globalCwd(command) ?? options.cwd
      const workingDir = cwd ? path.resolve(cwd) : process.cwd()
      const yamlPath = findConfigPath(workingDir)

      if (!yamlPath) {
        printError(`No gantry.yml or gantry.yaml found in ${workingDir}`)
        process.exit(1)
      }

      // Reroute sends the composed config: a blueprint-using project has no local `services:`.
      const resolveResult = await resolveYaml({ yamlPath, environment })
      if (!resolveResult.ok) {
        exitWithResolutionErrors(resolveResult.errors)
      }
      const config = resolveResult.config

      try {
        const tasks = new Listr<RerouteContext, CliRenderer>(
          [
            {
              title: 'Trigger reroute',
              task: async (ctx, task) => {
                const result = await graphqlRequest<
                  TriggerRerouteMutation,
                  TriggerRerouteMutationVariables
                >(TRIGGER_REROUTE_MUTATION, {
                  config,
                  environment,
                })

                const { triggerReroute } = result

                if (!triggerReroute.success || !triggerReroute.deploymentId) {
                  throw new Error(
                    sanitizeTerminal(triggerReroute.message ?? 'Failed to trigger reroute')
                  )
                }

                ctx.deploymentId = triggerReroute.deploymentId
                ctx.versionId = triggerReroute.versionId ?? undefined
                ctx.versionNumber = triggerReroute.versionNumber ?? undefined
                task.title = `Trigger reroute (v${String(triggerReroute.versionNumber)})`
              },
            },

            {
              title: 'Configure routing',
              skip: (ctx) => !ctx.deploymentId,
              task: async (ctx, task) => {
                if (!ctx.deploymentId) {
                  task.title = 'Configure routing: Skipped (no deployment ID)'
                  return
                }

                const startTime = Date.now()

                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- intentional polling loop; exits via return or throw
                while (true) {
                  await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))

                  if (Date.now() - startTime > ROUTING_TIMEOUT_MS) {
                    throw new Error('Routing timed out after 5 minutes')
                  }

                  try {
                    const result = await graphqlRequest<
                      GetRerouteDeploymentQuery,
                      GetRerouteDeploymentQueryVariables
                    >(DEPLOYMENT_QUERY, { id: ctx.deploymentId })

                    const deployment = result.deployment
                    if (!deployment) {
                      task.title = 'Configure routing: Not found'
                      return
                    }

                    const message = deployment.lastMessage
                      ? ` - ${sanitizeTerminal(deployment.lastMessage)}`
                      : ''
                    task.title = sanitizeTerminal(
                      `Configure routing: ${deployment.status.toUpperCase()}${message}`
                    )

                    if (isTerminalStatus(deployment.status)) {
                      const normalized = deployment.status
                      if (normalized === 'COMPLETE') {
                        task.title = `Routing complete${message}`
                        return
                      } else if (normalized === 'FAILED') {
                        throw new Error(`Routing failed${message}`)
                      } else {
                        task.title = sanitizeTerminal(
                          `Configure routing: ${deployment.status.toUpperCase()}`
                        )
                        return
                      }
                    }
                  } catch (error) {
                    if (
                      error instanceof Error &&
                      (error.message.includes('Routing failed') ||
                        error.message.includes('Routing timed out') ||
                        error.message.includes('not found'))
                    ) {
                      throw error
                    }
                    // Network errors are transient while polling; keep trying.
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
