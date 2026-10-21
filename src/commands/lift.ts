import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

import type { Command } from 'commander'
import { Listr } from 'listr2'

import type {
  CancelLiftDeploymentMutation,
  CancelLiftDeploymentMutationVariables,
  ClaimStepMutation,
  ClaimStepMutationVariables,
  CompleteCliStepMutation,
  CompleteCliStepMutationVariables,
  CreateVersionMutation,
  CreateVersionMutationVariables,
  DeploymentPhase,
  DeploymentsByVersionQuery,
  DeploymentsByVersionQueryVariables,
  FailCliStepMutation,
  FailCliStepMutationVariables,
  GetLiftDeploymentQuery,
  GetLiftDeploymentQueryVariables,
  StartLiftDeploymentMutation,
  StartLiftDeploymentMutationVariables,
  VersionDnsRecordsQuery,
  VersionDnsRecordsQueryVariables,
  VersionRouteUrlsQuery,
  VersionRouteUrlsQueryVariables,
} from '../generated/graphql'
import { formatApiError, GantryApiError, graphqlRequest } from '../lib/client'
import { globalCwd } from '../lib/command-options'
import { isTerminalStatus } from '../lib/deployment-status'
import { buildDockerBuildArgs, runDocker } from '../lib/exec'
import { readLiftConfig } from '../lib/lift-config'
import type { LiftConfig } from '../lib/lift-config'
import { resolveRenderer, shouldUseFallbackRenderer, type CliRenderer } from '../lib/listr'
import { buildLiveUrlLines } from '../lib/live-urls'
import type { VersionRouteUrl } from '../lib/live-urls'
import { printError, printHeading } from '../lib/output'
import { findConfigPath } from '../lib/project-identity'
import { parseCliVarFlags, resolveYaml } from '../lib/resolve-yaml'
import { redact, sanitizeTerminal } from '../lib/sanitize'
import {
  cleanStagingDir,
  copyToStagingDir,
  executeCliTask,
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

const DEPLOYMENT_QUERY = /* GraphQL */ `
  query GetLiftDeployment($id: String!) {
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
      serviceName
      environmentName
      steps {
        id
        stepType
        status
        phase
        executor
        cliTask
        cliStatus
        sequence
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

const CLAIM_STEP_MUTATION = /* GraphQL */ `
  mutation ClaimStep($stepId: String!) {
    claimStep(stepId: $stepId) {
      success
      message
      step {
        id
        stepType
        cliTask
        cliInputs {
          __typename
          ... on LocalBuildCliInputs {
            stepId
            serviceName
            versionNumber
            projectId
            projectSlug
            buildCommands
            dockerfile
            buildArgs {
              name
              value
            }
            workingDir
            dockerTarget
            namedBuildName
          }
          ... on S3UploadCliInputs {
            stepId
            sourcePath
            includePatterns
            excludePatterns
          }
          ... on ContainerPushCliInputs {
            stepId
            imageUri
            localImageTag
            ecrAuthToken
            ecrEndpoint
          }
          ... on ArtifactUploadCliInputs {
            stepId
            bucketName
            s3Key
            region
            accessKeyId
            secretAccessKey
            sessionToken
            sourcePath
            excludePatterns
          }
        }
      }
    }
  }
`

const COMPLETE_CLI_STEP_MUTATION = /* GraphQL */ `
  mutation CompleteCliStep(
    $stepId: String!
    $outputs: CliTaskOutputsInput!
    $fileResults: [FileUploadResultInput!]
  ) {
    completeCliStep(stepId: $stepId, outputs: $outputs, fileResults: $fileResults) {
      success
      message
    }
  }
`

const FAIL_CLI_STEP_MUTATION = /* GraphQL */ `
  mutation FailCliStep($stepId: String!, $error: String!) {
    failCliStep(stepId: $stepId, error: $error) {
      success
      message
    }
  }
`

const DEPLOYMENTS_BY_VERSION_QUERY = /* GraphQL */ `
  query DeploymentsByVersion($versionId: String!) {
    deploymentsByVersion(versionId: $versionId) {
      id
      status
      scope
      deploymentType
      lastMessage
      serviceName
      steps {
        id
        stepType
        status
        phase
        executor
        cliTask
        cliStatus
        sequence
      }
    }
  }
`

const VERSION_ROUTE_URLS_QUERY = /* GraphQL */ `
  query VersionRouteUrls($versionId: String!) {
    versionRouteUrls(versionId: $versionId) {
      url
      domain
      path
      serviceName
      cache
    }
  }
`

const VERSION_DNS_RECORDS_QUERY = /* GraphQL */ `
  query VersionDnsRecords($versionId: String!) {
    versionDnsRecords(versionId: $versionId) {
      hostname
      recordType
      name
      value
      managed
      syncStatus
    }
  }
`

type VersionDnsRecord = VersionDnsRecordsQuery['versionDnsRecords'][number]

type VersionDeployment = DeploymentsByVersionQuery['deploymentsByVersion'][number]

type VersionDeploymentStep = NonNullable<VersionDeployment['steps']>[number]

type StartedDeployment = NonNullable<StartLiftDeploymentMutation['startDeployment']['deployment']>

const TIMEOUT_MS = 5 * 60 * 1000

// Measured from when every service finishes, not from the start of the lift.
const ROUTING_DISCOVERY_TIMEOUT_MS = 2 * 60 * 1000

const POLL_INTERVAL_MS = 2000

interface LiftOptions {
  cwd?: string
  file?: string
  force?: boolean
  delete?: boolean
  verbose?: boolean
  waitForCleanup?: boolean
  var?: string[]
}

function findPendingCliStep(steps: VersionDeploymentStep[] | null): VersionDeploymentStep | null {
  if (!steps) return null

  return (
    steps.find(
      (s) =>
        (s.status === 'AWAITING_CLI' || s.status === 'MANIFEST_REQUIRED') &&
        s.cliStatus === 'PENDING' &&
        s.executor === 'CLI' &&
        s.cliTask
    ) ?? null
  )
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

const PHASE_LABELS: Record<DeploymentPhase, string> = {
  BUILDING: 'Building',
  SETUP: 'Setup',
  UPLOADING: 'Uploading',
  DEPLOYING: 'Deploying',
  GO_LIVE: 'Go Live',
  POST_DEPLOY: 'Cleanup',
}

export function getPhaseDisplay(deployment: VersionDeployment): string {
  if (!deployment.steps || deployment.steps.length === 0) {
    return deployment.status.toUpperCase()
  }

  const activeStep = deployment.steps.find(
    (s) =>
      s.status === 'PROCESSING' ||
      s.status === 'AWAITING_CLI' ||
      s.status === 'QUEUED' ||
      s.status === 'MANIFEST_REQUIRED'
  )

  if (activeStep) {
    return PHASE_LABELS[activeStep.phase]
  }

  return deployment.status.toUpperCase()
}

async function handleCliStep(
  step: VersionDeploymentStep,
  targetLabel: string,
  stagingDir: string,
  workingDir: string,
  options: LiftOptions,
  updateTitle: (title: string) => void
): Promise<{ refusal: string } | null> {
  updateTitle(`${targetLabel}: Claiming step ${String(step.cliTask)}...`)

  const claimResult = await graphqlRequest<ClaimStepMutation, ClaimStepMutationVariables>(
    CLAIM_STEP_MUTATION,
    { stepId: step.id }
  )

  const claimedStep = claimResult.claimStep.step
  if (!claimResult.claimStep.success || !claimedStep) {
    const refusal = sanitizeTerminal(
      claimResult.claimStep.message ?? 'The step could not be claimed.'
    )
    updateTitle(`${targetLabel}: ${refusal}`)
    return { refusal }
  }

  updateTitle(`${targetLabel}: ${String(claimedStep.cliTask)}...`)

  try {
    if (!claimedStep.cliInputs) {
      throw new Error('Claimed step is missing its CLI inputs')
    }
    const { outputs, fileResults } = await executeCliTask(claimedStep.cliInputs, {
      stagingDir,
      cwd: workingDir,
      force: options.force,
      delete: options.delete,
    })

    updateTitle(`${targetLabel}: Completing ${String(claimedStep.cliTask)}...`)

    await graphqlRequest<CompleteCliStepMutation, CompleteCliStepMutationVariables>(
      COMPLETE_CLI_STEP_MUTATION,
      {
        stepId: claimedStep.id,
        outputs,
        fileResults: fileResults ?? null,
      }
    )
  } catch (taskError) {
    const errorMessage = taskError instanceof Error ? taskError.message : 'Unknown error'

    await graphqlRequest<FailCliStepMutation, FailCliStepMutationVariables>(
      FAIL_CLI_STEP_MUTATION,
      { stepId: step.id, error: redact(errorMessage) }
    )

    throw taskError
  }
  return null
}

/** One batch query per cycle drives every service's subtask. */
async function pollAllDeployments(
  versionId: string,
  stagingDir: string,
  workingDir: string,
  options: LiftOptions,
  titleUpdaters: Map<string, (title: string) => void>,
  resolvers: Map<string, () => void>,
  rejecters: Map<string, (error: Error) => void>,
  isCancelling: () => boolean
): Promise<void> {
  const MAX_CONSECUTIVE_NETWORK_ERRORS = 10
  let lastActivityTime: number
  let consecutiveNetworkErrors = 0
  const completedDeployments = new Set<string>()
  const claimingSteps = new Set<string>()
  const refusedClaims = new Map<string, string>()

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- intentional infinite poll loop; exits via return statements below
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))

    if (isCancelling()) {
      for (const [id, resolve] of resolvers) {
        if (!completedDeployments.has(id)) {
          const updateTitle = titleUpdaters.get(id)
          if (updateTitle) updateTitle(`${id}: Cancelled`)
          completedDeployments.add(id)
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

      consecutiveNetworkErrors = 0
      lastActivityTime = Date.now()

      for (const deployment of result.deploymentsByVersion) {
        const id = deployment.id
        const updateTitle = titleUpdaters.get(id)

        if (!updateTitle || completedDeployments.has(id)) continue

        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty serviceName should fall back to the deployment id for display
        const targetLabel = sanitizeTerminal(deployment.serviceName || id)
        const phaseDisplay = getPhaseDisplay(deployment)
        const message = deployment.lastMessage
          ? ` - ${sanitizeTerminal(deployment.lastMessage)}`
          : ''

        updateTitle(`${targetLabel}: ${phaseDisplay}${message}`)

        if (!isCancelling()) {
          const pendingStep = findPendingCliStep(deployment.steps)

          if (pendingStep && !claimingSteps.has(pendingStep.id)) {
            // A refused step that is still unclaimed a poll later has no CLI driving it.
            const refusal = refusedClaims.get(pendingStep.id)
            if (refusal) {
              updateTitle(`${targetLabel}: Failed - ${refusal}`)
              completedDeployments.add(id)
              rejecters.get(id)?.(new Error(`${targetLabel}: ${refusal}`))
              continue
            }

            claimingSteps.add(pendingStep.id)
            try {
              const claim = await handleCliStep(
                pendingStep,
                targetLabel,
                stagingDir,
                workingDir,
                options,
                updateTitle
              )
              if (claim) refusedClaims.set(pendingStep.id, claim.refusal)
            } catch (_error) {
              // The failure surfaces as a FAILED deployment on the next poll.
            } finally {
              claimingSteps.delete(pendingStep.id)
              lastActivityTime = Date.now()
            }
            // This cycle's status predates the step; judge it on the next poll.
            continue
          }
        }

        if (isTerminalStatus(deployment.status)) {
          const normalized = deployment.status

          if (normalized === 'COMPLETE') {
            updateTitle(`${targetLabel}: Complete`)
            completedDeployments.add(id)
            resolvers.get(id)?.()
          } else if (normalized === 'FAILED') {
            updateTitle(`${targetLabel}: Failed${message}`)
            completedDeployments.add(id)
            rejecters.get(id)?.(new Error(`${targetLabel}: Deployment failed${message}`))
          } else if (normalized === 'CANCELLED') {
            updateTitle(`${targetLabel}: Cancelled`)
            completedDeployments.add(id)
            resolvers.get(id)?.()
          } else if (normalized === 'SKIPPED') {
            updateTitle(`${targetLabel}: Skipped${message}`)
            completedDeployments.add(id)
            resolvers.get(id)?.()
          }
        }
      }

      const allTargetsDone = [...titleUpdaters.keys()].every((id) => completedDeployments.has(id))
      if (allTargetsDone) {
        return
      }

      if (Date.now() - lastActivityTime > TIMEOUT_MS) {
        for (const [id] of titleUpdaters) {
          if (!completedDeployments.has(id)) {
            const updateTitle = titleUpdaters.get(id)
            if (updateTitle) updateTitle(`${id}: Timed out`)
            completedDeployments.add(id)
            rejecters.get(id)?.(new Error(`Timed out (no activity for 5 minutes)`))
          }
        }
        return
      }
    } catch (error) {
      consecutiveNetworkErrors++
      const formattedError = formatApiError(error)

      const statusLabel =
        error instanceof GantryApiError && error.statusCode
          ? ` (HTTP ${String(error.statusCode)})`
          : ''

      if (consecutiveNetworkErrors >= MAX_CONSECUTIVE_NETWORK_ERRORS) {
        for (const [id] of titleUpdaters) {
          if (!completedDeployments.has(id)) {
            const targetLabel = id
            completedDeployments.add(id)
            rejecters.get(id)?.(
              new Error(
                `${targetLabel}: Deployment status unknown - CLI could not reach Gantry API after ${String(MAX_CONSECUTIVE_NETWORK_ERRORS)} attempts. Last error${statusLabel}: ${formattedError}`
              )
            )
          }
        }
        return
      }

      const backoffDelay = Math.min(2000 * Math.pow(2, consecutiveNetworkErrors - 1), 60_000)
      await new Promise((resolve) => setTimeout(resolve, backoffDelay))

      for (const [id, updateTitle] of titleUpdaters) {
        if (!completedDeployments.has(id)) {
          updateTitle(
            `${id}: Retrying (${String(consecutiveNetworkErrors)}/${String(MAX_CONSECUTIVE_NETWORK_ERRORS)})... ${formattedError}`
          )
        }
      }
    }
  }
}

export function registerLiftCommand(program: Command): void {
  program
    .command('lift <environment>')
    .description('Deploy a project to an environment')
    .option('-C, --cwd <directory>', 'Change working directory')
    .option('-f, --file <path>', 'Path to gantry.yml (defaults to ./gantry.yml)')
    .option('--force', 'Force re-upload all files, bypassing deduplication')
    .option('--delete', 'Delete stale files from S3 that are no longer in the deployment')
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

                  const dockerArgs = buildDockerBuildArgs({
                    tag: localTag,
                    dockerfile: buildConfig.dockerfile,
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

                const nameMap = new Map<string, string>()
                try {
                  const result = await graphqlRequest<
                    DeploymentsByVersionQuery,
                    DeploymentsByVersionQueryVariables
                  >(DEPLOYMENTS_BY_VERSION_QUERY, { versionId: ctx.versionId })

                  for (const dep of result.deploymentsByVersion) {
                    if (
                      dep.serviceName &&
                      dep.scope !== 'project-env' &&
                      dep.deploymentType !== 'teardown'
                    ) {
                      nameMap.set(dep.id, sanitizeTerminal(dep.serviceName))
                    }
                  }
                } catch {
                  // Subtasks show IDs until the first poll names them.
                }

                const titleUpdaters = new Map<string, (title: string) => void>()
                const resolvers = new Map<string, () => void>()
                const rejecters = new Map<string, (error: Error) => void>()

                const subtasks = ctx.deploymentIds.map((id) => ({
                  title: `${nameMap.get(id) ?? id}: Waiting...`,
                  task: async (subCtx: LiftContext, subtask: { title: string }) => {
                    titleUpdaters.set(id, (title: string) => {
                      subtask.title = sanitizeTerminal(title)
                    })

                    try {
                      await new Promise<void>((resolve, reject) => {
                        resolvers.set(id, resolve)
                        rejecters.set(id, reject)
                      })
                    } catch (error) {
                      subCtx.failedServices = subCtx.failedServices ?? []
                      subCtx.failedServices.push({
                        id,
                        name: nameMap.get(id) ?? id,
                        message: error instanceof Error ? error.message : String(error),
                      })
                      throw error
                    }
                  },
                }))

                // Not awaited: the poller settles each subtask's promise. Its first cycle waits
                // POLL_INTERVAL_MS, which gives the subtasks time to register their title updaters.
                void pollAllDeployments(
                  ctx.versionId,
                  stagingDir,
                  workingDir,
                  options,
                  titleUpdaters,
                  resolvers,
                  rejecters,
                  () => cancelling
                )

                // exitOnError: false lets every service finish when a sibling fails; failed subtasks still throw, so they render ✖.
                return task.newListr(subtasks, { concurrent: true, exitOnError: false })
              },
            },

            {
              title: 'Configure routing',
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

                const startTime = Date.now()
                let routingDeploymentId: string | null = null

                while (!routingDeploymentId) {
                  await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))

                  if (cancelling) {
                    task.title = 'Configure routing: Cancelled'
                    return
                  }

                  if (Date.now() - startTime > ROUTING_DISCOVERY_TIMEOUT_MS) {
                    task.title = 'Configure routing: No routing configured'
                    return
                  }

                  try {
                    const result = await graphqlRequest<
                      DeploymentsByVersionQuery,
                      DeploymentsByVersionQueryVariables
                    >(DEPLOYMENTS_BY_VERSION_QUERY, { versionId: ctx.versionId })

                    const routingDep = result.deploymentsByVersion.find(
                      (d) => d.scope === 'project-env'
                    )

                    if (routingDep) {
                      routingDeploymentId = routingDep.id
                    }
                  } catch {
                    // Transient: the next poll retries.
                  }
                }

                task.title = 'Configure routing: Running'

                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- intentional infinite poll loop; exits via return statements below
                while (true) {
                  await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))

                  if (cancelling) {
                    task.title = 'Configure routing: Cancelled'
                    return
                  }

                  try {
                    const result = await graphqlRequest<
                      GetLiftDeploymentQuery,
                      GetLiftDeploymentQueryVariables
                    >(DEPLOYMENT_QUERY, { id: routingDeploymentId })

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
                        try {
                          const routes = await graphqlRequest<
                            VersionRouteUrlsQuery,
                            VersionRouteUrlsQueryVariables
                          >(VERSION_ROUTE_URLS_QUERY, { versionId: ctx.versionId })
                          ctx.routeUrls = routes.versionRouteUrls
                        } catch {
                          // Routing already succeeded; the URL list is informational.
                        }
                        try {
                          const dns = await graphqlRequest<
                            VersionDnsRecordsQuery,
                            VersionDnsRecordsQueryVariables
                          >(VERSION_DNS_RECORDS_QUERY, { versionId: ctx.versionId })
                          ctx.dnsRecords = dns.versionDnsRecords
                        } catch {
                          // Routing already succeeded; the DNS records are informational.
                        }
                        const urlCount = ctx.routeUrls?.length ?? 0
                        const urlSuffix =
                          urlCount > 0
                            ? `: ${String(urlCount)} URL${urlCount === 1 ? '' : 's'} live`
                            : ''
                        task.title = `Routing complete${urlSuffix}${message}`
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
                        error.message.includes('not found'))
                    ) {
                      throw error
                    }
                    // Transient: the next poll retries.
                  }
                }
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

        if (finalCtx.dnsRecords && finalCtx.dnsRecords.length > 0) {
          printHeading('DNS records')
          const recs = finalCtx.dnsRecords
          const typeW = Math.max(...recs.map((r) => sanitizeTerminal(r.recordType).length))
          const nameW = Math.max(...recs.map((r) => sanitizeTerminal(r.name).length))
          for (const rec of recs) {
            console.log(
              `  ${sanitizeTerminal(rec.recordType).padEnd(typeW)}  ${sanitizeTerminal(rec.name).padEnd(nameW)}  ${sanitizeTerminal(rec.value)}`
            )
          }
          if (recs.some((r) => !r.managed)) {
            console.log('\n  Add the records above at your DNS provider.')
          }
        }

        if (finalCtx.routeUrls && finalCtx.routeUrls.length > 0) {
          printHeading('Deployed routes')
          for (const line of buildLiveUrlLines(finalCtx.routeUrls)) {
            console.log(line)
          }
        }

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
