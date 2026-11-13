import * as path from 'path'

import type { Command } from 'commander'
import { Listr } from 'listr2'

import type {
  RedeployVersionMutation,
  RedeployVersionMutationVariables,
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

const REDEPLOY_VERSION_MUTATION = /* GraphQL */ `
  mutation RedeployVersion($input: RedeployVersionInput!) {
    redeployVersion(input: $input) {
      success
      message
      newVersionId
      newVersionNumber
      yamlSnapshot
    }
  }
`

interface RedeployOptions extends DeployCommandOptions {
  cwd?: string
  verbose?: boolean
}

export function registerRedeployCommand(program: Command): void {
  program
    .command('redeploy <environment>')
    .description("Deploy an environment's live build again without building it")
    .option('-C, --cwd <directory>', 'Change working directory')
    .option('-v, --verbose', 'Emit a log line per state change (useful for debugging and CI logs)')
    .addOption(skipPreDeployOption())
    .addOption(skipPostDeployOption())
    .addOption(postDeployAsyncOption())
    .action(async (environment: string, options: RedeployOptions, command: Command) => {
      const cwd = globalCwd(command) ?? options.cwd
      const workingDir = cwd ? path.resolve(cwd) : process.cwd()

      // The live version's own configuration is deployed, so the local gantry.yml only names the
      // project.
      const localConfig = loadProjectIdentity(workingDir)

      let finalCtx: VersionDeployContext
      try {
        const tasks = new Listr<VersionDeployContext, CliRenderer>(
          [
            {
              title: 'Redeploy live build',
              task: async (ctx, task) => {
                const { redeployVersion } = await graphqlRequest<
                  RedeployVersionMutation,
                  RedeployVersionMutationVariables
                >(REDEPLOY_VERSION_MUTATION, {
                  input: { projectId: localConfig.id, environment },
                })

                if (!redeployVersion.success || !redeployVersion.newVersionId) {
                  throw new Error(
                    sanitizeTerminal(redeployVersion.message ?? 'Failed to redeploy the version')
                  )
                }

                ctx.newVersionId = redeployVersion.newVersionId
                ctx.yamlSnapshot = redeployVersion.yamlSnapshot ?? undefined
                ctx.environmentSlug = environment.toLowerCase()
                task.title = sanitizeTerminal(
                  `Redeploy live build (v${String(redeployVersion.newVersionNumber)} → ${environment})`
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
