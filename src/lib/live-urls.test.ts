import { describe, expect, it } from 'vitest'

import { buildLiveUrlLines } from './live-urls'

describe('buildLiveUrlLines', () => {
  it('lists every path of a hostname as written, including the root, in aligned columns', () => {
    const lines = buildLiveUrlLines([
      {
        url: 'https://parent.pvtest.api-testing.dev',
        domain: 'parent.pvtest.api-testing.dev',
        path: '/',
        serviceName: 'site',
        cache: 'cached 5m',
      },
      {
        url: 'https://parent.pvtest.api-testing.dev/b',
        domain: 'parent.pvtest.api-testing.dev',
        path: '/b/*',
        serviceName: 'site-b',
        cache: 'cached 5m',
      },
    ])

    expect(lines).toEqual([
      '  https://parent.pvtest.api-testing.dev',
      '    /      site     cached 5m',
      '    /b/*   site-b   cached 5m',
    ])
  })

  it('labels a path with no cache setting as not cached', () => {
    const lines = buildLiveUrlLines([
      {
        url: 'https://shop.example.com/checkout',
        domain: 'shop.example.com',
        path: '/checkout',
        serviceName: 'api',
        cache: null,
      },
    ])

    expect(lines).toEqual(['  https://shop.example.com', '    /checkout   api   not cached'])
  })

  it('groups each hostname separately, aligning columns within each', () => {
    const lines = buildLiveUrlLines([
      {
        url: 'https://a.example.com',
        domain: 'a.example.com',
        path: '/*',
        serviceName: 'web',
        cache: 'not cached',
      },
      {
        url: 'https://a.example.com/assets',
        domain: 'a.example.com',
        path: '/assets/*',
        serviceName: 'web',
        cache: 'cached 1y',
      },
      {
        url: 'https://b.example.com/blog',
        domain: 'b.example.com',
        path: '/blog/*',
        serviceName: 'blog',
        cache: 'cached 5m',
      },
    ])

    expect(lines).toEqual([
      '  https://a.example.com',
      '    /*          web   not cached',
      '    /assets/*   web   cached 1y',
      '  https://b.example.com',
      '    /blog/*   blog   cached 5m',
    ])
  })

  it('takes the hostname from the URL when the route has no domain', () => {
    const lines = buildLiveUrlLines([
      { url: 'https://app.example.com/docs', path: '/docs/*', serviceName: 'docs' },
    ])

    expect(lines[0]).toBe('  https://app.example.com')
  })
})
