import { stripVTControlCharacters } from 'util'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

const graphqlRequest = vi.hoisted(() => vi.fn())
const checkbox = vi.hoisted(() => vi.fn())
const confirm = vi.hoisted(() => vi.fn())
const input = vi.hoisted(() => vi.fn())
const select = vi.hoisted(() => vi.fn())
const isInteractive = vi.hoisted(() => vi.fn(() => true))

vi.mock('@inquirer/prompts', () => ({ checkbox, confirm, input, select }))
vi.mock('../lib/client', () => ({
  formatApiError: (error: unknown) => (error instanceof Error ? error.message : 'API error'),
  graphqlRequest,
}))
vi.mock('../lib/terminal', () => ({ isInteractive }))

const { registerFirewallsCommand } = await import('./firewalls')

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

async function run(args: string[]): Promise<void> {
  const program = new Command()
  registerFirewallsCommand(program)
  await program.parseAsync(['node', 'gantry', 'firewalls', ...args])
}

const edgeWaf = {
  id: 'fw_k7d2mq',
  name: 'Edge WAF',
  slug: 'edge-waf',
  provider: 'AWS',
  rules: { provider: 'aws', managedGroups: ['ip-reputation', 'common', 'wordpress'] },
  placements: [
    { id: 'fwp_r3x8va', cloudAccountId: 'c4xp9w', status: 'ACTIVE' },
    { id: 'fwp_b6n1tz', cloudAccountId: 'c9hm2e', status: 'DRAINING' },
    { id: 'fwp_q2w5ks', cloudAccountId: 'c1zt7u', status: 'RELEASED' },
  ],
  uses: [
    { hostname: 'shop.example.com', projectId: 'p8vk3n', projectName: 'Storefront' },
    { hostname: 'blog.example.com', projectId: 'p2jd6w', projectName: 'Marketing site' },
  ],
}

const unused = {
  id: 'fw_t5c9re',
  name: 'Staging WAF',
  slug: 'staging-waf',
  provider: 'AWS',
  rules: { provider: 'aws', managedGroups: [] },
  placements: [],
  uses: [],
}

function listResponse(...firewalls: object[]) {
  return { firewalls }
}

function mutationInput(index: number): unknown {
  return (graphqlRequest.mock.calls[index]?.[1] as { input: unknown }).input
}

describe('firewalls command', () => {
  let logSpy: MockInstance
  let errorSpy: MockInstance

  beforeEach(() => {
    vi.clearAllMocks()
    isInteractive.mockReturnValue(true)
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitError(typeof code === 'number' ? code : undefined)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function printed(): string {
    return stripVTControlCharacters(logSpy.mock.calls.map((call) => String(call[0])).join('\n'))
  }

  function firstError(): string {
    return stripVTControlCharacters(String(errorSpy.mock.calls[0]?.[0]))
  }

  describe('list', () => {
    it('shows the hostnames behind each firewall and the accounts it is still deployed in', async () => {
      graphqlRequest.mockResolvedValueOnce(
        listResponse({ ...edgeWaf, name: 'Edge WAF\x1b]0;pwned\x07' }, unused)
      )

      await run(['list'])

      const rows = printed().split('\n')
      const edgeRow = rows.find((row) => row.includes('edge-waf'))
      expect(edgeRow).toContain('Edge WAF')
      expect(edgeRow).toContain('AWS')
      expect(edgeRow).toContain('shop.example.com, blog.example.com')
      expect(edgeRow).toContain('c4xp9w, c9hm2e')
      expect(printed()).not.toContain('c1zt7u')
      expect(printed()).not.toContain('pwned')
      expect(rows.find((row) => row.includes('staging-waf'))).toMatch(/│ -\s+│ -\s+│$/)
    })

    it('says so when the team has no firewalls', async () => {
      graphqlRequest.mockResolvedValueOnce(listResponse())

      await run(['list'])

      expect(printed()).toBe('No firewalls found.')
    })
  })

  describe('show', () => {
    it('prints the rules, the hostnames with their project and each deployment', async () => {
      graphqlRequest.mockResolvedValueOnce(listResponse(unused, edgeWaf))

      await run(['show', 'edge-waf'])

      const out = printed()
      expect(out).toContain('Firewall: Edge WAF')
      expect(out).toContain('ID:       fw_k7d2mq')
      expect(out).toContain('Managed rule groups: ip-reputation, common, wordpress')
      expect(out).toMatch(/shop\.example\.com\s+│ Storefront/)
      expect(out).toMatch(/blog\.example\.com\s+│ Marketing site/)
      expect(out).toMatch(/c4xp9w\s+│ ACTIVE/)
      expect(out).toMatch(/c9hm2e\s+│ DRAINING/)
      expect(out).toMatch(/c1zt7u\s+│ RELEASED/)
    })

    it('finds a firewall by ID and reports when nothing uses it', async () => {
      graphqlRequest.mockResolvedValueOnce(listResponse(edgeWaf, unused))

      await run(['show', 'fw_t5c9re'])

      const out = printed()
      expect(out).toContain('Firewall: Staging WAF')
      expect(out).toContain('Managed rule groups: none')
      expect(out).toContain('No live version routes through this firewall.')
      expect(out).toContain('Not deployed yet.')
    })

    it('refuses a slug the team has no firewall for', async () => {
      graphqlRequest.mockResolvedValueOnce(listResponse(edgeWaf))

      await expect(run(['show', 'shop-waf'])).rejects.toThrow(ExitError)

      expect(firstError()).toBe('Error: Firewall not found.')
    })
  })

  describe('create', () => {
    const created = {
      createFirewall: {
        success: true,
        message: null,
        firewall: { id: 'fw_k7d2mq', name: 'Edge WAF', slug: 'edge-waf' },
      },
    }

    it('sends the managed groups as enum values', async () => {
      graphqlRequest.mockResolvedValueOnce(created)

      await run([
        'create',
        'edge-waf',
        '--name',
        'Edge WAF',
        '--provider',
        'aws',
        '--aws-managed-groups',
        'common, php,known-bad-inputs',
      ])

      expect(mutationInput(0)).toEqual({
        name: 'Edge WAF',
        slug: 'edge-waf',
        provider: 'AWS',
        aws: { managedGroups: ['COMMON', 'KNOWN_BAD_INPUTS', 'PHP'] },
      })
      expect(printed()).toContain('Firewall created: Edge WAF (edge-waf)')
    })

    it('merges the wordpress preset with extra groups, without repeating any', async () => {
      graphqlRequest.mockResolvedValueOnce(created)

      await run([
        'create',
        'edge-waf',
        '--name',
        'Edge WAF',
        '--provider',
        'aws',
        '--aws-preset',
        'wordpress',
        '--aws-managed-groups',
        'linux,php',
      ])

      expect(mutationInput(0)).toMatchObject({
        aws: {
          managedGroups: [
            'IP_REPUTATION',
            'COMMON',
            'KNOWN_BAD_INPUTS',
            'SQL',
            'LINUX',
            'PHP',
            'WORDPRESS',
          ],
        },
      })
    })

    it('offers the managed groups when no rule flag is given', async () => {
      checkbox.mockResolvedValueOnce(['SQL', 'PHP'])
      graphqlRequest.mockResolvedValueOnce(created)

      await run(['create', 'edge-waf', '--name', 'Edge WAF', '--provider', 'aws'])

      expect(mutationInput(0)).toMatchObject({ aws: { managedGroups: ['SQL', 'PHP'] } })
    })

    it('needs a rule flag when no terminal is attached', async () => {
      isInteractive.mockReturnValue(false)

      await expect(
        run(['create', 'edge-waf', '--name', 'Edge WAF', '--provider', 'aws'])
      ).rejects.toThrow(ExitError)

      expect(firstError()).toBe(
        'Error: Choose the rules with --aws-managed-groups or --aws-preset.'
      )
      expect(graphqlRequest).not.toHaveBeenCalled()
    })

    it.each([
      [
        ['--aws-managed-groups', 'common,drupal'],
        '--aws-managed-groups takes a comma-separated list',
      ],
      [['--aws-preset', 'magento'], '--aws-preset must be wordpress'],
    ])('refuses %j', async (flags, message) => {
      await expect(
        run(['create', 'edge-waf', '--name', 'Edge WAF', '--provider', 'aws', ...flags])
      ).rejects.toThrow(ExitError)

      expect(firstError()).toContain(message)
      expect(graphqlRequest).not.toHaveBeenCalled()
    })

    it('refuses AWS flags for another cloud before sending anything', async () => {
      await expect(
        run([
          'create',
          'edge-waf',
          '--name',
          'Edge WAF',
          '--provider',
          'gcp',
          '--aws-preset',
          'wordpress',
        ])
      ).rejects.toThrow(ExitError)

      expect(firstError()).toBe('Error: --aws-preset only applies to AWS cloud accounts.')
      expect(graphqlRequest).not.toHaveBeenCalled()
    })

    it('sends no AWS section for another cloud and prints the refusal', async () => {
      graphqlRequest.mockResolvedValueOnce({
        createFirewall: {
          success: false,
          message: 'The firewall configuration is not valid.',
          firewall: null,
        },
      })

      await expect(
        run(['create', 'edge-waf', '--name', 'Edge WAF', '--provider', 'gcp'])
      ).rejects.toThrow(ExitError)

      expect(mutationInput(0)).toEqual({ name: 'Edge WAF', slug: 'edge-waf', provider: 'GCP' })
      expect(firstError()).toBe('Error: The firewall configuration is not valid.')
    })
  })

  describe('update', () => {
    function updated(placements: { status: string }[]) {
      return {
        updateFirewall: {
          success: true,
          message: null,
          firewall: { id: 'fw_k7d2mq', name: 'Edge WAF', slug: 'edge-waf', placements },
        },
      }
    }

    it('replaces the rules and says they roll out to every account it is deployed in', async () => {
      graphqlRequest
        .mockResolvedValueOnce(listResponse(edgeWaf))
        .mockResolvedValueOnce(
          updated([{ status: 'ACTIVE' }, { status: 'DRAINING' }, { status: 'RELEASED' }])
        )

      await run(['update', 'edge-waf', '--aws-preset', 'wordpress'])

      expect(mutationInput(1)).toEqual({
        id: 'fw_k7d2mq',
        aws: {
          managedGroups: ['IP_REPUTATION', 'COMMON', 'KNOWN_BAD_INPUTS', 'SQL', 'PHP', 'WORDPRESS'],
        },
      })
      expect(printed()).toContain(
        'The new rules roll out to every cloud account the firewall is deployed in (2).'
      )
    })

    it('renames without touching the rules', async () => {
      graphqlRequest
        .mockResolvedValueOnce(listResponse(edgeWaf))
        .mockResolvedValueOnce(updated([{ status: 'ACTIVE' }]))

      await run(['update', 'fw_k7d2mq', '--name', 'Edge firewall'])

      expect(mutationInput(1)).toEqual({ id: 'fw_k7d2mq', name: 'Edge firewall' })
      expect(printed()).not.toContain('roll out')
    })

    it('refuses an update with nothing to change', async () => {
      graphqlRequest.mockResolvedValueOnce(listResponse(edgeWaf))

      await expect(run(['update', 'edge-waf'])).rejects.toThrow(ExitError)

      expect(firstError()).toBe('Error: Nothing to update. Pass --name or new rules.')
      expect(graphqlRequest).toHaveBeenCalledTimes(1)
    })

    it('refuses AWS flags on a firewall for another cloud', async () => {
      graphqlRequest.mockResolvedValueOnce(
        listResponse({ ...edgeWaf, provider: 'GCP', rules: { provider: 'gcp' } })
      )

      await expect(run(['update', 'edge-waf', '--aws-managed-groups', 'common'])).rejects.toThrow(
        ExitError
      )

      expect(firstError()).toBe('Error: --aws-managed-groups only applies to AWS cloud accounts.')
      expect(graphqlRequest).toHaveBeenCalledTimes(1)
    })
  })

  describe('delete', () => {
    it('deletes after the prompt is confirmed', async () => {
      confirm.mockResolvedValueOnce(true)
      graphqlRequest
        .mockResolvedValueOnce(listResponse(unused))
        .mockResolvedValueOnce({ deleteFirewall: { success: true, message: null } })

      await run(['delete', 'staging-waf'])

      expect(confirm).toHaveBeenCalledWith({
        message: 'Delete firewall "staging-waf"?',
        default: false,
      })
      expect(graphqlRequest.mock.calls[1]?.[1]).toEqual({ id: 'fw_t5c9re' })
      expect(printed()).toContain('Firewall deleted: staging-waf')
    })

    it('sends nothing when the prompt is declined', async () => {
      confirm.mockResolvedValueOnce(false)
      graphqlRequest.mockResolvedValueOnce(listResponse(unused))

      await run(['delete', 'staging-waf'])

      expect(graphqlRequest).toHaveBeenCalledTimes(1)
    })

    it('needs --yes when no terminal is attached', async () => {
      isInteractive.mockReturnValue(false)
      graphqlRequest.mockResolvedValueOnce(listResponse(unused))

      await expect(run(['delete', 'staging-waf'])).rejects.toThrow(ExitError)

      expect(firstError()).toBe(
        'Error: Deleting firewall "staging-waf" is permanent. Re-run with --yes to confirm.'
      )
      expect(graphqlRequest).toHaveBeenCalledTimes(1)
    })

    it('prints the refusal when a live version still routes through it', async () => {
      const refusal = 'The firewall is in use by a live version and was not deleted.'
      graphqlRequest
        .mockResolvedValueOnce(listResponse(edgeWaf))
        .mockResolvedValueOnce({ deleteFirewall: { success: false, message: refusal } })

      await expect(run(['delete', 'edge-waf', '--yes'])).rejects.toThrow(ExitError)

      expect(confirm).not.toHaveBeenCalled()
      expect(firstError()).toBe(`Error: ${refusal}`)
    })
  })
})
