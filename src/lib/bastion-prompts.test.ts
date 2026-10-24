import { input, select } from '@inquirer/prompts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

import type { Bastion } from './bastion-prompts'
import {
  activeOnly,
  createBastionInteractive,
  fetchBastion,
  fetchBastionCredentials,
  fetchBastions,
  nonDestroyed,
  pollBastionUntilActive,
  selectBastion,
} from './bastion-prompts'
import { graphqlRequest } from './client'
import { printError } from './output'

const HOST_PUBLIC_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICYYpJ9NxY3QwueHe9yfjYTdR8TqLEhJ5iV1nJjM/dj2'
const HOST_FINGERPRINT = 'SHA256:ZLHH8qScCNumv6jTt1L8kj+sFVAHleXj5Y3NxKTXIWs'

const spinner = vi.hoisted(() => ({
  start: vi.fn(),
  succeed: vi.fn(),
  fail: vi.fn(),
}))

vi.mock('@inquirer/prompts', () => ({ input: vi.fn(), select: vi.fn() }))
vi.mock('ora', () => ({ default: vi.fn(() => spinner) }))
vi.mock('./client', () => ({
  formatApiError: (error: unknown) => (error instanceof Error ? error.message : 'API error'),
  graphqlRequest: vi.fn(),
}))
vi.mock(import('./output'), async (importOriginal) => ({
  ...(await importOriginal()),
  printError: vi.fn(),
}))

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

function bastion(overrides: Partial<Omit<Bastion, 'status'>> & { status?: string } = {}): Bastion {
  return {
    slug: 'edge',
    name: 'Edge',
    status: 'active',
    networkId: 'n1',
    cloudAccountId: 'ca_1',
    publicIp: '203.0.113.10',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as Bastion
}

function respond(data: unknown) {
  vi.mocked(graphqlRequest).mockResolvedValueOnce(data)
}

describe('bastion prompts', () => {
  let exitSpy: MockInstance

  beforeEach(() => {
    vi.mocked(graphqlRequest).mockReset()
    vi.mocked(select).mockReset()
    vi.mocked(input).mockReset()
    vi.mocked(printError).mockReset()
    spinner.start.mockReset().mockReturnValue(spinner)
    spinner.succeed.mockReset()
    spinner.fail.mockReset()
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitError(code as number | undefined)
    })
  })

  afterEach(() => {
    exitSpy.mockRestore()
    vi.useRealTimers()
  })

  describe('fetchBastions', () => {
    it('filters by network only when one is given', async () => {
      respond({ bastions: [bastion()] })
      respond({ bastions: [] })

      await expect(fetchBastions('n1')).resolves.toEqual([bastion()])
      await expect(fetchBastions()).resolves.toEqual([])

      expect(vi.mocked(graphqlRequest).mock.calls[0][1]).toEqual({ networkId: 'n1' })
      expect(vi.mocked(graphqlRequest).mock.calls[1][1]).toEqual({})
    })
  })

  describe('fetchBastion', () => {
    it('returns the bastion or null', async () => {
      respond({ bastion: bastion() })
      respond({ bastion: null })

      await expect(fetchBastion('edge')).resolves.toEqual(bastion())
      await expect(fetchBastion('gone')).resolves.toBeNull()
    })
  })

  describe('fetchBastionCredentials', () => {
    it('returns the key and the recorded host key on success', async () => {
      respond({
        bastionPrivateKey: {
          success: true,
          privateKey: 'KEY',
          hostPublicKey: HOST_PUBLIC_KEY,
          hostKeyFingerprint: HOST_FINGERPRINT,
        },
      })

      await expect(fetchBastionCredentials('edge')).resolves.toEqual({
        privateKey: 'KEY',
        hostPublicKey: HOST_PUBLIC_KEY,
        hostKeyFingerprint: HOST_FINGERPRINT,
      })
    })

    it('returns null host key fields for a bastion provisioned before host keys', async () => {
      respond({
        bastionPrivateKey: {
          success: true,
          privateKey: 'KEY',
          hostPublicKey: null,
          hostKeyFingerprint: null,
        },
      })

      await expect(fetchBastionCredentials('edge')).resolves.toEqual({
        privateKey: 'KEY',
        hostPublicKey: null,
        hostKeyFingerprint: null,
      })
    })

    it('throws the server’s message when retrieval fails', async () => {
      respond({ bastionPrivateKey: { success: false, message: 'Bastion is not active.' } })

      await expect(fetchBastionCredentials('edge')).rejects.toThrow('Bastion is not active.')
    })

    it('throws a generic message when success carries no key', async () => {
      respond({ bastionPrivateKey: { success: true, privateKey: null } })

      await expect(fetchBastionCredentials('edge')).rejects.toThrow('Failed to retrieve SSH key')
    })
  })

  describe('selectBastion', () => {
    it('lists bastions with their status and public IP, and returns the chosen one', async () => {
      const noIp = bastion({ slug: 'inner', name: 'Inner', publicIp: null })
      respond({ bastions: [bastion(), noIp] })
      vi.mocked(select).mockResolvedValueOnce('inner')

      await expect(selectBastion()).resolves.toEqual(noIp)
      const { choices } = vi.mocked(select).mock.calls[0][0] as { choices: readonly unknown[] }
      expect(choices).toEqual([
        { name: 'Edge (active) — 203.0.113.10', value: 'edge' },
        { name: 'Inner (active)', value: 'inner' },
      ])
    })

    it('applies the filter and offers a create option', async () => {
      respond({ bastions: [bastion(), bastion({ slug: 'old', status: 'deleted' })] })
      vi.mocked(select).mockResolvedValueOnce('__create__')

      await expect(
        selectBastion({ networkId: 'n1', includeCreateOption: true, filter: nonDestroyed })
      ).resolves.toBe('create')
      const { choices } = vi.mocked(select).mock.calls[0][0] as {
        choices: readonly { value: string }[]
      }
      expect(choices.map((c) => c.value)).toEqual(['edge', '__create__'])
    })

    it('exits when nothing is selectable', async () => {
      respond({ bastions: [bastion({ status: 'pending' })] })

      await expect(selectBastion({ filter: activeOnly })).rejects.toThrow(ExitError)
      expect(printError).toHaveBeenCalledWith('No bastion hosts available.')
    })

    it('throws when the selection is not among the listed bastions', async () => {
      respond({ bastions: [bastion()] })
      vi.mocked(select).mockResolvedValueOnce('ghost')

      await expect(selectBastion()).rejects.toThrow('Selected bastion not found')
    })
  })

  describe('createBastionInteractive', () => {
    it('creates with the given ids and name without prompting', async () => {
      respond({ createBastion: { success: true, bastion: bastion({ status: 'pending' }) } })

      const created = await createBastionInteractive({
        cloudAccountId: 'ca_1',
        networkId: 'n1',
        name: 'My Edge',
        waitForActive: false,
      })

      expect(created.status).toBe('pending')
      expect(vi.mocked(graphqlRequest).mock.calls[0][1]).toEqual({
        input: { cloudAccountId: 'ca_1', networkId: 'n1', name: 'My Edge', slug: 'my-edge' },
      })
      expect(select).not.toHaveBeenCalled()
      expect(input).not.toHaveBeenCalled()
      expect(spinner.succeed).toHaveBeenCalledWith('Bastion created: Edge (edge)')
    })

    it('prompts for cloud, deployed network, and name, then waits until active', async () => {
      respond({ clouds: [{ id: 'ca_1', name: 'Prod', provider: 'aws' }] })
      respond({
        networks: [
          {
            id: 'n1',
            name: 'Main',
            slug: 'main',
            region: 'us-east-1',
            cloudAccountId: 'ca_1',
            stackStatus: 'Deployed',
          },
          {
            id: 'n2',
            name: 'Other',
            slug: 'other',
            region: 'us-east-1',
            cloudAccountId: 'ca_2',
            stackStatus: 'deployed',
          },
        ],
      })
      respond({ createBastion: { success: true, bastion: bastion({ status: 'pending' }) } })
      respond({ bastion: bastion() })
      vi.mocked(select).mockResolvedValueOnce('ca_1').mockResolvedValueOnce('n1')
      vi.mocked(input).mockResolvedValueOnce('Edge')

      await expect(createBastionInteractive({ slug: 'edge' })).resolves.toEqual(bastion())

      const networkChoices = (
        vi.mocked(select).mock.calls[1][0] as { choices: readonly { value: string }[] }
      ).choices
      expect(networkChoices.map((c) => c.value)).toEqual(['n1'])
      const nameConfig = vi.mocked(input).mock.calls[0][0] as {
        validate: (value: string) => boolean | string
      }
      expect(nameConfig.validate(' ')).toBe('Name is required')
      expect(nameConfig.validate('Edge')).toBe(true)
      expect(spinner.succeed).toHaveBeenLastCalledWith('Bastion is active')
    })

    it('exits when there are no cloud accounts', async () => {
      respond({ clouds: [] })

      await expect(createBastionInteractive({})).rejects.toThrow(ExitError)
      expect(printError).toHaveBeenCalledWith('No cloud accounts found.')
    })

    it('exits when the cloud account has no deployed network', async () => {
      respond({ networks: [] })

      await expect(createBastionInteractive({ cloudAccountId: 'ca_1' })).rejects.toThrow(ExitError)
      expect(printError).toHaveBeenCalledWith(
        'No active networks found for the selected cloud account.'
      )
    })

    it('exits with the server’s message when creation is refused', async () => {
      respond({ createBastion: { success: false, message: 'Bastion limit reached.' } })

      await expect(
        createBastionInteractive({ cloudAccountId: 'ca_1', networkId: 'n1', name: 'x' })
      ).rejects.toThrow(ExitError)
      expect(spinner.fail).toHaveBeenCalledWith('Bastion limit reached.')
    })

    it('exits with a formatted API error when the request fails', async () => {
      vi.mocked(graphqlRequest).mockRejectedValueOnce(new Error('Forbidden.'))

      await expect(
        createBastionInteractive({ cloudAccountId: 'ca_1', networkId: 'n1', name: 'x' })
      ).rejects.toThrow(ExitError)
      expect(spinner.fail).toHaveBeenCalledWith('Failed to create bastion')
      expect(printError).toHaveBeenCalledWith('Forbidden.')
    })
  })

  describe('pollBastionUntilActive', () => {
    it('polls until the bastion is active', async () => {
      vi.useFakeTimers()
      respond({ bastion: null })
      respond({ bastion: bastion({ status: 'ACTIVE' }) })

      const polled = pollBastionUntilActive('edge')
      await vi.advanceTimersByTimeAsync(2000)

      await expect(polled).resolves.toMatchObject({ status: 'ACTIVE' })
      expect(graphqlRequest).toHaveBeenCalledTimes(2)
    })

    it('exits when provisioning fails', async () => {
      respond({ bastion: bastion({ status: 'failed' }) })

      await expect(pollBastionUntilActive('edge')).rejects.toThrow(ExitError)
      expect(spinner.fail).toHaveBeenCalledWith('Bastion failed to provision')
    })

    it('exits when the bastion does not become active in time', async () => {
      vi.useFakeTimers()
      vi.mocked(graphqlRequest).mockResolvedValue({ bastion: bastion({ status: 'pending' }) })

      const polled = pollBastionUntilActive('edge', 3000)
      const settled = expect(polled).rejects.toThrow(ExitError)
      await vi.advanceTimersByTimeAsync(4000)

      await settled
      expect(spinner.fail).toHaveBeenCalledWith('Timed out waiting for bastion to become active')
    })
  })

  describe('status filters', () => {
    it('match status case-insensitively', () => {
      expect(activeOnly(bastion({ status: 'Active' }))).toBe(true)
      expect(activeOnly(bastion({ status: 'pending' }))).toBe(false)
      expect(nonDestroyed(bastion({ status: 'DELETED' }))).toBe(false)
      expect(nonDestroyed(bastion({ status: 'deleting' }))).toBe(false)
      expect(nonDestroyed(bastion({ status: 'delete_failed' }))).toBe(true)
      expect(nonDestroyed(bastion({ status: 'active' }))).toBe(true)
    })
  })
})
