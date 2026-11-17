import type {
  GetReleaseDeploymentQuery,
  GetReleaseDeploymentQueryVariables,
} from '../generated/graphql'

import { graphqlRequest } from './client'
import { isTerminalStatus } from './deployment-status'
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
    }
  }
`

/** A release operation that ended without completing. The message is safe to print. */
export class ReleaseOutcomeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReleaseOutcomeError'
  }
}

/**
 * Follows the deployment a release operation started until it settles, showing its progress
 * through `setTitle`.
 *
 * @throws ReleaseOutcomeError unless the deployment completes.
 */
export async function waitForRelease(
  deploymentId: string,
  setTitle: (title: string) => void
): Promise<void> {
  const startTime = Date.now()
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

    const message = deployment.lastMessage ? `: ${sanitizeTerminal(deployment.lastMessage)}` : ''
    setTitle(sanitizeTerminal(`Apply: ${deployment.status}${message}`))
    if (!isTerminalStatus(deployment.status)) continue

    switch (deployment.status) {
      case 'COMPLETE':
        setTitle(`Applied${message}`)
        return
      case 'FAILED':
        throw new ReleaseOutcomeError(`Failed${message}`)
      case 'CANCELLED':
        throw new ReleaseOutcomeError(`Cancelled${message}`)
      default:
        throw new ReleaseOutcomeError(`Skipped${message}`)
    }
  }
}
