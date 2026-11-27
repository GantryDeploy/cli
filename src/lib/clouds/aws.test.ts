import { checkbox } from '@inquirer/prompts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

import {
  AWS_OPTIONS_GROUP,
  awsCertificateRegions,
  awsFirewallRuleRows,
  awsOption,
  buildAwsDatabaseUpdate,
  buildAwsNetworkSettings,
  parseAwsFirewallRules,
  toAwsCacheDeploymentMode,
  toAwsDatabaseDeploymentMode,
  toAwsDatabaseFlavor,
} from './aws'

vi.mock('@inquirer/prompts', () => ({ checkbox: vi.fn(), input: vi.fn(), select: vi.fn() }))

const regions = [
  { code: 'us-east-1', name: 'US East (N. Virginia)' },
  { code: 'eu-west-1', name: 'Europe (Ireland)' },
]

describe('aws cloud module', () => {
  it('puts AWS flags under their own help heading', () => {
    expect(awsOption('--aws-nat <option>', 'NAT gateways').helpGroupHeading).toBe(AWS_OPTIONS_GROUP)
  })

  it.each([
    ['rds', 'rds'],
    [' Aurora ', 'aurora'],
  ])('reads the database service %j as %s', (flavor, expected) => {
    expect(toAwsDatabaseFlavor(flavor)).toBe(expected)
  })

  it('rejects another database service without echoing it back', () => {
    expect(() => toAwsDatabaseFlavor('docdb')).toThrow(
      /^Unknown AWS database service\. Use rds or aurora\.$/
    )
  })

  it.each([
    [toAwsCacheDeploymentMode, 'node-based', 'NODE_BASED'],
    [toAwsDatabaseDeploymentMode, 'provisioned', 'PROVISIONED'],
    [toAwsDatabaseDeploymentMode, 'serverless', 'SERVERLESS'],
  ])('reads the deployment mode %#', (read, mode, expected) => {
    expect(read(mode)).toBe(expected)
  })

  describe('buildAwsNetworkSettings', () => {
    it('sends AWS settings only when an AWS flag is set', () => {
      expect(buildAwsNetworkSettings({ awsNat: 'per-az', awsNoInternet: true })).toEqual({
        ok: true,
        value: { natGatewayOption: 'PER_AZ', enableInternetAccess: false },
      })
      expect(buildAwsNetworkSettings({})).toEqual({ ok: true, value: undefined })
    })

    it('refuses an unknown NAT option', () => {
      expect(buildAwsNetworkSettings({ awsNat: 'double' })).toEqual({
        ok: false,
        message: '--aws-nat must be none, single or per-az',
      })
    })
  })

  describe('buildAwsDatabaseUpdate', () => {
    it('turns master rotation off and Performance Insights on', () => {
      expect(
        buildAwsDatabaseUpdate({ awsNoMasterRotation: true, awsPerformanceInsights: true })
      ).toEqual({
        ok: true,
        value: { masterPasswordRotation: false, performanceInsightsEnabled: true },
      })
    })

    it('refuses both sides of a switch', () => {
      expect(
        buildAwsDatabaseUpdate({ awsMasterRotation: true, awsNoMasterRotation: true })
      ).toEqual({
        ok: false,
        message: 'Choose either --aws-master-rotation or --aws-no-master-rotation.',
      })
    })
  })

  describe('firewall rules', () => {
    const wordpressRules = [
      {
        id: 'r_k3m9qa',
        name: 'Login rate limit',
        enabled: true,
        kind: 'rate-limit',
        limit: 100,
        windowSeconds: 300,
        aggregate: 'ip',
        match: {
          combine: 'all',
          conditions: [{ field: 'path', operator: 'exact', value: '/wp-login.php' }],
        },
        action: 'block',
      },
      {
        id: 'r_p7w2xc',
        name: 'WordPress exploits',
        enabled: true,
        kind: 'managed-group',
        group: 'wordpress',
        countRules: ['WordPressExploitableCommands_QUERYSTRING'],
      },
      {
        id: 'r_d4t8nv',
        name: 'AI crawlers',
        enabled: false,
        kind: 'bot-control',
        block: ['ai', 'scraping-framework'],
      },
      {
        id: 'r_h6z1ye',
        name: 'Admin outside office',
        enabled: true,
        kind: 'custom',
        match: {
          combine: 'all',
          conditions: [
            { field: 'path', operator: 'starts-with', value: '/wp-admin' },
            { field: 'ip', cidrs: ['203.0.113.0/24'], negate: true },
          ],
        },
        action: 'captcha',
      },
      {
        name: 'Large uploads from abroad',
        enabled: true,
        kind: 'custom',
        match: {
          combine: 'any',
          conditions: [
            { field: 'body-size', greaterThan: 8388608 },
            { field: 'country', countries: ['CN', 'RU'] },
            { field: 'header', name: 'user-agent', operator: 'contains', value: 'curl' },
            { field: 'query-param', name: 'action', operator: 'regex', value: '^upload' },
            { field: 'method', methods: ['PUT'] },
          ],
        },
        action: 'count',
      },
    ]

    it('maps a rules file to the input enums, keeping ids and leaving new rules without one', () => {
      const parsed = parseAwsFirewallRules(wordpressRules)
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) return
      expect(parsed.value).toEqual([
        {
          id: 'r_k3m9qa',
          name: 'Login rate limit',
          enabled: true,
          kind: 'RATE_LIMIT',
          rateLimit: {
            limit: 100,
            windowSeconds: 300,
            aggregate: 'IP',
            action: 'BLOCK',
            match: {
              combine: 'ALL',
              conditions: [{ field: 'PATH', operator: 'EXACT', value: '/wp-login.php' }],
            },
          },
        },
        {
          id: 'r_p7w2xc',
          name: 'WordPress exploits',
          enabled: true,
          kind: 'MANAGED_GROUP',
          managedGroup: {
            group: 'WORDPRESS',
            countRules: ['WordPressExploitableCommands_QUERYSTRING'],
          },
        },
        {
          id: 'r_d4t8nv',
          name: 'AI crawlers',
          enabled: false,
          kind: 'BOT_CONTROL',
          botControl: { block: ['AI', 'SCRAPING_FRAMEWORK'] },
        },
        {
          id: 'r_h6z1ye',
          name: 'Admin outside office',
          enabled: true,
          kind: 'CUSTOM',
          custom: {
            action: 'CAPTCHA',
            match: {
              combine: 'ALL',
              conditions: [
                { field: 'PATH', operator: 'STARTS_WITH', value: '/wp-admin' },
                { field: 'IP', cidrs: ['203.0.113.0/24'], negate: true },
              ],
            },
          },
        },
        {
          name: 'Large uploads from abroad',
          enabled: true,
          kind: 'CUSTOM',
          custom: {
            action: 'COUNT',
            match: {
              combine: 'ANY',
              conditions: [
                { field: 'BODY_SIZE', greaterThan: 8388608 },
                { field: 'COUNTRY', countries: ['CN', 'RU'] },
                { field: 'HEADER', name: 'user-agent', operator: 'CONTAINS', value: 'curl' },
                { field: 'QUERY_PARAM', name: 'action', operator: 'REGEX', value: '^upload' },
                { field: 'METHOD', methods: ['PUT'] },
              ],
            },
          },
        },
      ])
    })

    it('summarises each stored rule on one line, in order', () => {
      expect(awsFirewallRuleRows({ provider: 'aws', rules: wordpressRules })).toEqual([
        {
          name: 'Login rate limit',
          kind: 'rate-limit',
          enabled: true,
          summary: '100 per 5 min per IP on /wp-login.php → block',
        },
        {
          name: 'WordPress exploits',
          kind: 'managed-group',
          enabled: true,
          summary: 'wordpress, counting WordPressExploitableCommands_QUERYSTRING',
        },
        {
          name: 'AI crawlers',
          kind: 'bot-control',
          enabled: false,
          summary: 'blocks ai, scraping-framework',
        },
        {
          name: 'Admin outside office',
          kind: 'custom',
          enabled: true,
          summary: '/wp-admin* and not IP in 203.0.113.0/24 → captcha',
        },
        {
          name: 'Large uploads from abroad',
          kind: 'custom',
          enabled: true,
          summary:
            'body over 8,388,608 bytes or country in CN, RU or header user-agent contains curl or query action matches ^upload or method PUT → count',
        },
      ])
    })

    it('summarises a rate limit with no match and a bot rule that blocks nothing', () => {
      const rows = awsFirewallRuleRows({
        provider: 'aws',
        rules: [
          {
            id: 'r_b2c5ml',
            name: 'Site-wide limit',
            enabled: true,
            kind: 'rate-limit',
            limit: 2000,
            windowSeconds: 60,
            aggregate: 'forwarded-ip',
            action: 'challenge',
          },
          { id: 'r_f9g3so', name: 'Bots', enabled: true, kind: 'bot-control', block: [] },
        ],
      })
      expect(rows.map((row) => row.summary)).toEqual([
        '2,000 per 1 min per forwarded IP → challenge',
        'counts every category',
      ])
    })

    it.each([
      [{ provider: 'aws' }],
      [{ provider: 'aws', rules: [{ id: 'r_k3m9qa', name: 'Old', enabled: true, kind: 'geo' }] }],
    ])('throws on stored rules in another shape %#', (rules) => {
      expect(() => awsFirewallRuleRows(rules)).toThrow(
        'The firewall rules are not in the expected shape.'
      )
    })

    it.each([
      [{ rules: [] }, 'It must be a list of rules.'],
      [
        [{ name: 'Login', enabled: true, kind: 'geo-block' }],
        'Rule 1: kind must be managed-group, rate-limit, bot-control, custom.',
      ],
      [
        [{ name: 'Login', kind: 'bot-control', block: [] }],
        'Rule 1: enabled must be true or false.',
      ],
      [
        [
          { name: 'Login', enabled: true, kind: 'bot-control', block: [] },
          { name: 'Spam', enabled: true, kind: 'bot-control', block: ['ai', 'crawlers'] },
        ],
        'Rule 2: block must be a list of',
      ],
      [
        [
          {
            name: 'Login',
            enabled: true,
            kind: 'rate-limit',
            limit: '100',
            windowSeconds: 300,
            aggregate: 'ip',
            action: 'block',
          },
        ],
        'Rule 1: limit must be a whole number.',
      ],
      [
        [
          {
            name: 'Admin',
            enabled: true,
            kind: 'custom',
            action: 'block',
            match: {
              combine: 'all',
              conditions: [{ field: 'path', operator: 'like', value: '/a' }],
            },
          },
        ],
        'Rule 1 condition 1: operator must be exact, starts-with, ends-with, contains, regex.',
      ],
      [
        [{ name: 'Admin', enabled: true, kind: 'custom', action: 'block' }],
        'Rule 1 match: must be an object.',
      ],
    ])('refuses a rules file with a bad rule %#', (list, message) => {
      const parsed = parseAwsFirewallRules(list)
      expect(parsed.ok).toBe(false)
      if (parsed.ok) return
      expect(parsed.message).toContain(message)
    })
  })

  describe('awsCertificateRegions', () => {
    let logSpy: MockInstance

    beforeEach(() => {
      vi.mocked(checkbox).mockReset()
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    })

    afterEach(() => {
      logSpy.mockRestore()
    })

    it('reads a region list from the flag without prompting', async () => {
      await expect(awsCertificateRegions('us-east-1, eu-west-1', regions)).resolves.toEqual({
        ok: true,
        value: ['us-east-1', 'eu-west-1'],
      })
      expect(checkbox).not.toHaveBeenCalled()
      expect(logSpy).not.toHaveBeenCalled()
    })

    it('refuses a region the cloud does not offer', async () => {
      await expect(awsCertificateRegions('us-east-1,mars-north-1', regions)).resolves.toEqual({
        ok: false,
        message: 'Unknown region: mars-north-1. See "gantry regions --cloud <id>".',
      })
    })

    it('offers the cloud regions with us-east-1 checked and warns when it is left out', async () => {
      vi.mocked(checkbox).mockResolvedValueOnce(['eu-west-1'])

      await expect(awsCertificateRegions(undefined, regions)).resolves.toEqual({
        ok: true,
        value: ['eu-west-1'],
      })
      const { choices } = vi.mocked(checkbox).mock.calls[0][0] as unknown as {
        choices: { value: string; checked: boolean }[]
      }
      expect(choices.filter((c) => c.checked).map((c) => c.value)).toEqual(['us-east-1'])
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('CloudFront'))
    })
  })
})
