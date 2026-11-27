import type {
  GetReleaseDeploymentQuery,
  GetReleaseDeploymentQueryVariables,
} from '../generated/graphql'

import { graphqlRequest } from './client'
import { isTerminalStatus } from './deployment-status'
import { MAX_DRAIN_PAGES, followReleaseOutput } from './release-output'
import { sanitizeTerminal } from './sanitize'

export const RELEASE_POLL_INTERVAL_MS = 2000

// A CloudFront edge can take well over 10 minutes to apply.
export const RELEASE_TIMEOUT_MS = 30 * 60 * 1000

const DEPLOYMENT_QUERY = /* GraphQL */ `
  query GetReleaseDeployment($id: String!) {
    deployment(id: $id) {
      id
      status
      lastMessage
      versionId
      steps {
        stepType
        status
      }
    }
  }
`

type ReleaseDeployment = NonNullable<GetReleaseDeploymentQuery['deployment']>

/** A release operation that ended without completing. The message is safe to print. */
export class ReleaseOutcomeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReleaseOutcomeError'
  }
}

/**
 * Follows the deployment a release operation started until it settles, showing its progress
 * through `setTitle` and each line of the post-deploy commands it runs through `writeOutput`.
 *
 * @throws ReleaseOutcomeError unless the deployment completes.
 */
export async function waitForRelease(
  deploymentId: string,
  setTitle: (title: string) => void,
  writeOutput: (line: string) => void
): Promise<void> {
  const startTime = Date.now()
  let follow: ReturnType<typeof followReleaseOutput> | undefined
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- intentional poll loop; exits via return or throw
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, RELEASE_POLL_INTERVAL_MS))
    if (Date.now() - startTime > RELEASE_TIMEOUT_MS) {
      throw new ReleaseOutcomeError(
        `Still running after 30 minutes. It keeps running; check it with \`gantry deployments show ${deploymentId}\`.`
      )
    }

    let deployment: GetReleaseDeploymentQuery['deployment']
    try {
      deployment = (
        await graphqlRequest<GetReleaseDeploymentQuery, GetReleaseDeploymentQueryVariables>(
          DEPLOYMENT_QUERY,
          { id: deploymentId }
        )
      ).deployment
    } catch {
      // Transient: the next poll retries.
      continue
    }

    if (!deployment) throw new ReleaseOutcomeError(`Deployment ${deploymentId} not found.`)

    if (deployment.versionId) {
      follow ??= followReleaseOutput(deployment.versionId, (lineDeploymentId, line) => {
        if (lineDeploymentId === deploymentId) writeOutput(sanitizeTerminal(line))
      })
      await readOutput(follow, deployment)
    }

    const message = deployment.lastMessage ? `: ${sanitizeTerminal(deployment.lastMessage)}` : ''
    setTitle(sanitizeTerminal(`Apply: ${deployment.status}${message}`))
    if (!isTerminalStatus(deployment.status)) continue

    switch (deployment.status) {
      case 'COMPLETE':
        setTitle(`Applied${message}`)
        return
      case 'FAILED':
        throw new ReleaseOutcomeError(
          postDeployFailed(deployment)
            ? `Post-deploy commands failed, and the new version is live${message}`
            : `Failed${message}`
        )
      case 'CANCELLED':
        throw new ReleaseOutcomeError(`Cancelled${message}`)
      default:
        throw new ReleaseOutcomeError(`Skipped${message}`)
    }
  }
}

/** Reads the next page of output, or every remaining page once the deployment has settled. */
async function readOutput(
  follow: ReturnType<typeof followReleaseOutput>,
  deployment: ReleaseDeployment
): Promise<void> {
  const pages = isTerminalStatus(deployment.status) ? MAX_DRAIN_PAGES : 1
  try {
    for (let page = 0; page < pages; page++) {
      if (await follow([deployment])) return
    }
  } catch {
    // The output stays stored; the next poll reads from the same cursor.
  }
}

function postDeployFailed(deployment: ReleaseDeployment): boolean {
  return (deployment.steps ?? []).some(
    (step) => step.stepType === 'post-deploy' && step.status === 'FAILED'
  )
}
