import type {
  DeploymentsByVersionQuery,
  ReleaseOutputQuery,
  ReleaseOutputQueryVariables,
} from '../generated/graphql'

import { graphqlRequest } from './client'

export const RELEASE_OUTPUT_QUERY = /* GraphQL */ `
  query ReleaseOutput($versionId: String!, $after: String) {
    releaseOutput(versionId: $versionId, after: $after) {
      lines {
        message
        deploymentId
      }
      cursor
    }
  }
`

type Deployments = DeploymentsByVersionQuery['deploymentsByVersion']

const FINISHED = new Set(['COMPLETE', 'FAILED', 'CANCELLED'])

function releaseSteps(deployments: Deployments) {
  return deployments.flatMap((deployment) =>
    (deployment.steps ?? []).filter(
      (step) => step.stepType === 'release' && step.status !== 'QUEUED'
    )
  )
}

/**
 * Follows a version's release command output across polls, passing each new line to `write` with
 * the deployment it belongs to. Once every release step has finished it reads until no new lines
 * arrive, then stops asking.
 */
export function followReleaseOutput(
  versionId: string,
  write: (deploymentId: string, line: string) => void
): (deployments: Deployments) => Promise<void> {
  let cursor: string | undefined
  let drained = false

  return async (deployments) => {
    const steps = releaseSteps(deployments)
    if (drained || steps.length === 0) return

    const { releaseOutput } = await graphqlRequest<ReleaseOutputQuery, ReleaseOutputQueryVariables>(
      RELEASE_OUTPUT_QUERY,
      { versionId, after: cursor }
    )
    const previous = cursor
    cursor = releaseOutput.cursor ?? cursor
    for (const line of releaseOutput.lines) write(line.deploymentId, line.message)

    // A page can hold no release lines and still move on past other logs, so the end is a page
    // that left the cursor where it was.
    if (cursor === previous && steps.every((step) => FINISHED.has(step.status))) {
      drained = true
    }
  }
}
