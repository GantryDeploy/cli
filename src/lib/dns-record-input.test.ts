import { describe, expect, it } from 'vitest'

import { buildDnsRecordFields } from './dns-record-input'

describe('buildDnsRecordFields', () => {
  it('maps record flags to the API input', () => {
    expect(
      buildDnsRecordFields({ type: 'MX', name: 'acme.com', value: 'mail.acme.com', priority: '10' })
    ).toEqual({
      ok: true,
      input: { recordType: 'MX', name: 'acme.com', value: 'mail.acme.com', priority: 10 },
    })
  })

  it('sends CAA fields', () => {
    expect(buildDnsRecordFields({ caaFlags: '0', caaTag: 'issue' })).toEqual({
      ok: true,
      input: { caaFlags: 0, caaTag: 'issue' },
    })
  })

  it('builds an AWS alias from all its flags', () => {
    expect(
      buildDnsRecordFields({
        awsAliasZone: 'Z35SXDOTRQ7X7K',
        awsAliasTarget: 'dualstack.web-alb-1234.us-east-2.elb.amazonaws.com',
        awsAliasEvaluateHealth: true,
      })
    ).toEqual({
      ok: true,
      input: {
        aws: {
          alias: {
            hostedZoneId: 'Z35SXDOTRQ7X7K',
            dnsName: 'dualstack.web-alb-1234.us-east-2.elb.amazonaws.com',
            evaluateTargetHealth: true,
          },
        },
      },
    })
  })

  it.each([
    [{ cloudflareProxied: true }, { proxied: true }],
    [{ cloudflareNoProxied: true }, { proxied: false }],
  ])('sets Cloudflare proxying from %j', (flags, cloudflare) => {
    expect(buildDnsRecordFields(flags)).toEqual({ ok: true, input: { cloudflare } })
  })

  it.each([
    [{ priority: 'ten' }, '--priority must be a whole number.'],
    [{ port: '443.5' }, '--port must be a whole number.'],
    [
      { awsAliasZone: 'Z35SXDOTRQ7X7K' },
      'An alias needs both --aws-alias-zone and --aws-alias-target.',
    ],
    [
      { cloudflareProxied: true, cloudflareNoProxied: true },
      'Choose either --cloudflare-proxied or --cloudflare-no-proxied.',
    ],
    [
      {
        cloudflareProxied: true,
        awsAliasZone: 'Z35SXDOTRQ7X7K',
        awsAliasTarget: 'web.us-east-2.elb.amazonaws.com',
      },
      'A record takes AWS or Cloudflare settings, not both.',
    ],
  ])('refuses %j', (flags, message) => {
    expect(buildDnsRecordFields(flags)).toEqual({ ok: false, message })
  })
})
