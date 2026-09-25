import { describe, expect, it } from 'vitest'

import { buildLiveUrlLines } from './live-urls'
import type { VersionRouteUrl } from './live-urls'

const route = (
  over: Partial<VersionRouteUrl> & Pick<VersionRouteUrl, 'url' | 'domain'>
): VersionRouteUrl => ({
  path: '/*',
  serviceName: 'web',
  ...over,
})

describe('buildLiveUrlLines', () => {
  it('renders a catch-all-only domain as a single primary line', () => {
    const lines = buildLiveUrlLines([
      route({ url: 'https://app.example.com', domain: 'app.example.com', path: '/*' }),
    ])

    expect(lines).toEqual(['  https://app.example.com  → web'])
  })

  it('nests sub-paths under the catch-all root with their cache label', () => {
    const lines = buildLiveUrlLines([
      route({
        url: 'https://nextjs.example.com/_next/static',
        domain: 'nextjs.example.com',
        path: '/_next/static/*',
        serviceName: 'web-zip',
        cache: 'cached 1y',
      }),
      route({
        url: 'https://nextjs.example.com',
        domain: 'nextjs.example.com',
        path: '/*',
        serviceName: 'web-zip',
        cache: 'no-cache',
      }),
    ])

    expect(lines).toEqual([
      '  https://nextjs.example.com  → web-zip',
      '    /_next/static/*  web-zip  (cached 1y)',
    ])
  })

  it('shows a sub-path as its own top-level URL when this version owns no catch-all (cross-project domain)', () => {
    // Another project owns the root of site.example.com; this version owns only /blog.
    const lines = buildLiveUrlLines([
      route({
        url: 'https://site.example.com/blog',
        domain: 'site.example.com',
        path: '/blog/*',
        serviceName: 'blog',
        cache: 'cached 5m',
      }),
    ])

    expect(lines).toEqual(['  https://site.example.com/blog  → blog  (cached 5m)'])
    expect(lines.some((l) => l.trim() === 'site.example.com')).toBe(false)
  })

  it('lists every sub-path as a top-level URL when a domain has multiple non-root paths', () => {
    const lines = buildLiveUrlLines([
      route({
        url: 'https://shop.example.com/api',
        domain: 'shop.example.com',
        path: '/api/*',
        serviceName: 'api',
      }),
      route({
        url: 'https://shop.example.com/blog',
        domain: 'shop.example.com',
        path: '/blog/*',
        serviceName: 'blog',
      }),
    ])

    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^ {2}https:\/\/shop\.example\.com\/api {2,}→ api$/)
    expect(lines[1]).toBe('  https://shop.example.com/blog  → blog')
    expect(new Set(lines.map((l) => l.indexOf('→'))).size).toBe(1)
  })

  it('groups multiple domains independently, mixing nested and top-level layouts', () => {
    const lines = buildLiveUrlLines([
      route({
        url: 'https://a.example.com',
        domain: 'a.example.com',
        path: '/*',
        serviceName: 'web-a',
      }),
      route({
        url: 'https://a.example.com/assets',
        domain: 'a.example.com',
        path: '/assets/*',
        serviceName: 'web-a',
        cache: 'cached 1y',
      }),
      route({
        url: 'https://b.example.com/blog',
        domain: 'b.example.com',
        path: '/blog/*',
        serviceName: 'blog',
      }),
    ])

    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatch(/^ {2}https:\/\/a\.example\.com {2,}→ web-a$/)
    expect(lines[1]).toBe('    /assets/*  web-a  (cached 1y)')
    expect(lines[2]).toBe('  https://b.example.com/blog  → blog')
    // Both top-level lines put the service column at the same offset.
    expect(new Set([lines[0], lines[2]].map((l) => l.indexOf('→'))).size).toBe(1)
  })

  it('omits the cache annotation when a route has none', () => {
    const lines = buildLiveUrlLines([
      route({
        url: 'https://app.example.com/blog',
        domain: 'app.example.com',
        path: '/blog/*',
        serviceName: 'blog',
      }),
    ])

    expect(lines).toEqual(['  https://app.example.com/blog  → blog'])
  })
})
