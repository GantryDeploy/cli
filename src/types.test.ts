import { describe, expect, it } from 'vitest'

import { formatRouteChain } from './types'

describe('formatRouteChain', () => {
  it('labels known hops and joins them viewer-first', () => {
    expect(formatRouteChain(['cloudfront', 'alb', 'lambda'], '-')).toBe('CloudFront → ALB → Lambda')
  })

  it('passes unknown hops through verbatim', () => {
    expect(formatRouteChain(['cloudflare', 'fly-machine'], '-')).toBe('Cloudflare → fly-machine')
  })

  it('returns the fallback for an empty chain', () => {
    expect(formatRouteChain([], 'direct')).toBe('direct')
  })
})
