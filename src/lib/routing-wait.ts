import type {
  DeploymentsByVersionQuery,
  DeploymentsByVersionQueryVariables,
  GetRoutingDeploymentQuery,
  GetRoutingDeploymentQueryVariables,
  VersionDnsRecordsQuery,
  VersionDnsRecordsQueryVariables,
  VersionRouteUrlsQuery,
  VersionRouteUrlsQueryVariables,
} from '../generated/graphql'

import { graphqlRequest } from './client'
import { DEPLOYMENTS_BY_VERSION_QUERY, POLL_INTERVAL_MS } from './deployment-poll'
import { isTerminalStatus } from './deployment-status'
import { buildLiveUrlLines } from './live-urls'
import type { VersionRouteUrl } from './live-urls'
import { printHeading } from './output'
import { sanitizeTerminal } from './sanitize'

const ROUTING_DEPLOYMENT_QUERY = /* GraphQL */ `
  query GetRoutingDeployment($id: String!) {
    deployment(id: $id) {
      id
      status
      lastMessage
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

// Measured from when every service finishes, not from the start of the deploy.
const ROUTING_DISCOVERY_TIMEOUT_MS = 2 * 60 * 1000

export type VersionDnsRecord = VersionDnsRecordsQuery['versionDnsRecords'][number]

export interface RoutingResult {
  routeUrls?: VersionRouteUrl[]
  dnsRecords?: VersionDnsRecord[]
}

const sleep = () => new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))

async function findRoutingDeployment(
  versionId: string,
  isCancelling: () => boolean
): Promise<string | null> {
  const startTime = Date.now()
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- intentional poll loop; exits via return statements below
  while (true) {
    await sleep()
    if (isCancelling() || Date.now() - startTime > ROUTING_DISCOVERY_TIMEOUT_MS) return null
    try {
      const result = await graphqlRequest<
        DeploymentsByVersionQuery,
        DeploymentsByVersionQueryVariables
      >(DEPLOYMENTS_BY_VERSION_QUERY, { versionId })
      const routing = result.deploymentsByVersion.find((d) => d.scope === 'project-env')
      if (routing) return routing.id
    } catch {
      // Transient: the next poll retries.
    }
  }
}

async function liveRoutes(versionId: string): Promise<RoutingResult> {
  const result: RoutingResult = {}
  try {
    const routes = await graphqlRequest<VersionRouteUrlsQuery, VersionRouteUrlsQueryVariables>(
      VERSION_ROUTE_URLS_QUERY,
      { versionId }
    )
    result.routeUrls = routes.versionRouteUrls
  } catch {
    // Routing already succeeded; the URL list is informational.
  }
  try {
    const dns = await graphqlRequest<VersionDnsRecordsQuery, VersionDnsRecordsQueryVariables>(
      VERSION_DNS_RECORDS_QUERY,
      { versionId }
    )
    result.dnsRecords = dns.versionDnsRecords
  } catch {
    // Routing already succeeded; the DNS records are informational.
  }
  return result
}

/**
 * Follows the version's routing deployment until it settles, and returns the live URLs and DNS
 * records once it completes.
 *
 * @throws when routing fails.
 */
export async function waitForRouting(
  versionId: string,
  isCancelling: () => boolean,
  setTitle: (title: string) => void
): Promise<RoutingResult> {
  const routingDeploymentId = await findRoutingDeployment(versionId, isCancelling)
  if (isCancelling()) {
    setTitle('Configure routing: Cancelled')
    return {}
  }
  if (!routingDeploymentId) {
    setTitle('Configure routing: No routing configured')
    return {}
  }

  setTitle('Configure routing: Running')

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- intentional infinite poll loop; exits via return statements below
  while (true) {
    await sleep()

    if (isCancelling()) {
      setTitle('Configure routing: Cancelled')
      return {}
    }

    let deployment: GetRoutingDeploymentQuery['deployment']
    try {
      deployment = (
        await graphqlRequest<GetRoutingDeploymentQuery, GetRoutingDeploymentQueryVariables>(
          ROUTING_DEPLOYMENT_QUERY,
          { id: routingDeploymentId }
        )
      ).deployment
    } catch {
      // Transient: the next poll retries.
      continue
    }

    if (!deployment) {
      setTitle('Configure routing: Not found')
      return {}
    }

    const message = deployment.lastMessage ? ` - ${sanitizeTerminal(deployment.lastMessage)}` : ''
    setTitle(sanitizeTerminal(`Configure routing: ${deployment.status.toUpperCase()}${message}`))

    if (!isTerminalStatus(deployment.status)) continue

    if (deployment.status === 'FAILED') {
      throw new Error(`Routing failed${message}`)
    }
    if (deployment.status !== 'COMPLETE') {
      setTitle(sanitizeTerminal(`Configure routing: ${deployment.status.toUpperCase()}`))
      return {}
    }

    const routing = await liveRoutes(versionId)
    const urlCount = routing.routeUrls?.length ?? 0
    const urlSuffix =
      urlCount > 0 ? `: ${String(urlCount)} URL${urlCount === 1 ? '' : 's'} live` : ''
    setTitle(`Routing complete${urlSuffix}${message}`)
    return routing
  }
}

export function printRoutingSummary(routing: RoutingResult): void {
  const records = routing.dnsRecords ?? []
  if (records.length > 0) {
    printHeading('DNS records')
    const typeW = Math.max(...records.map((r) => sanitizeTerminal(r.recordType).length))
    const nameW = Math.max(...records.map((r) => sanitizeTerminal(r.name).length))
    for (const rec of records) {
      console.log(
        `  ${sanitizeTerminal(rec.recordType).padEnd(typeW)}  ${sanitizeTerminal(rec.name).padEnd(nameW)}  ${sanitizeTerminal(rec.value)}`
      )
    }
    if (records.some((r) => !r.managed)) {
      console.log('\n  Add the records above at your DNS provider.')
    }
  }

  if (routing.routeUrls && routing.routeUrls.length > 0) {
    printHeading('Deployed routes')
    for (const line of buildLiveUrlLines(routing.routeUrls)) {
      console.log(line)
    }
  }
}
