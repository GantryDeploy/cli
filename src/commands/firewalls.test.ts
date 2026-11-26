import { stripVTControlCharacters } from 'util'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

const graphqlRequest = vi.hoisted(() => vi.fn())
const confirm = vi.hoisted(() => vi.fn())
const input = vi.hoisted(() => vi.fn())
const select = vi.hoisted(() => vi.fn())
const isInteractive = vi.hoisted(() => vi.fn(() => true))
const readFileSync = vi.hoisted(() => vi.fn())

vi.mock('fs', async (importOriginal) => ({ ...(await importOriginal()), readFileSync }))
vi.mock('@inquirer/prompts', () => ({ confirm, input, select }))
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

const storedRules = [
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
    enabled: false,
    kind: 'managed-group',
    group: 'wordpress',
    countRules: [],
  },
]

const edgeWaf = {
  id: 'fw_k7d2mq',
  name: 'Edge WAF',
  slug: 'edge-waf',
  provider: 'AWS',
  rules: { provider: 'aws', rules: storedRules },
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
  rules: { provider: 'aws', rules: [] },
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
      expect(out).toMatch(
        /1\s+│ Login rate limit\s+│ rate-limit\s+│ yes\s+│ 100 per 5 min per IP on \/wp-login\.php → block/
      )
      expect(out).toMatch(/2\s+│ WordPress exploits\s+│ managed-group\s+│ no\s+│ wordpress/)
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
      expect(out).toContain('No rules. The firewall lets every request through.')
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

    it('creates a firewall with no rules and points at rules set', async () => {
      graphqlRequest.mockResolvedValueOnce(created)

      await run(['create', 'edge-waf', '--name', 'Edge WAF', '--provider', 'aws'])

      expect(mutationInput(0)).toEqual({ name: 'Edge WAF', slug: 'edge-waf', provider: 'AWS' })
      expect(printed()).toContain('Firewall created: Edge WAF (edge-waf)')
      expect(printed()).toContain('gantry firewalls rules set edge-waf --file rules.json')
    })

    it('asks for the cloud and the name when they are left out', async () => {
      select.mockResolvedValueOnce('GCP')
      input.mockResolvedValueOnce('Edge WAF')
      graphqlRequest.mockResolvedValueOnce(created)

      await run(['create', 'edge-waf'])

      expect(mutationInput(0)).toEqual({ name: 'Edge WAF', slug: 'edge-waf', provider: 'GCP' })
    })

    it('rejects the removed rule flags', async () => {
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

      await expect(
        run([
          'create',
          'edge-waf',
          '--name',
          'Edge WAF',
          '--provider',
          'aws',
          '--aws-preset',
          'wordpress',
        ])
      ).rejects.toThrow()

      expect(graphqlRequest).not.toHaveBeenCalled()
    })

    it('prints the refusal', async () => {
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

      expect(firstError()).toBe('Error: The firewall configuration is not valid.')
    })
  })

  describe('update', () => {
    it('renames a firewall', async () => {
      graphqlRequest.mockResolvedValueOnce(listResponse(edgeWaf)).mockResolvedValueOnce({
        updateFirewall: {
          success: true,
          message: null,
          firewall: { id: 'fw_k7d2mq', name: 'Edge firewall', slug: 'edge-waf' },
        },
      })

      await run(['update', 'fw_k7d2mq', '--name', 'Edge firewall'])

      expect(mutationInput(1)).toEqual({ id: 'fw_k7d2mq', name: 'Edge firewall' })
      expect(printed()).toContain('Firewall renamed: Edge firewall (edge-waf)')
    })

    it('needs --name', async () => {
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

      await expect(run(['update', 'edge-waf'])).rejects.toThrow()

      expect(graphqlRequest).not.toHaveBeenCalled()
    })
  })

  describe('rules', () => {
    it('lists the rules in evaluation order with a summary of each', async () => {
      graphqlRequest.mockResolvedValueOnce(listResponse(edgeWaf))

      await run(['rules', 'edge-waf'])

      const rows = printed()
        .split('\n')
        .filter((row) => /^│ \d/.test(row))
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatch(
        /│ 1\s+│ Login rate limit\s+│ rate-limit\s+│ yes\s+│ 100 per 5 min per IP on \/wp-login\.php → block/
      )
      expect(rows[1]).toMatch(
        /│ 2\s+│ WordPress exploits\s+│ managed-group\s+│ no\s+│ wordpress\s+│/
      )
    })

    it('prints the stored rule list as JSON with --json', async () => {
      graphqlRequest.mockResolvedValueOnce(listResponse(edgeWaf))

      await run(['rules', 'edge-waf', '--json'])

      expect(JSON.parse(printed())).toEqual(storedRules)
    })
  })

  describe('rules set', () => {
    function rulesSet(placements: { status: string }[]) {
      return {
        setFirewallRules: {
          success: true,
          message: null,
          firewall: { id: 'fw_k7d2mq', slug: 'edge-waf', placements },
        },
      }
    }

    const newRule = {
      name: 'Block XML-RPC',
      enabled: true,
      kind: 'custom',
      match: {
        combine: 'any',
        conditions: [{ field: 'path', operator: 'exact', value: '/xmlrpc.php' }],
      },
      action: 'block',
    }

    it('sends the file as the ordered rule list and says it rolls out', async () => {
      readFileSync.mockReturnValueOnce(JSON.stringify([...storedRules, newRule]))
      graphqlRequest
        .mockResolvedValueOnce(listResponse(edgeWaf))
        .mockResolvedValueOnce(rulesSet([{ status: 'ACTIVE' }, { status: 'RELEASED' }]))

      await run(['rules', 'set', 'edge-waf', '--file', 'rules.json'])

      expect(readFileSync).toHaveBeenCalledWith('rules.json', 'utf-8')
      expect(mutationInput(1)).toEqual({
        id: 'fw_k7d2mq',
        aws: {
          rules: [
            expect.objectContaining({ id: 'r_k3m9qa', kind: 'RATE_LIMIT' }),
            {
              id: 'r_p7w2xc',
              name: 'WordPress exploits',
              enabled: false,
              kind: 'MANAGED_GROUP',
              managedGroup: { group: 'WORDPRESS', countRules: [] },
            },
            {
              name: 'Block XML-RPC',
              enabled: true,
              kind: 'CUSTOM',
              custom: {
                action: 'BLOCK',
                match: {
                  combine: 'ANY',
                  conditions: [{ field: 'PATH', operator: 'EXACT', value: '/xmlrpc.php' }],
                },
              },
            },
          ],
        },
      })
      const out = printed()
      expect(out).toContain('Firewall rules replaced: edge-waf (3 rules)')
      expect(out).toContain(
        'The new rules roll out to every cloud account the firewall is deployed in.'
      )
    })

    it('says the rules apply on first deploy when the firewall is not deployed', async () => {
      readFileSync.mockReturnValueOnce('[]')
      graphqlRequest
        .mockResolvedValueOnce(listResponse(unused))
        .mockResolvedValueOnce(rulesSet([{ status: 'RELEASED' }]))

      await run(['rules', 'set', 'staging-waf', '--file', 'rules.json'])

      expect(mutationInput(1)).toEqual({ id: 'fw_t5c9re', aws: { rules: [] } })
      expect(printed()).toContain(
        'The new rules apply when the firewall first deploys to a cloud account.'
      )
    })

    it('refuses a file that is not JSON without echoing its contents', async () => {
      readFileSync.mockReturnValueOnce('[{ "name": "sk_live_51Hx" ')
      graphqlRequest.mockResolvedValueOnce(listResponse(edgeWaf))

      await expect(run(['rules', 'set', 'edge-waf', '--file', 'waf/rules.json'])).rejects.toThrow(
        ExitError
      )

      expect(firstError()).toBe('Error: waf/rules.json is not valid JSON.')
      expect(graphqlRequest).toHaveBeenCalledTimes(1)
    })

    it('refuses a file it cannot read', async () => {
      readFileSync.mockImplementationOnce(() => {
        throw new Error("ENOENT: no such file or directory, open 'missing.json'")
      })
      graphqlRequest.mockResolvedValueOnce(listResponse(edgeWaf))

      await expect(run(['rules', 'set', 'edge-waf', '--file', 'missing.json'])).rejects.toThrow(
        ExitError
      )

      expect(firstError()).toBe('Error: There was an error while reading missing.json.')
    })

    it('names the rule a file gets wrong', async () => {
      readFileSync.mockReturnValueOnce(
        JSON.stringify([storedRules[0], { ...newRule, action: 'drop' }])
      )
      graphqlRequest.mockResolvedValueOnce(listResponse(edgeWaf))

      await expect(run(['rules', 'set', 'edge-waf', '--file', 'rules.json'])).rejects.toThrow(
        ExitError
      )

      expect(firstError()).toBe(
        'Error: rules.json is not a valid rules file. Rule 2: action must be block, allow, count, captcha, challenge.'
      )
      expect(graphqlRequest).toHaveBeenCalledTimes(1)
    })

    it('refuses a rules file for a firewall on another cloud', async () => {
      graphqlRequest.mockResolvedValueOnce(
        listResponse({ ...edgeWaf, provider: 'GCP', rules: { provider: 'gcp', rules: [] } })
      )

      await expect(run(['rules', 'set', 'edge-waf', '--file', 'rules.json'])).rejects.toThrow(
        ExitError
      )

      expect(firstError()).toBe('Error: The firewall configuration is not valid.')
      expect(readFileSync).not.toHaveBeenCalled()
      expect(graphqlRequest).toHaveBeenCalledTimes(1)
    })

    it("prints the server's refusal", async () => {
      readFileSync.mockReturnValueOnce(JSON.stringify(storedRules))
      graphqlRequest.mockResolvedValueOnce(listResponse(edgeWaf)).mockResolvedValueOnce({
        setFirewallRules: {
          success: false,
          message: 'Rule 1: the limit must be from 10 to 2,000,000,000.',
          firewall: null,
        },
      })

      await expect(run(['rules', 'set', 'edge-waf', '--file', 'rules.json'])).rejects.toThrow(
        ExitError
      )

      expect(firstError()).toBe('Error: Rule 1: the limit must be from 10 to 2,000,000,000.')
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
