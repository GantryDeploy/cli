import { describe, expect, it } from 'vitest'

import { foreignAwsFlagsMessage, isAws, toCloudProvider, unsupportedCloud } from '.'

describe('clouds', () => {
  it.each([
    ['aws', 'AWS'],
    [' GCP ', 'GCP'],
    ['DigitalOcean', 'DIGITALOCEAN'],
  ])('reads %j as %s', (value, provider) => {
    expect(toCloudProvider(value)).toBe(provider)
  })

  it('names every cloud when the provider is unknown', () => {
    expect(() => toCloudProvider('heroku')).toThrow(
      'Unknown cloud provider. Use one of: aws, azure, cloudflare, digitalocean, gcp, vultr'
    )
  })

  it.each([
    ['AWS', true],
    ['aws', true],
    ['GCP', false],
  ])('isAws(%s) is %s', (provider, expected) => {
    expect(isAws(provider)).toBe(expected)
  })

  it('words the unsupported-cloud message the same everywhere', () => {
    expect(unsupportedCloud('caches')).toBe("This cloud doesn't support caches yet.")
  })

  describe('foreignAwsFlagsMessage', () => {
    it('allows AWS flags on an AWS cloud account', () => {
      expect(foreignAwsFlagsMessage('AWS', { awsNat: 'single' })).toBeNull()
    })

    it('ignores shared flags and unset AWS flags on another cloud', () => {
      expect(foreignAwsFlagsMessage('GCP', { name: 'Web', awsNat: undefined })).toBeNull()
    })

    it('names each AWS flag passed for another cloud', () => {
      expect(
        foreignAwsFlagsMessage('GCP', { awsNoInternet: true, awsNat: 'per-az', region: 'x' })
      ).toBe('--aws-no-internet, --aws-nat only apply to AWS cloud accounts.')
    })
  })
})
