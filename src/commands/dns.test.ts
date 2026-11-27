import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

const graphqlRequest = vi.hoisted(() => vi.fn())

vi.mock('../lib/client', () => ({
  formatApiError: (error: unknown) => (error instanceof Error ? error.message : 'API error'),
  graphqlRequest,
}))

const { registerDnsCommand } = await import('./dns')

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

const domains = { domains: [{ id: 'Fk8rLs3V', name: 'acme.com' }] }

const mx = {
  id: 'Re3mQx7T',
  recordType: 'MX',
  name: 'acme.com',
  value: 'mail.acme.com',
  valueData: { kind: 'mx', priority: 10 },
  provider: 'aws',
  providerData: null,
  source: 'MANUAL',
  verified: true,
  syncStatus: 'APPLIED',
  syncError: null,
  conflict: false,
}

const route = {
  ...mx,
  id: 'Wk8vPn2L',
  recordType: 'CNAME',
  name: 'shop',
  value: 'd3k9x2.cloudfront.net',
  valueData: null,
  source: 'ROUTE',
}

async function run(args: string[]): Promise<void> {
  const program = new Command()
  program.exitOverride()
  registerDnsCommand(program)
  await program.parseAsync(['node', 'gantry', 'dns', 'records', ...args])
}

describe('dns records command', () => {
  let errorSpy: MockInstance
  let logSpy: MockInstance
  const logOutput = () => logSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n')
  const errorOutput = () => errorSpy.mock.calls.flat().join(' ')

  beforeEach(() => {
    vi.resetAllMocks()
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitError(code as number | undefined)
    })
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('list', () => {
    it("lists a domain's records, named by hostname, with an MX priority first", async () => {
      graphqlRequest
        .mockResolvedValueOnce(domains)
        .mockResolvedValueOnce({ dnsRecords: [mx, route] })

      await run(['list', 'acme.com'])

      expect(graphqlRequest.mock.calls[1]?.[1]).toEqual({ domainId: 'Fk8rLs3V' })
      const output = logOutput()
      expect(output).toContain('10 mail.acme.com')
      expect(output).toContain('d3k9x2.cloudfront.net')
      expect(output).toContain('route')
    })

    it('filters by source and accepts a domain id', async () => {
      graphqlRequest.mockResolvedValueOnce(domains).mockResolvedValueOnce({ dnsRecords: [mx] })

      await run(['list', 'Fk8rLs3V', '--source', 'manual'])

      expect(graphqlRequest.mock.calls[1]?.[1]).toEqual({ domainId: 'Fk8rLs3V', source: 'MANUAL' })
    })

    it('refuses an unknown source before calling the API', async () => {
      await expect(run(['list', 'acme.com', '--source', 'imported'])).rejects.toThrow(ExitError)

      expect(errorOutput()).toContain('--source must be manual, route or certificate.')
      expect(graphqlRequest).not.toHaveBeenCalled()
    })

    it('refuses a domain the team does not have', async () => {
      graphqlRequest.mockResolvedValueOnce(domains)

      await expect(run(['list', 'acme.dev'])).rejects.toThrow(ExitError)
      expect(errorOutput()).toContain('Domain not found.')
    })
  })

  describe('create', () => {
    it('creates a TXT record on the domain', async () => {
      graphqlRequest.mockResolvedValueOnce(domains).mockResolvedValueOnce({
        createDnsRecord: {
          success: true,
          message: 'Created TXT _github-challenge. Applying it now.',
          record: { id: 'Pm6tRc2Z' },
        },
      })

      await run([
        'create',
        'acme.com',
        '--type',
        'TXT',
        '--name',
        '_github-challenge',
        '--value',
        '8f2c91ab4e',
      ])

      expect(graphqlRequest.mock.calls[1]?.[1]).toEqual({
        input: {
          domainId: 'Fk8rLs3V',
          recordType: 'TXT',
          name: '_github-challenge',
          value: '8f2c91ab4e',
        },
      })
      expect(logOutput()).toContain('Created TXT _github-challenge. Applying it now.')
      expect(logOutput()).toContain('ID: Pm6tRc2Z')
    })

    it('sends an MX priority and Cloudflare proxying', async () => {
      graphqlRequest.mockResolvedValueOnce(domains).mockResolvedValueOnce({
        createDnsRecord: { success: true, message: 'Created', record: { id: 'Pm6tRc2Z' } },
      })

      await run([
        'create',
        'acme.com',
        '--type',
        'A',
        '--name',
        'status',
        '--value',
        '203.0.113.24',
        '--cloudflare-proxied',
      ])

      expect(graphqlRequest.mock.calls[1]?.[1]).toMatchObject({
        input: { cloudflare: { proxied: true } },
      })
    })

    it("prints the API's refusal", async () => {
      graphqlRequest.mockResolvedValueOnce(domains).mockResolvedValueOnce({
        createDnsRecord: {
          success: false,
          message:
            'This domain is not connected to a managed DNS provider. Change its records at your DNS provider.',
          record: null,
        },
      })

      await expect(
        run(['create', 'acme.com', '--type', 'TXT', '--name', 'x', '--value', 'y'])
      ).rejects.toThrow(ExitError)
      expect(errorOutput()).toContain('not connected to a managed DNS provider')
    })
  })

  describe('update', () => {
    it('changes a record by id', async () => {
      graphqlRequest.mockResolvedValueOnce({
        updateDnsRecord: { success: true, message: 'Updated MX acme.com. Applying it now.' },
      })

      await run(['update', 'Re3mQx7T', '--value', 'mx2.acme.com', '--priority', '20'])

      expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({
        id: 'Re3mQx7T',
        input: { value: 'mx2.acme.com', priority: 20 },
      })
      expect(logOutput()).toContain('Updated MX acme.com.')
    })

    it('turns Cloudflare proxying off', async () => {
      graphqlRequest.mockResolvedValueOnce({
        updateDnsRecord: { success: true, message: 'Updated' },
      })

      await run(['update', 'Re3mQx7T', '--cloudflare-no-proxied'])

      expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({
        id: 'Re3mQx7T',
        input: { cloudflare: { proxied: false } },
      })
    })

    it('refuses an update with nothing to change', async () => {
      await expect(run(['update', 'Re3mQx7T'])).rejects.toThrow(ExitError)

      expect(errorOutput()).toContain('Nothing to change.')
      expect(graphqlRequest).not.toHaveBeenCalled()
    })

    it("prints the API's refusal for a record Gantry manages", async () => {
      graphqlRequest.mockResolvedValueOnce({
        updateDnsRecord: {
          success: false,
          message: 'Gantry manages this record, so it cannot be changed.',
        },
      })

      await expect(run(['update', 'Wk8vPn2L', '--value', 'x'])).rejects.toThrow(ExitError)
      expect(errorOutput()).toContain('Gantry manages this record')
    })
  })

  describe('verify', () => {
    it('asks the API to check the record again', async () => {
      graphqlRequest.mockResolvedValueOnce({
        verifyDnsRecord: { success: true, message: 'Checking MX acme.com again.' },
      })

      await run(['verify', 'Re3mQx7T'])

      expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({ id: 'Re3mQx7T' })
      expect(logOutput()).toContain('Checking MX acme.com again.')
    })
  })
})
