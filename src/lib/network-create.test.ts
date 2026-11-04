import { describe, expect, it } from 'vitest'

import { buildNetworkSettings } from './network-create'

describe('buildNetworkSettings', () => {
  it('names subnets after the network and keeps their zones', () => {
    expect(
      buildNetworkSettings('prod', {
        subnet: [
          'public:10.0.0.0/24:us-east-1a',
          'private:10.0.16.0/20:us-east-1a',
          'private:10.0.32.0/20',
        ],
      })
    ).toEqual({
      ok: true,
      subnets: [
        { name: 'prod-public-0', cidr: '10.0.0.0/24', type: 'PUBLIC', zone: 'us-east-1a' },
        { name: 'prod-private-0', cidr: '10.0.16.0/20', type: 'PRIVATE', zone: 'us-east-1a' },
        { name: 'prod-private-1', cidr: '10.0.32.0/20', type: 'PRIVATE' },
      ],
    })
  })

  it('sends AWS settings only when an AWS flag is set', () => {
    expect(buildNetworkSettings('prod', { nat: 'per-az', internet: false })).toEqual({
      ok: true,
      subnets: [],
      aws: { natGatewayOption: 'PER_AZ', enableInternetAccess: false },
    })
    expect(buildNetworkSettings('prod', { internet: true })).toEqual({ ok: true, subnets: [] })
  })

  it.each(['edge:10.0.0.0/24', 'public', 'public:10.0.0.0/24:us-east-1a:extra'])(
    'refuses the subnet %s',
    (spec) => {
      expect(buildNetworkSettings('prod', { subnet: [spec] })).toEqual({
        ok: false,
        message: `--subnet ${spec} must look like public:10.0.0.0/24:us-east-1a`,
      })
    }
  )

  it('refuses an unknown NAT option', () => {
    expect(buildNetworkSettings('prod', { nat: 'double' })).toEqual({
      ok: false,
      message: '--nat must be none, single or per-az',
    })
  })
})
