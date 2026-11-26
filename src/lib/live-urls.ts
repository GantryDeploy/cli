/** One routable URL for a version, as returned by the `versionRouteUrls` query. */
export interface VersionRouteUrl {
  url: string
  domain?: string | null
  path: string
  serviceName: string
  /** Short label for the path's cache (`not cached`, `cached 1y`, or a named policy), if any. */
  cache?: string | null
}

/**
 * Format the post-deploy "Deployed routes" summary: each hostname, then one line per path as
 * written in gantry.yml with its service and cache. Columns align within a hostname.
 */
export function buildLiveUrlLines(routes: VersionRouteUrl[]): string[] {
  const byDomain = new Map<string, VersionRouteUrl[]>()
  for (const route of routes) {
    const domain = route.domain ?? new URL(route.url).host
    byDomain.set(domain, [...(byDomain.get(domain) ?? []), route])
  }

  const lines: string[] = []
  for (const [domain, group] of byDomain) {
    const pathW = Math.max(...group.map((r) => r.path.length))
    const serviceW = Math.max(...group.map((r) => r.serviceName.length))
    lines.push(`  https://${domain}`)
    for (const r of group) {
      lines.push(
        `    ${r.path.padEnd(pathW)}   ${r.serviceName.padEnd(serviceW)}   ${r.cache ?? 'not cached'}`
      )
    }
  }
  return lines
}
