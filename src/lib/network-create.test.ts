import { describe, expect, it } from 'vitest'

import { buildNetworkSubnets } from './network-create'

describe('buildNetworkSubnets', () => {
  it('names subnets after the network and keeps their zones', () => {
    expect(
      buildNetworkSubnets('prod', [
        'public:10.0.0.0/24:us-east-1a',
        'private:10.0.16.0/20:us-east-1a',
        'private:10.0.32.0/20',
      ])
    ).toEqual({
      ok: true,
      subnets: [
        { name: 'prod-public-0', cidr: '10.0.0.0/24', type: 'PUBLIC', zone: 'us-east-1a' },
        { name: 'prod-private-0', cidr: '10.0.16.0/20', type: 'PRIVATE', zone: 'us-east-1a' },
        { name: 'prod-private-1', cidr: '10.0.32.0/20', type: 'PRIVATE' },
      ],
    })
  })

  it.each(['edge:10.0.0.0/24', 'public', 'public:10.0.0.0/24:us-east-1a:extra'])(
    'refuses the subnet %s',
    (spec) => {
      expect(buildNetworkSubnets('prod', [spec])).toEqual({
        ok: false,
        message: `--subnet ${spec} must look like private:10.0.16.0/20:<zone>`,
      })
    }
  )
})
