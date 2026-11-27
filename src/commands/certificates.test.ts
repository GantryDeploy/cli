import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

const graphqlRequest = vi.hoisted(() => vi.fn())

vi.mock('../lib/client', () => ({
  formatApiError: (error: unknown) => (error instanceof Error ? error.message : 'API error'),
  graphqlRequest,
}))

const { registerCertificatesCommand } = await import('./certificates')

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

const shop = {
  id: 'Cq7mXw2R',
  primaryDomain: 'shop.acme.com',
  additionalDomains: [],
  status: 'ACTIVE',
  lastCheckedAt: '2026-11-27T21:00:00Z',
  regionalCertificates: [
    {
      region: 'us-east-1',
      status: 'ACTIVE',
      lastValidatedAt: null,
      validationAttempts: 1,
      dnsRecords: [],
    },
    {
      region: 'us-west-2',
      status: 'ACTIVE',
      lastValidatedAt: null,
      validationAttempts: 1,
      dnsRecords: [],
    },
  ],
}

const api = {
  id: 'Tn4kZp9L',
  primaryDomain: 'api.acme.com',
  additionalDomains: ['www.api.acme.com'],
  status: 'VALIDATING',
  lastCheckedAt: '2026-11-27T21:00:00Z',
  regionalCertificates: [
    {
      region: 'us-east-1',
      status: 'VALIDATING',
      lastValidatedAt: '2026-11-27T21:56:00Z',
      validationAttempts: 3,
      dnsRecords: [
        {
          name: '_3f9a2c.api.acme.com.',
          type: 'CNAME',
          value: '_b81e47.acm-validations.aws.',
        },
      ],
    },
  ],
}

async function run(args: string[]): Promise<void> {
  const program = new Command()
  program.exitOverride()
  registerCertificatesCommand(program)
  await program.parseAsync(['node', 'gantry', 'certificates', ...args])
}

describe('certificates command', () => {
  let errorSpy: MockInstance
  let logSpy: MockInstance
  const logOutput = () => logSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n')
  const errorOutput = () => errorSpy.mock.calls.flat().join(' ')

  beforeEach(() => {
    vi.resetAllMocks()
    vi.useFakeTimers({ now: new Date('2026-11-27T22:00:00Z') })
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitError(code as number | undefined)
    })
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('list', () => {
    it('prints a row per certificate with its regions', async () => {
      graphqlRequest.mockResolvedValueOnce({ certificates: [shop, api] })

      await run(['list'])

      const output = logOutput()
      expect(output).toContain('shop.acme.com')
      expect(output).toContain('us-east-1, us-west-2')
      expect(output).toContain('VALIDATING')
    })

    it('filters by cloud account and domain', async () => {
      graphqlRequest.mockResolvedValueOnce({ certificates: [] })

      await run(['list', '--cloud', 'Jt5wPq8N', '--domain', 'Fk8rLs3V'])

      expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({
        cloudAccountId: 'Jt5wPq8N',
        domainId: 'Fk8rLs3V',
      })
      expect(logOutput()).toContain('No certificates found.')
    })

    it('prints JSON', async () => {
      graphqlRequest.mockResolvedValueOnce({ certificates: [shop] })

      await run(['list', '--json'])

      expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toEqual([shop])
    })
  })

  describe('show', () => {
    it('lists each region and the records a waiting region needs', async () => {
      graphqlRequest.mockResolvedValueOnce({ certificates: [shop, api] })

      await run(['show', 'Tn4kZp9L'])

      const output = logOutput()
      expect(output).toContain('api.acme.com (also: www.api.acme.com)  VALIDATING')
      expect(output).toContain('us-east-1  validating  checked 4 minutes ago, attempt 3')
      expect(output).toContain(
        'Create: CNAME _3f9a2c.api.acme.com. -> _b81e47.acm-validations.aws.'
      )
    })

    it('refuses a certificate the team does not have', async () => {
      graphqlRequest.mockResolvedValueOnce({ certificates: [shop] })

      await expect(run(['show', 'Zz9yXw8V'])).rejects.toThrow(ExitError)
      expect(errorOutput()).toContain('Certificate not found.')
    })
  })

  describe('validate', () => {
    it('checks every waiting region again', async () => {
      graphqlRequest.mockResolvedValueOnce({ certificates: [api] }).mockResolvedValueOnce({
        triggerCertificateValidation: {
          success: true,
          message: 'Triggered revalidation for 1 regional certificate(s)',
        },
      })

      await run(['validate', 'Tn4kZp9L'])

      expect(graphqlRequest.mock.calls[1]?.[1]).toEqual({ id: 'Tn4kZp9L' })
      expect(logOutput()).toContain('gantry certificates show Tn4kZp9L')
    })

    it('checks one region with --region', async () => {
      graphqlRequest.mockResolvedValueOnce({ certificates: [api] }).mockResolvedValueOnce({
        triggerCertificateValidation: { success: true, message: 'Triggered' },
      })

      await run(['validate', 'Tn4kZp9L', '--region', 'us-east-1'])

      expect(graphqlRequest.mock.calls[1]?.[1]).toEqual({ id: 'Tn4kZp9L', region: 'us-east-1' })
    })

    it('makes no request for a certificate that is already active', async () => {
      graphqlRequest.mockResolvedValueOnce({ certificates: [shop] })

      await run(['validate', 'Cq7mXw2R'])

      expect(logOutput()).toContain('shop.acme.com is already active.')
      expect(graphqlRequest).toHaveBeenCalledTimes(1)
    })

    it("prints the API's refusal", async () => {
      graphqlRequest.mockResolvedValueOnce({ certificates: [api] }).mockResolvedValueOnce({
        triggerCertificateValidation: {
          success: false,
          message: 'This certificate has no copy in eu-west-1.',
        },
      })

      await expect(run(['validate', 'Tn4kZp9L', '--region', 'eu-west-1'])).rejects.toThrow(
        ExitError
      )
      expect(errorOutput()).toContain('This certificate has no copy in eu-west-1.')
    })
  })
})
