/** One routable URL for a version, as returned by the `versionRouteUrls` query. */
export interface VersionRouteUrl {
  url: string
  domain?: string | null
  path: string
  serviceName: string
  /** Short label for the path's cache (`not cached`, `cached 1y`, or a named policy), if any. */
  cache?: string | null
  /** Slug of the firewall in front of the route's hostname, if any. */
  firewall?: string | null
  /** The zero trust provider the route's hostname is locked to, if any. */
  originLock?: string | null
}

/**
 * Format the post-deploy "Deployed routes" summary: each hostname, then one line per path as
 * written in gantry.yml with its service, cache, firewall and origin lock. Columns align within a
 * hostname. When a route is locked, a note on setting up its header follows.
 */
export function buildLiveUrlLines(routes: VersionRouteUrl[]): string[] {
  const byDomain = new Map<string, VersionRouteUrl[]>()
  for (const route of routes) {
    const domain = route.domain ?? new URL(route.url).host
    byDomain.set(domain, [...(byDomain.get(domain) ?? []), route])
  }

  const cacheLabel = (r: VersionRouteUrl) => r.cache ?? 'not cached'
  const lines: string[] = []
  const lockedDomains: string[] = []
  for (const [domain, group] of byDomain) {
    const pathW = Math.max(...group.map((r) => r.path.length))
    const serviceW = Math.max(...group.map((r) => r.serviceName.length))
    const cacheW = Math.max(...group.map((r) => cacheLabel(r).length))
    lines.push(`  https://${domain}`)
    for (const r of group) {
      const lock = r.originLock ? `   locked: ${r.originLock}` : ''
      lines.push(
        `    ${r.path.padEnd(pathW)}   ${r.serviceName.padEnd(serviceW)}   ${cacheLabel(r).padEnd(cacheW)}   firewall: ${r.firewall ?? 'none'}${lock}`
      )
    }
    if (group.some((r) => r.originLock)) lockedDomains.push(domain)
  }

  if (lockedDomains.length > 0) {
    const hostname = lockedDomains.length === 1 ? lockedDomains[0] : '<hostname>'
    lines.push(
      '',
      `  Locked hostnames refuse requests without their header. Run gantry origin-lock show ${hostname} to set it up in Cloudflare.`
    )
  }
  return lines
}
