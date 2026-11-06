import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

import type { Command } from 'commander'
import { Listr } from 'listr2'

import type {
  CancelLiftDeploymentMutation,
  CancelLiftDeploymentMutationVariables,
  CreateVersionMutation,
  CreateVersionMutationVariables,
  DeploymentsByVersionQuery,
  DeploymentsByVersionQueryVariables,
  StartLiftDeploymentMutation,
  StartLiftDeploymentMutationVariables,
} from '../generated/graphql'
import { formatApiError, graphqlRequest } from '../lib/client'
import { globalCwd } from '../lib/command-options'
import {
  DEPLOYMENTS_BY_VERSION_QUERY,
  POLL_INTERVAL_MS,
  serviceDeploymentNames,
  serviceDeploymentSubtasks,
} from '../lib/deployment-poll'
import type { VersionDeployment } from '../lib/deployment-poll'
import { isTerminalStatus } from '../lib/deployment-status'
import { buildDockerBuildArgs, runDocker } from '../lib/exec'
import { readLiftConfig } from '../lib/lift-config'
import type { LiftConfig } from '../lib/lift-config'
import { resolveRenderer, shouldUseFallbackRenderer, type CliRenderer } from '../lib/listr'
import type { VersionRouteUrl } from '../lib/live-urls'
import { printError } from '../lib/output'
import { findConfigPath } from '../lib/project-identity'
import { parseCliVarFlags, resolveYaml } from '../lib/resolve-yaml'
import type { VersionDnsRecord } from '../lib/routing-wait'
import { printRoutingSummary, waitForRouting } from '../lib/routing-wait'
import { sanitizeTerminal } from '../lib/sanitize'
import {
  cleanStagingDir,
  copyToStagingDir,
  getStagingDirPath,
  removeStagingDir,
} from '../lib/tasks'
import type { NamedBuildConfig } from '../types'

const CREATE_VERSION_MUTATION = /* GraphQL */ `
  mutation CreateVersion($config: JSON!, $environment: String, $gitRef: String) {
    createVersion(input: { config: $config, environment: $environment, gitRef: $gitRef }) {
      success
      message
      versionId
      versionNumber
      projectId
      projectSlug
    }
  }
`

const START_DEPLOYMENT_MUTATION = /* GraphQL */ `
  mutation StartLiftDeployment(
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
        teamId
        environmentId
        status
        lastMessage
        startedAt
        updatedAt
        completedAt
        projectName
        projectId
        serviceName
        environmentName
      }
    }
  }
`

const CANCEL_DEPLOYMENT_MUTATION = /* GraphQL */ `
  mutation CancelLiftDeployment($id: String!) {
    cancelDeployment(id: $id) {
      success
      message
      deployment {
        id
        status
        lastMessage
        updatedAt
      }
    }
  }
`

type StartedDeployment = NonNullable<StartLiftDeploymentMutation['startDeployment']['deployment']>

interface LiftOptions {
  cwd?: string
  file?: string
  force?: boolean
  delete?: boolean
  verbose?: boolean
  waitForCleanup?: boolean
  var?: string[]
}

interface LiftContext {
  deploymentIds: string[]
  versionId?: string
  versionNumber?: number
  projectId?: string
  projectSlug?: string
  builtImageTags?: Map<string, string>
  primaryDeployment?: StartedDeployment
  failedServices?: { id: string; name: string; message: string }[]
  routeUrls?: VersionRouteUrl[]
  dnsRecords?: VersionDnsRecord[]
}

function runSingleCommand(dir: string, command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const stderrChunks: Buffer[] = []
    const child = spawn(command, [], { cwd: dir, stdio: 'pipe', shell: true })

    child.stdout.on('data', () => {
      // Drained so a chatty build cannot stall on a full pipe; listr2 owns the terminal.
    })
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))

    child.on('error', (error) => {
      reject(
        new Error(
          `Build command failed to start: ${error.message}\nCommand: ${command}\nDirectory: ${dir}`
        )
      )
    })

    child.on('close', (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString().trim()
        const details = [
          `Build command failed with exit code ${String(code)}`,
          `Command: ${command}`,
          `Directory: ${dir}`,
        ]
        if (stderr) details.push(`Output:\n${stderr}`)
        reject(new Error(details.join('\n')))
        return
      }
      resolve()
    })
  })
}

async function runBuildInDir(
  dir: string,
  buildCommands: string | string[],
  onProgress?: (step: number, total: number, command: string) => void
): Promise<void> {
  const commands = Array.isArray(buildCommands) ? buildCommands : [buildCommands]

  for (let i = 0; i < commands.length; i++) {
    onProgress?.(i + 1, commands.length, commands[i])
    await runSingleCommand(dir, commands[i])
  }
}

/** Kahn's algorithm over `depends_on`. Cycles never reach here: the config parser rejects them. */
function topoSortBuilds(builds: Record<string, NamedBuildConfig>): [string, NamedBuildConfig][] {
  const names = Object.keys(builds)
  const inDegree: Record<string, number> = Object.fromEntries(names.map((name) => [name, 0]))
  const dependents: Record<string, string[]> = Object.fromEntries(names.map((name) => [name, []]))

  for (const name of names) {
    const dep = builds[name].depends_on
    if (!dep) continue
    if (!(dep in builds)) {
      throw new Error(`Build "${name}" depends on unknown build "${dep}"`)
    }
    inDegree[name] += 1
    dependents[dep].push(name)
  }

  const queue = names.filter((name) => inDegree[name] === 0)
  // The array iterator visits entries pushed during the loop, so this drains the queue.
  for (const current of queue) {
    for (const dependent of dependents[current]) {
      inDegree[dependent] -= 1
      if (inDegree[dependent] === 0) queue.push(dependent)
    }
  }

  return queue.map((name) => [name, builds[name]])
}

export function envBlockedTitle(paths: string[]): string {
  const noun = paths.length === 1 ? 'env file' : 'env files'
  return `Copy project files (left out ${noun}: ${paths.join(', ')}; add "!<path>" to .gantryignore to deploy one)`
}

export function registerLiftCommand(program: Command): void {
  program
    .command('lift <environment>')
    .description('Deploy a project to an environment')
    .option('-C, --cwd <directory>', 'Change working directory')
    .option('-f, --file <path>', 'Path to gantry.yml (defaults to ./gantry.yml)')
    .option('--force', 'Force re-upload all files, bypassing deduplication')
    .option('--delete', 'Delete stale files from storage that are no longer in the deployment')
    .option('-v, --verbose', 'Emit a log line per state change (useful for debugging and CI logs)')
    .option('--wait-for-cleanup', 'Wait for teardown of previous version resources before exiting')
    .option(
      '--var <key=value>',
      'Override a declared variable (repeatable). Highest precedence.',
      (value: string, prev: string[] | undefined) => (prev ? [...prev, value] : [value]),
      []
    )
    .action(async (environment: string, options: LiftOptions, command: Command) => {
      const cwd = globalCwd(command) ?? options.cwd
      const workingDir = cwd ? path.resolve(cwd) : process.cwd()
      // `--file` moves only where the config is read from; the working directory is still what ships.
      const yamlPath = options.file
        ? path.resolve(workingDir, options.file)
        : findConfigPath(workingDir)

      if (!yamlPath || !fs.existsSync(yamlPath)) {
        printError(`No gantry.yml or gantry.yaml found in ${workingDir}`)
        process.exit(1)
      }

      let cliVariables: Record<string, string>
      try {
        cliVariables = parseCliVarFlags(options.var)
      } catch (error) {
        printError(error instanceof Error ? error.message : 'Failed to parse --var flags')
        process.exit(1)
      }

      const resolveResult = await resolveYaml({ yamlPath, environment, cliVariables })
      if (!resolveResult.ok) {
        for (const err of resolveResult.errors) {
          const pathLabel = err.path ? ` (at ${err.path})` : ''
          printError(`${err.message}${pathLabel}`)
          if (err.suggestion) {
            process.stderr.write(`  hint: ${err.suggestion}\n`)
          }
        }
        process.exit(1)
      }
      const rawConfig = resolveResult.config
      const plannedBuilds = resolveResult.plan.builds
      let config: LiftConfig
      try {
        config = readLiftConfig(rawConfig)
      } catch (error) {
        printError(error instanceof Error ? error.message : 'Failed to read the resolved config')
        process.exit(1)
      }

      // Find the environment in the YAML
      const envKey = environment.toLowerCase()
      const envConfig = config.environments[envKey]

      if (!envConfig) {
        // Try to find a case-insensitive match
        const availableEnvs = Object.keys(config.environments)
        const matchingEnv = availableEnvs.find((e) => e.toLowerCase() === envKey)

        if (matchingEnv) {
          printError(`Environment '${environment}' not found. Did you mean '${matchingEnv}'?`)
        } else {
          printError(
            `Environment '${environment}' not found in gantry.yml. Available: ${availableEnvs.join(', ')}`
          )
        }
        process.exit(1)
      }

      const stagingDir = getStagingDirPath(workingDir)
      let cancelling = false
      let deploymentIds: string[] = []

      const handleSigint = async () => {
        if (cancelling) {
          process.exit(130)
        }

        cancelling = true
        console.log('\nCancelling deployment...')

        for (const id of deploymentIds) {
          try {
            await graphqlRequest<
              CancelLiftDeploymentMutation,
              CancelLiftDeploymentMutationVariables
            >(CANCEL_DEPLOYMENT_MUTATION, { id })
          } catch {
            // Best effort: keep cancelling the rest.
          }
        }
      }

      const onSigint = () => {
        void handleSigint()
      }
      process.on('SIGINT', onSigint)

      const setupCommands = config.setup?.commands

      try {
        const tasks = new Listr<LiftContext, CliRenderer>(
          [
            {
              title: 'Prepare staging directory',
              task: () => {
                cleanStagingDir(workingDir)
              },
            },

            {
              title: 'Copy project files',
              task: (_ctx, task) => {
                // Projects that ship untracked-but-required files (e.g. WordPress core) set `use_gitignore: false`.
                const envBlocked = copyToStagingDir(workingDir, config.setup?.use_gitignore ?? true)
                if (envBlocked.length > 0) {
                  task.title = sanitizeTerminal(envBlockedTitle(envBlocked))
                }
              },
            },

            {
              title: 'Create version',
              task: async (ctx, task) => {
                const result = await graphqlRequest<
                  CreateVersionMutation,
                  CreateVersionMutationVariables
                >(CREATE_VERSION_MUTATION, {
                  config: rawConfig,
                  environment,
                })

                const { createVersion } = result

                if (!createVersion.success || !createVersion.versionId) {
                  throw new Error(
                    sanitizeTerminal(createVersion.message ?? 'Failed to create version')
                  )
                }
                if (
                  createVersion.versionNumber === null ||
                  createVersion.projectId === null ||
                  !createVersion.projectSlug
                ) {
                  throw new Error('Failed to create version')
                }

                ctx.versionId = createVersion.versionId
                ctx.versionNumber = createVersion.versionNumber
                ctx.projectId = createVersion.projectId
                ctx.projectSlug = createVersion.projectSlug
                task.title = `Create version (v${String(createVersion.versionNumber)})`
              },
            },

            {
              title: 'Run setup commands',
              enabled: () => !!setupCommands,
              task: async (_ctx, task) => {
                if (!setupCommands) return
                const setupDir = config.setup?.working_dir
                  ? path.join(stagingDir, config.setup.working_dir)
                  : stagingDir
                await runBuildInDir(setupDir, setupCommands, (step, total, cmd) => {
                  task.title = `Run setup commands (${String(step)}/${String(total)}: ${cmd})`
                })
                task.title = 'Run setup commands'
              },
            },

            {
              title: 'Build Docker images',
              enabled: () => Object.keys(config.setup?.builds ?? {}).length > 0,
              task: async (ctx, task) => {
                const builds = config.setup?.builds
                if (!builds) throw new Error('Build step started without builds')
                const sorted = topoSortBuilds(builds)
                const total = sorted.length
                const { projectId, projectSlug, versionNumber } = ctx
                if (
                  projectId === undefined ||
                  projectSlug === undefined ||
                  versionNumber === undefined
                ) {
                  throw new Error('Cannot tag Docker images before the version is created')
                }

                ctx.builtImageTags = new Map()

                for (let i = 0; i < sorted.length; i++) {
                  const [buildName, buildConfig] = sorted[i]
                  task.title = `Build Docker images (${String(i + 1)}/${String(total)}: ${buildName})`

                  const localTag = `${projectId}-${projectSlug}-${buildName}:v${String(versionNumber)}`
                  const buildDir = buildConfig.working_dir
                    ? path.join(stagingDir, buildConfig.working_dir)
                    : stagingDir

                  const architecture = plannedBuilds.find(
                    (planned) => planned.name === buildName
                  )?.architecture
                  if (!architecture) {
                    throw new Error(`The deployment plan has no CPU architecture for ${buildName}`)
                  }

                  const dockerArgs = buildDockerBuildArgs({
                    tag: localTag,
                    dockerfile: buildConfig.dockerfile,
                    architecture,
                    target: buildConfig.docker_target,
                    buildArgs: buildConfig.args,
                  })

                  await runDocker(dockerArgs, { cwd: buildDir })
                  ctx.builtImageTags.set(buildName, localTag)
                }

                task.title = `Build Docker images (${String(total)} built)`
              },
            },

            {
              title: 'Start deployment',
              task: async (ctx, task) => {
                const startResult = await graphqlRequest<
                  StartLiftDeploymentMutation,
                  StartLiftDeploymentMutationVariables
                >(START_DEPLOYMENT_MUTATION, {
                  environment,
                  config: rawConfig,
                  versionId: ctx.versionId,
                  options: {
                    deleteStale: options.delete === true,
                    force: options.force === true,
                  },
                })

                const { startDeployment } = startResult

                if (!startDeployment.success || !startDeployment.deployment) {
                  throw new Error(
                    sanitizeTerminal(startDeployment.message ?? 'Failed to start deployment')
                  )
                }

                ctx.primaryDeployment = startDeployment.deployment
                ctx.deploymentIds = startDeployment.deploymentIds ?? [startDeployment.deployment.id]
                ctx.versionId = startDeployment.versionId ?? undefined
                deploymentIds = ctx.deploymentIds

                const dep = startDeployment.deployment
                const info: string[] = []
                if (dep.projectName) info.push(`Project: ${dep.projectName}`)
                if (dep.environmentName) info.push(`Environment: ${dep.environmentName}`)
                info.push(`Services: ${String(ctx.deploymentIds.length)}`)

                task.title = sanitizeTerminal(`Deployment started (${info.join(', ')})`)
              },
            },

            {
              title: 'Targets',
              task: async (ctx, task) => {
                if (!ctx.versionId) {
                  task.title = 'Targets: Skipped (no version ID)'
                  return
                }

                const subtasks = serviceDeploymentSubtasks<LiftContext>({
                  versionId: ctx.versionId,
                  deploymentIds: ctx.deploymentIds,
                  names: await serviceDeploymentNames(ctx.versionId),
                  taskContext: {
                    stagingDir,
                    cwd: workingDir,
                    force: options.force,
                    delete: options.delete,
                  },
                  isCancelling: () => cancelling,
                  onFailure: (subCtx, failure) => {
                    subCtx.failedServices = subCtx.failedServices ?? []
                    subCtx.failedServices.push(failure)
                  },
                })

                // exitOnError: false lets every service finish when a sibling fails; failed subtasks still throw, so they render ✖.
                return task.newListr(subtasks, { concurrent: true, exitOnError: false })
              },
            },

            {
              title: 'Configure routing',
              // Keeps every post-deploy command line on screen beneath the task.
              rendererOptions: { outputBar: Infinity, persistentOutput: true },
              skip: (ctx) => {
                if (!ctx.versionId) return true
                if (ctx.failedServices && ctx.failedServices.length > 0) {
                  const n = ctx.failedServices.length
                  return `${String(n)} service${n === 1 ? '' : 's'} failed, routing not applied`
                }
                return false
              },
              task: async (ctx, task) => {
                if (!ctx.versionId) throw new Error('Routing started without a version ID')
                const routing = await waitForRouting(
                  ctx.versionId,
                  () => cancelling,
                  (title) => {
                    task.title = title
                  },
                  (line) => {
                    task.output = line
                  }
                )
                ctx.routeUrls = routing.routeUrls
                ctx.dnsRecords = routing.dnsRecords
              },
            },

            {
              title: 'Cleanup',
              skip: (ctx) => {
                if (!ctx.versionId) return true
                if (ctx.failedServices && ctx.failedServices.length > 0) {
                  const n = ctx.failedServices.length
                  return `${String(n)} service${n === 1 ? '' : 's'} failed, nothing to clean up`
                }
                return false
              },
              task: async (ctx, task) => {
                if (!ctx.versionId) throw new Error('Cleanup started without a version ID')

                if (!options.waitForCleanup) {
                  // The new version is already live, so by default teardown finishes in the background.
                  let backgroundCount = 0
                  try {
                    const result = await graphqlRequest<
                      DeploymentsByVersionQuery,
                      DeploymentsByVersionQueryVariables
                    >(DEPLOYMENTS_BY_VERSION_QUERY, { versionId: ctx.versionId })
                    backgroundCount = result.deploymentsByVersion.filter(
                      (d) => d.deploymentType === 'teardown'
                    ).length
                  } catch {
                    // The count is informational; on failure, report none.
                  }

                  task.title =
                    backgroundCount > 0
                      ? `Cleanup: ${String(backgroundCount)} teardown${backgroundCount === 1 ? '' : 's'} running in background (use --wait-for-cleanup to block)`
                      : 'Cleanup: Nothing to clean up'
                  return
                }

                const CLEANUP_DISCOVERY_TIMEOUT_MS = 30_000
                const startTime = Date.now()
                let teardownDeployments: VersionDeployment[] = []

                while (teardownDeployments.length === 0) {
                  await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))

                  if (cancelling) {
                    task.title = 'Cleanup: Cancelled'
                    return
                  }

                  // Teardowns exist before routing completes, so a short wait is enough.
                  if (Date.now() - startTime > CLEANUP_DISCOVERY_TIMEOUT_MS) {
                    task.title = 'Cleanup: Nothing to clean up'
                    return
                  }

                  try {
                    const result = await graphqlRequest<
                      DeploymentsByVersionQuery,
                      DeploymentsByVersionQueryVariables
                    >(DEPLOYMENTS_BY_VERSION_QUERY, { versionId: ctx.versionId })

                    teardownDeployments = result.deploymentsByVersion.filter(
                      (d) => d.deploymentType === 'teardown'
                    )
                  } catch {
                    // Transient: the next poll retries.
                  }
                }

                const cleanupNameMap = new Map<string, string>()
                for (const dep of teardownDeployments) {
                  if (dep.serviceName) {
                    cleanupNameMap.set(dep.id, sanitizeTerminal(dep.serviceName))
                  }
                }

                const titleUpdaters = new Map<string, (title: string) => void>()
                const resolvers = new Map<string, () => void>()
                const completedCleanups = new Set<string>()

                const subtasks = teardownDeployments.map((dep) => ({
                  title: `${cleanupNameMap.get(dep.id) ?? dep.id}: Pending`,
                  task: async (_ctx: LiftContext, subtask: { title: string }) => {
                    titleUpdaters.set(dep.id, (title: string) => {
                      subtask.title = sanitizeTerminal(title)
                    })

                    return new Promise<void>((resolve) => {
                      resolvers.set(dep.id, resolve)
                    })
                  },
                }))

                const pollCleanup = async () => {
                  const { versionId } = ctx
                  if (!versionId) return
                  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- intentional infinite poll loop; exits via return statements below
                  while (true) {
                    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))

                    if (cancelling) {
                      for (const [id, resolve] of resolvers) {
                        if (!completedCleanups.has(id)) {
                          const updateTitle = titleUpdaters.get(id)
                          if (updateTitle) updateTitle(`${cleanupNameMap.get(id) ?? id}: Cancelled`)
                          completedCleanups.add(id)
                          resolve()
                        }
                      }
                      return
                    }

                    try {
                      const result = await graphqlRequest<
                        DeploymentsByVersionQuery,
                        DeploymentsByVersionQueryVariables
                      >(DEPLOYMENTS_BY_VERSION_QUERY, { versionId })

                      const currentTeardowns = result.deploymentsByVersion.filter(
                        (d) => d.deploymentType === 'teardown'
                      )

                      for (const deployment of currentTeardowns) {
                        const id = deployment.id
                        const updateTitle = titleUpdaters.get(id)

                        if (!updateTitle || completedCleanups.has(id)) continue

                        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty serviceName should fall back to the deployment id for display
                        const targetLabel = cleanupNameMap.get(id) || deployment.serviceName || id
                        const message = deployment.lastMessage
                          ? ` - ${sanitizeTerminal(deployment.lastMessage)}`
                          : ''

                        if (isTerminalStatus(deployment.status)) {
                          const normalized = deployment.status
                          if (normalized === 'COMPLETE') {
                            updateTitle(`${targetLabel}: Complete`)
                          } else if (normalized === 'FAILED') {
                            updateTitle(`${targetLabel}: Failed${message}`)
                          } else {
                            updateTitle(`${targetLabel}: ${deployment.status}`)
                          }
                          completedCleanups.add(id)
                          resolvers.get(id)?.()
                        } else {
                          updateTitle(`${targetLabel}: ${deployment.status}${message}`)
                        }
                      }

                      const allDone = teardownDeployments.every((d) => completedCleanups.has(d.id))
                      if (allDone) return
                    } catch {
                      // Transient: the next poll retries.
                    }
                  }
                }

                void pollCleanup()

                return task.newListr(subtasks, { concurrent: true })
              },
            },
          ],
          {
            exitOnError: true,
            renderer: resolveRenderer(options.verbose ?? false),
            fallbackRenderer: 'simple',
            fallbackRendererCondition: shouldUseFallbackRenderer,
            rendererOptions: {
              collapseSubtasks: false,
            },
          }
        )

        const finalCtx = await tasks.run({
          deploymentIds: [],
          versionId: undefined,
          versionNumber: undefined,
          projectId: undefined,
          projectSlug: undefined,
          builtImageTags: undefined,
          primaryDeployment: undefined,
        })

        printRoutingSummary(finalCtx)

        if (finalCtx.failedServices && finalCtx.failedServices.length > 0) {
          const n = finalCtx.failedServices.length
          const total = finalCtx.deploymentIds.length
          const noun = total === 1 ? '' : 's'
          printError(
            `Deployment failed: ${String(n)} of ${String(total)} service${noun} did not succeed`
          )
          process.exitCode = 1
        }
      } catch (error) {
        const errorMessage = formatApiError(error)
        // Listr has already rendered its own errors.
        if (!errorMessage.includes('Listr')) {
          printError(errorMessage)
        }
        process.removeListener('SIGINT', onSigint)
        removeStagingDir(workingDir)
        process.exit(1)
      } finally {
        process.removeListener('SIGINT', onSigint)
        removeStagingDir(workingDir)
      }
    })
}
