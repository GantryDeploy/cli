/** One routable URL for a version, as returned by the `versionRouteUrls` query. */
export interface VersionRouteUrl {
  url: string
  domain?: string | null
  path: string
  serviceName: string
  /** Short cache label for the path (`no-cache`, `cached 1y`, or a named policy), if any. */
  cache?: string | null
}

/**
 * Format the post-deploy "Live URLs" summary, grouped by domain. Where this version owns the
 * catch-all, the bare domain is the primary line and other paths nest under it. Where it owns
 * only sub-paths (another project owns the root), each path is its own top-level URL. Returns
 * plain lines with no ANSI, padded so service names align.
 */
export function buildLiveUrlLines(routes: VersionRouteUrl[]): string[] {
  const byDomain = new Map<string, VersionRouteUrl[]>()
  for (const route of routes) {
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty/absent domain should fall back to the url as the grouping key
    const key = route.domain || route.url
    const list = byDomain.get(key) ?? []
    list.push(route)
    byDomain.set(key, list)
  }

  // Entries are collected first so every column can be padded to one shared width.
  type Entry =
    | { kind: 'url'; url: string; serviceName: string; cache?: string | null }
    | { kind: 'path'; path: string; serviceName: string; cache?: string | null }
  const entries: Entry[] = []

  for (const [domain, group] of byDomain) {
    const primary = group.find((r) => r.url === `https://${domain}`)

    if (!primary) {
      for (const r of group) {
        entries.push({ kind: 'url', url: r.url, serviceName: r.serviceName, cache: r.cache })
      }
      continue
    }

    // The root line omits the cache label: it is the app itself.
    entries.push({ kind: 'url', url: primary.url, serviceName: primary.serviceName })
    for (const r of group) {
      if (r === primary) continue
      entries.push({ kind: 'path', path: r.path, serviceName: r.serviceName, cache: r.cache })
    }
  }

  const urlW = Math.max(0, ...entries.flatMap((e) => (e.kind === 'url' ? [e.url.length] : [])))
  const pathW = Math.max(0, ...entries.flatMap((e) => (e.kind === 'path' ? [e.path.length] : [])))
  const annotate = (cache?: string | null): string => (cache ? `  (${cache})` : '')

  return entries.map((e) =>
    e.kind === 'url'
      ? `  ${e.url.padEnd(urlW)}  → ${e.serviceName}${annotate(e.cache)}`
      : `    ${e.path.padEnd(pathW)}  ${e.serviceName}${annotate(e.cache)}`
  )
}
