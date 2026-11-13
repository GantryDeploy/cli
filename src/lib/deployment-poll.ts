import type {
  ClaimStepMutation,
  ClaimStepMutationVariables,
  CompleteCliStepMutation,
  CompleteCliStepMutationVariables,
  DeploymentPhase,
  DeploymentsByVersionQuery,
  DeploymentsByVersionQueryVariables,
  FailCliStepMutation,
  FailCliStepMutationVariables,
} from '../generated/graphql'

import { formatApiError, GantryApiError, graphqlRequest } from './client'
import { isTerminalStatus } from './deployment-status'
import { redact, sanitizeTerminal } from './sanitize'
import { executeCliTask } from './tasks'
import type { TaskContext } from './tasks'

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
            architecture
          }
          ... on ObjectUploadCliInputs {
            stepId
            sourcePath
            includePatterns
            excludePatterns
            source {
              bucketName
              region
              keyPrefix
              aws {
                accessKeyId
                secretAccessKey
                sessionToken
              }
            }
          }
          ... on ContainerPushCliInputs {
            stepId
            imageUri
            localImageTag
            registryEndpoint
            registryUsername
            registryPassword
            source {
              imageUri
              registryEndpoint
              registryUsername
              registryPassword
            }
          }
          ... on ArtifactUploadCliInputs {
            stepId
            provider
            bucketName
            objectKey
            region
            maxArtifactBytes
            packageSourcePath: sourcePath
            excludePatterns
            aws {
              accessKeyId
              secretAccessKey
              sessionToken
            }
            source {
              bucketName
              objectKey
              region
              aws {
                accessKeyId
                secretAccessKey
                sessionToken
              }
            }
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

export const DEPLOYMENTS_BY_VERSION_QUERY = /* GraphQL */ `
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

export type VersionDeployment = DeploymentsByVersionQuery['deploymentsByVersion'][number]

type VersionDeploymentStep = NonNullable<VersionDeployment['steps']>[number]

const TIMEOUT_MS = 5 * 60 * 1000

export const POLL_INTERVAL_MS = 2000

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
  taskContext: TaskContext,
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
    const { outputs, fileResults } = await executeCliTask(claimedStep.cliInputs, taskContext)

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
  taskContext: TaskContext,
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
          titleUpdaters.get(id)?.(`${id}: Cancelled`)
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
        if (!resolvers.has(id) || completedDeployments.has(id)) continue
        const updateTitle = (title: string) => titleUpdaters.get(id)?.(title)

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
              const claim = await handleCliStep(pendingStep, targetLabel, taskContext, updateTitle)
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

      const allTargetsDone = [...resolvers.keys()].every((id) => completedDeployments.has(id))
      if (allTargetsDone) {
        return
      }

      if (Date.now() - lastActivityTime > TIMEOUT_MS) {
        for (const id of resolvers.keys()) {
          if (!completedDeployments.has(id)) {
            titleUpdaters.get(id)?.(`${id}: Timed out`)
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
        for (const id of resolvers.keys()) {
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

      for (const id of resolvers.keys()) {
        if (!completedDeployments.has(id)) {
          titleUpdaters.get(id)?.(
            `${id}: Retrying (${String(consecutiveNetworkErrors)}/${String(MAX_CONSECUTIVE_NETWORK_ERRORS)})... ${formattedError}`
          )
        }
      }
    }
  }
}

/** Service names by deployment ID, leaving out the routing and teardown deployments. */
export async function serviceDeploymentNames(versionId: string): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  try {
    const result = await graphqlRequest<
      DeploymentsByVersionQuery,
      DeploymentsByVersionQueryVariables
    >(DEPLOYMENTS_BY_VERSION_QUERY, { versionId })
    for (const deployment of result.deploymentsByVersion) {
      if (
        deployment.serviceName &&
        deployment.scope !== 'project-env' &&
        deployment.deploymentType !== 'teardown'
      ) {
        names.set(deployment.id, sanitizeTerminal(deployment.serviceName))
      }
    }
  } catch {
    // Subtasks show IDs until the first poll names them.
  }
  return names
}

export interface ServiceFailure {
  id: string
  name: string
  message: string
}

/**
 * One subtask per service deployment. A single poller settles them all and claims and runs the
 * CLI steps the deployments wait on.
 */
export function serviceDeploymentSubtasks<Ctx>(params: {
  versionId: string
  deploymentIds: string[]
  names: Map<string, string>
  taskContext: TaskContext
  isCancelling: () => boolean
  onFailure: (ctx: Ctx, failure: ServiceFailure) => void
}): { title: string; task: (ctx: Ctx, subtask: { title: string }) => Promise<void> }[] {
  const { versionId, deploymentIds, names, taskContext, isCancelling, onFailure } = params
  const titleUpdaters = new Map<string, (title: string) => void>()
  const resolvers = new Map<string, () => void>()
  const rejecters = new Map<string, (error: Error) => void>()
  // Created up front: the poller can settle a service before listr starts its subtask.
  const outcomes = new Map(
    deploymentIds.map((id) => {
      const outcome = new Promise<void>((resolve, reject) => {
        resolvers.set(id, resolve)
        rejecters.set(id, reject)
      })
      outcome.catch(() => undefined)
      return [id, outcome] as const
    })
  )

  const subtasks = deploymentIds.map((id) => ({
    title: `${names.get(id) ?? id}: Waiting...`,
    task: async (ctx: Ctx, subtask: { title: string }) => {
      titleUpdaters.set(id, (title: string) => {
        subtask.title = sanitizeTerminal(title)
      })

      try {
        await outcomes.get(id)
      } catch (error) {
        onFailure(ctx, {
          id,
          name: names.get(id) ?? id,
          message: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
    },
  }))

  // Not awaited: the poller settles each service's outcome.
  void pollAllDeployments(versionId, taskContext, titleUpdaters, resolvers, rejecters, isCancelling)

  return subtasks
}
