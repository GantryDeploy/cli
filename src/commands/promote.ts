import * as path from 'path'

import type { Command } from 'commander'
import { Listr } from 'listr2'

import type {
  GetPromoteTargetEnvironmentsQuery,
  GetPromoteTargetEnvironmentsQueryVariables,
  PromoteVersionInput,
  PromoteVersionMutation,
  PromoteVersionMutationVariables,
} from '../generated/graphql'
import { formatApiError, graphqlRequest } from '../lib/client'
import { globalCwd } from '../lib/command-options'
import {
  postDeployAsyncOption,
  skipPostDeployOption,
  skipPreDeployOption,
} from '../lib/deploy-command-options'
import type { DeployCommandOptions } from '../lib/deploy-command-options'
import { reportVersionDeploy, versionDeployTasks } from '../lib/deploy-version'
import type { VersionDeployContext } from '../lib/deploy-version'
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

interface PromoteOptions extends DeployCommandOptions {
  cwd?: string
  from?: string
  verbose?: boolean
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
    .addOption(skipPreDeployOption())
    .addOption(skipPostDeployOption())
    .addOption(postDeployAsyncOption())
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

      let finalCtx: VersionDeployContext
      try {
        const tasks = new Listr<VersionDeployContext, CliRenderer>(
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
                ctx.environmentSlug = targetEnv.slug
                task.title = sanitizeTerminal(
                  `Promote build (v${String(promoteVersion.newVersionNumber)} → ${targetEnv.name})`
                )
              },
            },
            ...versionDeployTasks<VersionDeployContext>({ workingDir, options }),
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

      reportVersionDeploy(finalCtx)
    })
}
