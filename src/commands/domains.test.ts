import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

const graphqlRequest = vi.hoisted(() => vi.fn())
const input = vi.hoisted(() => vi.fn())
const select = vi.hoisted(() => vi.fn())
const resolveCloud = vi.hoisted(() =>
  vi.fn((id?: string) => Promise.resolve({ id: id ?? 'cloud_1', provider: 'AWS' }))
)
const selectDomain = vi.hoisted(() => vi.fn())
const checkbox = vi.hoisted(() => vi.fn())
const fetchRegions = vi.hoisted(() =>
  vi.fn(() =>
    Promise.resolve([
      { code: 'us-east-1', name: 'US East (N. Virginia)' },
      { code: 'us-west-2', name: 'US West (Oregon)' },
      { code: 'eu-west-1', name: 'Europe (Ireland)' },
    ])
  )
)

vi.mock('@inquirer/prompts', () => ({ checkbox, input, select }))
vi.mock('../lib/client', () => ({
  formatApiError: (error: unknown) => (error instanceof Error ? error.message : 'API error'),
  graphqlRequest,
}))
vi.mock('../lib/interactive-prompts', () => ({ fetchRegions, resolveCloud, selectDomain }))

const { registerDomainsCommand } = await import('./domains')

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

type Validator = (value: string) => string | true

const domain = {
  id: 'dom_8f2k1',
  name: 'example.com',
  createdAt: '2026-03-14T12:00:00Z',
  updatedAt: '2026-03-14T12:00:00Z',
}

const certificate = {
  id: 'cert_9q3x',
  primaryDomain: 'example.com',
  status: 'pending',
  createdAt: '2026-03-14T12:00:00Z',
}

async function run(args: string[]): Promise<void> {
  const program = new Command()
  registerDomainsCommand(program)
  await program.parseAsync(['node', 'gantry', 'domains', ...args])
}

describe('domains command', () => {
  let logSpy: MockInstance
  let errorSpy: MockInstance

  beforeEach(() => {
    vi.clearAllMocks()
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
    return logSpy.mock.calls.map((call) => String(call[0])).join('\n')
  }

  function printedErrors(): string {
    return errorSpy.mock.calls.map((call) => String(call[0])).join('\n')
  }

  function validatorFor(message: string): Validator {
    const call = input.mock.calls.find(
      (args) => (args[0] as { message: string }).message === message
    )
    return (call?.[0] as { validate: Validator }).validate
  }

  describe('list', () => {
    it('queries domains and prints a sanitised table', async () => {
      graphqlRequest.mockResolvedValueOnce({
        domains: [{ ...domain, name: 'example.com\x1b]0;pwned\x07' }],
      })

      await run(['list'])

      expect(String(graphqlRequest.mock.calls[0]?.[0])).toContain('query GetDomains')
      expect(printed()).toContain('dom_8f2k1')
      expect(printed()).toContain('example.com')
      expect(printed()).toContain('Mar 14, 2026')
      expect(printed()).not.toContain('pwned')
    })

    it('reports when there are no domains', async () => {
      graphqlRequest.mockResolvedValueOnce({ domains: [] })

      await run(['list'])

      expect(printed()).toBe('No domains found.')
    })

    it('prints the API error and exits non-zero', async () => {
      graphqlRequest.mockRejectedValueOnce(new Error('Unauthorized'))

      await expect(run(['list'])).rejects.toThrow('process.exit(1)')

      expect(printedErrors()).toContain('Unauthorized')
    })
  })

  describe('create', () => {
    it('creates a lowercased domain from flags without requesting a certificate', async () => {
      graphqlRequest.mockResolvedValueOnce({ createDomain: { success: true, domain } })

      await run(['create', '--name', ' Example.COM '])

      expect(String(graphqlRequest.mock.calls[0]?.[0])).toContain('mutation CreateDomain')
      expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({ input: { name: 'example.com' } })
      expect(select).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Request a certificate for this domain?' })
      )
      expect(graphqlRequest).toHaveBeenCalledTimes(1)
      expect(printed()).toContain('Domain created: example.com')
      expect(printed()).toContain('ID: dom_8f2k1')
    })

    it('prompts for the name and validates it interactively', async () => {
      input.mockResolvedValueOnce('example.com')
      select.mockResolvedValueOnce(false)
      graphqlRequest.mockResolvedValueOnce({ createDomain: { success: true, domain } })

      await run(['create'])

      const validate = validatorFor('Domain name (e.g., example.com):')
      expect(validate('  ')).toBe('Domain name is required')
      expect(validate('app.example.com')).toContain('Only root domains can be registered')
      expect(validate('example.com')).toBe(true)
      expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({ input: { name: 'example.com' } })
    })

    it('rejects a subdomain passed by flag before calling the API', async () => {
      await expect(run(['create', '--name', 'app.example.com'])).rejects.toThrow(ExitError)

      expect(printedErrors()).toContain('Register "example.com"')
      expect(graphqlRequest).not.toHaveBeenCalled()
    })

    it('exits with the server message when creation fails', async () => {
      graphqlRequest.mockResolvedValueOnce({
        createDomain: { success: false, message: 'Domain already exists\x1b[2J' },
      })

      await expect(run(['create', '--name', 'example.com'])).rejects.toThrow('process.exit(1)')

      expect(printedErrors()).toContain('Domain already exists')
      expect(printedErrors()).not.toContain('\x1b[2J')
    })

    it('falls back to a generic message when the domain is missing', async () => {
      graphqlRequest.mockResolvedValueOnce({ createDomain: { success: true } })

      await expect(run(['create', '--name', 'example.com'])).rejects.toThrow(ExitError)

      expect(printedErrors()).toContain('Failed to create domain')
    })

    it('strips terminal escapes from the created domain ID', async () => {
      graphqlRequest.mockResolvedValueOnce({
        createDomain: { success: true, domain: { ...domain, id: 'dom_1\x1b]0;pwned\x07' } },
      })

      select.mockResolvedValueOnce(false)

      await run(['create', '--name', 'example.com'])

      expect(printed()).toContain('ID: dom_1')
      expect(printed()).not.toContain('pwned')
    })

    it('requests a certificate entirely from flags', async () => {
      graphqlRequest
        .mockResolvedValueOnce({ createDomain: { success: true, domain } })
        .mockResolvedValueOnce({ createCertificate: { success: true, certificate } })

      await run([
        'create',
        '--name',
        'example.com',
        '--request-cert',
        '--cloud',
        'cloud_aws_1',
        '--aws-regions',
        'us-east-1, eu-west-1',
        '--primary-domain',
        '*.example.com',
        '--additional-domains',
        'example.com,www.example.com',
      ])

      expect(select).not.toHaveBeenCalled()
      expect(input).not.toHaveBeenCalled()
      expect(resolveCloud).toHaveBeenCalledWith(expect.any(String))
      expect(checkbox).not.toHaveBeenCalled()
      expect(String(graphqlRequest.mock.calls[1]?.[0])).toContain('mutation CreateCertificate')
      expect(graphqlRequest.mock.calls[1]?.[1]).toEqual({
        input: {
          cloudAccountId: 'cloud_aws_1',
          domainId: 'dom_8f2k1',
          primaryDomain: '*.example.com',
          aws: { regions: ['us-east-1', 'eu-west-1'] },
          additionalDomains: ['example.com', 'www.example.com'],
        },
      })
      expect(printed()).toContain('Certificate requested: example.com')
      expect(printed()).toContain('Certificate ID: cert_9q3x')
      expect(printed()).toContain('Status: PENDING')
    })

    it('walks the interactive certificate flow and omits empty additional domains', async () => {
      graphqlRequest
        .mockResolvedValueOnce({ createDomain: { success: true, domain } })
        .mockResolvedValueOnce({ createCertificate: { success: true, certificate } })
      select.mockResolvedValueOnce(true)
      resolveCloud.mockResolvedValueOnce({ id: 'cloud_aws_1', provider: 'AWS' })
      input.mockResolvedValueOnce('example.com').mockResolvedValueOnce('   ')
      checkbox.mockResolvedValueOnce(['us-east-1'])

      await run(['create', '--name', 'example.com'])

      const validate = validatorFor('Primary domain for certificate:')
      expect(validate('')).toBe('Primary domain is required')
      expect(validate('not a domain')).toContain('Please enter a valid domain name')
      expect(validate('*.example.com')).toBe(true)
      expect(input).toHaveBeenCalledWith(expect.objectContaining({ default: 'example.com' }))
      expect(graphqlRequest.mock.calls[1]?.[1]).toEqual({
        input: {
          cloudAccountId: 'cloud_aws_1',
          domainId: 'dom_8f2k1',
          primaryDomain: 'example.com',
          aws: { regions: ['us-east-1'] },
        },
      })
    })

    it('parses prompted additional domains', async () => {
      graphqlRequest
        .mockResolvedValueOnce({ createDomain: { success: true, domain } })
        .mockResolvedValueOnce({ createCertificate: { success: true, certificate } })
      input
        .mockResolvedValueOnce('example.com')
        .mockResolvedValueOnce('www.example.com\napi.example.com')

      await run([
        'create',
        '--name',
        'example.com',
        '--request-cert',
        '--cloud',
        'c1',
        '--aws-regions',
        'us-east-1',
      ])

      expect(graphqlRequest.mock.calls[1]?.[1]).toMatchObject({
        input: { additionalDomains: ['www.example.com', 'api.example.com'] },
      })
    })

    it('rejects an invalid additional domain before requesting the certificate', async () => {
      graphqlRequest.mockResolvedValueOnce({ createDomain: { success: true, domain } })

      await expect(
        run([
          'create',
          '--name',
          'example.com',
          '--request-cert',
          '--cloud',
          'c1',
          '--primary-domain',
          'example.com',
          '--additional-domains',
          'www.example.com,bad_domain!',
        ])
      ).rejects.toThrow(ExitError)

      expect(printedErrors()).toContain('Invalid domain: bad_domain!')
      expect(graphqlRequest).toHaveBeenCalledTimes(1)
    })

    it('rejects an invalid --primary-domain before requesting the certificate', async () => {
      graphqlRequest.mockResolvedValueOnce({ createDomain: { success: true, domain } })

      await expect(
        run([
          'create',
          '--name',
          'example.com',
          '--request-cert',
          '--cloud',
          'c1',
          '--primary-domain',
          'bad domain',
        ])
      ).rejects.toThrow(ExitError)

      expect(printedErrors()).toContain('Please enter a valid domain name')
      expect(graphqlRequest).toHaveBeenCalledTimes(1)
    })

    it('exits when the certificate request is unsuccessful', async () => {
      graphqlRequest
        .mockResolvedValueOnce({ createDomain: { success: true, domain } })
        .mockResolvedValueOnce({ createCertificate: { success: false } })

      await expect(
        run([
          'create',
          '--name',
          'example.com',
          '--request-cert',
          '--cloud',
          'c1',
          '--aws-regions',
          'us-east-1',
          '--primary-domain',
          'example.com',
          '--additional-domains',
          'www.example.com',
        ])
      ).rejects.toThrow('process.exit(1)')

      expect(printedErrors()).toContain('Failed to request certificate')
    })

    it('prints the API error when the mutation throws', async () => {
      graphqlRequest.mockRejectedValueOnce(new Error('Network unreachable'))

      await expect(run(['create', '--name', 'example.com'])).rejects.toThrow('process.exit(1)')

      expect(printedErrors()).toContain('Network unreachable')
    })
  })

  describe('request-cert', () => {
    it('looks up the domain by ID and requests a certificate from flags', async () => {
      graphqlRequest
        .mockResolvedValueOnce({ domains: [{ ...domain, id: 'dom_other' }, domain] })
        .mockResolvedValueOnce({
          createCertificate: {
            success: true,
            certificate: { ...certificate, id: 'cert_1\x1b]0;x\x07', status: 'validating\x1b[2J' },
          },
        })

      await run([
        'request-cert',
        'dom_8f2k1',
        '--cloud',
        'cloud_aws_1',
        '--aws-regions',
        'us-east-1',
        '--primary-domain',
        'example.com',
        '--additional-domains',
        '*.example.com',
      ])

      expect(String(graphqlRequest.mock.calls[0]?.[0])).toContain('query GetDomains')
      expect(graphqlRequest.mock.calls[1]?.[1]).toEqual({
        input: {
          cloudAccountId: 'cloud_aws_1',
          domainId: 'dom_8f2k1',
          primaryDomain: 'example.com',
          aws: { regions: ['us-east-1'] },
          additionalDomains: ['*.example.com'],
        },
      })
      expect(printed()).toContain('Certificate ID: cert_1')
      expect(printed()).toContain('Status: VALIDATING')
      expect(printed()).not.toContain('\x1b]0;')
      expect(printed()).not.toContain('\x1b[2J')
    })

    it('exits when the domain ID is unknown', async () => {
      graphqlRequest.mockResolvedValueOnce({ domains: [domain] })

      await expect(run(['request-cert', 'dom_missing'])).rejects.toThrow('process.exit(1)')

      expect(printedErrors()).toContain('Domain not found: dom_missing')
      expect(graphqlRequest).toHaveBeenCalledTimes(1)
    })

    it('selects the domain, cloud, and regions interactively', async () => {
      selectDomain.mockResolvedValueOnce({ id: 'dom_8f2k1', name: 'example.com' })
      resolveCloud.mockResolvedValueOnce({ id: 'cloud_aws_1', provider: 'AWS' })
      input.mockResolvedValueOnce('example.com').mockResolvedValueOnce('www.example.com')
      checkbox.mockResolvedValueOnce(['us-west-2'])
      graphqlRequest.mockResolvedValueOnce({ createCertificate: { success: true, certificate } })

      await run(['request-cert'])

      expect(input).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Primary domain for certificate:',
          default: 'example.com',
        })
      )
      expect(graphqlRequest).toHaveBeenCalledTimes(1)
      expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({
        input: {
          cloudAccountId: 'cloud_aws_1',
          domainId: 'dom_8f2k1',
          primaryDomain: 'example.com',
          aws: { regions: ['us-west-2'] },
          additionalDomains: ['www.example.com'],
        },
      })
    })

    it('omits additional domains when the prompt is left blank', async () => {
      selectDomain.mockResolvedValueOnce({ id: 'dom_8f2k1', name: 'example.com' })
      input.mockResolvedValueOnce('')
      graphqlRequest.mockResolvedValueOnce({ createCertificate: { success: true, certificate } })

      await run([
        'request-cert',
        '--cloud',
        'c1',
        '--aws-regions',
        'us-east-1',
        '--primary-domain',
        'example.com',
      ])

      expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({
        input: {
          cloudAccountId: 'c1',
          domainId: 'dom_8f2k1',
          primaryDomain: 'example.com',
          aws: { regions: ['us-east-1'] },
        },
      })
    })

    it('rejects an invalid --primary-domain', async () => {
      selectDomain.mockResolvedValueOnce({ id: 'dom_8f2k1', name: 'example.com' })

      await expect(
        run(['request-cert', '--cloud', 'c1', '--primary-domain', '-bad-.com'])
      ).rejects.toThrow(ExitError)

      expect(printedErrors()).toContain('Please enter a valid domain name')
      expect(graphqlRequest).not.toHaveBeenCalled()
    })

    it('rejects an invalid additional domain', async () => {
      selectDomain.mockResolvedValueOnce({ id: 'dom_8f2k1', name: 'example.com' })

      await expect(
        run([
          'request-cert',
          '--cloud',
          'c1',
          '--primary-domain',
          'example.com',
          '--additional-domains',
          'ok.com,no way',
        ])
      ).rejects.toThrow(ExitError)

      expect(printedErrors()).toContain('Invalid domain: no way')
      expect(graphqlRequest).not.toHaveBeenCalled()
    })

    it('exits with the server message when the request fails', async () => {
      selectDomain.mockResolvedValueOnce({ id: 'dom_8f2k1', name: 'example.com' })
      graphqlRequest.mockResolvedValueOnce({
        createCertificate: { success: false, message: 'Certificate limit reached' },
      })

      await expect(
        run([
          'request-cert',
          '--cloud',
          'c1',
          '--aws-regions',
          'us-east-1',
          '--primary-domain',
          'example.com',
          '--additional-domains',
          'www.example.com',
        ])
      ).rejects.toThrow('process.exit(1)')

      expect(printedErrors()).toContain('Certificate limit reached')
    })

    it('falls back to a generic message when no certificate is returned', async () => {
      selectDomain.mockResolvedValueOnce({ id: 'dom_8f2k1', name: 'example.com' })
      graphqlRequest.mockResolvedValueOnce({ createCertificate: { success: true } })

      await expect(
        run([
          'request-cert',
          '--cloud',
          'c1',
          '--aws-regions',
          'us-east-1',
          '--primary-domain',
          'example.com',
          '--additional-domains',
          'www.example.com',
        ])
      ).rejects.toThrow(ExitError)

      expect(printedErrors()).toContain('Failed to request certificate')
    })

    it('prints the API error when the lookup throws', async () => {
      graphqlRequest.mockRejectedValueOnce(new Error('Forbidden'))

      await expect(run(['request-cert', 'dom_8f2k1'])).rejects.toThrow('process.exit(1)')

      expect(printedErrors()).toContain('Forbidden')
    })

    const certFlags = [
      'request-cert',
      'dom_8f2k1',
      '--primary-domain',
      'example.com',
      '--additional-domains',
      'www.example.com',
    ]

    it('refuses a cloud that cannot issue certificates without requesting one', async () => {
      graphqlRequest.mockResolvedValueOnce({ domains: [domain] })
      resolveCloud.mockResolvedValueOnce({ id: 'cloud_cf_1', provider: 'CLOUDFLARE' })

      await expect(run([...certFlags, '--cloud', 'cloud_cf_1'])).rejects.toThrow(ExitError)

      expect(printedErrors()).toContain("This cloud doesn't support certificates yet.")
      expect(graphqlRequest).toHaveBeenCalledTimes(1)
    })

    it("refuses a region the cloud doesn't offer", async () => {
      graphqlRequest.mockResolvedValueOnce({ domains: [domain] })

      await expect(
        run([...certFlags, '--cloud', 'cloud_aws_1', '--aws-regions', 'us-east-1,mars-north-1'])
      ).rejects.toThrow(ExitError)

      expect(printedErrors()).toContain('Unknown region: mars-north-1.')
      expect(graphqlRequest).toHaveBeenCalledTimes(1)
    })
  })
})
