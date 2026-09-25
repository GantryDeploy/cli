import type { DeploymentStatus } from '../generated/graphql'

const TERMINAL_STATUSES: ReadonlySet<DeploymentStatus> = new Set([
  'COMPLETE',
  'FAILED',
  'CANCELLED',
  'SKIPPED',
])

export function isTerminalStatus(status: DeploymentStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}
