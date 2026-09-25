import { checkbox, input, select } from '@inquirer/prompts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

import { graphqlRequest } from './client'
import {
  promptName,
  selectCloud,
  selectDomain,
  selectEnvironment,
  selectNetwork,
  selectProject,
  selectRegion,
  selectRegions,
  selectSecret,
} from './interactive-prompts'
import { printError } from './output'

vi.mock('@inquirer/prompts', () => ({ checkbox: vi.fn(), input: vi.fn(), select: vi.fn() }))
vi.mock('./client', () => ({ graphqlRequest: vi.fn() }))
vi.mock('./output', () => ({ printError: vi.fn() }))

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

function respond(data: unknown) {
  vi.mocked(graphqlRequest).mockResolvedValueOnce(data)
}

function choicesOfLastSelect() {
  return (vi.mocked(select).mock.calls.at(-1)?.[0] as { choices: readonly unknown[] }).choices
}

describe('interactive prompts', () => {
  let exitSpy: MockInstance

  beforeEach(() => {
    vi.mocked(graphqlRequest).mockReset()
    vi.mocked(select).mockReset()
    vi.mocked(checkbox).mockReset()
    vi.mocked(input).mockReset()
    vi.mocked(printError).mockReset()
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitError(code as number | undefined)
    })
  })

  afterEach(() => {
    exitSpy.mockRestore()
  })

  describe('selectCloud', () => {
    it('offers each cloud account by name and provider', async () => {
      respond({ clouds: [{ id: 'ca_1', name: 'Prod', provider: 'aws' }] })
      vi.mocked(select).mockResolvedValueOnce('ca_1')

      await expect(selectCloud()).resolves.toBe('ca_1')
      expect(choicesOfLastSelect()).toEqual([{ name: 'Prod (AWS)', value: 'ca_1' }])
    })

    it('exits when there are no cloud accounts', async () => {
      respond({ clouds: [] })

      await expect(selectCloud()).rejects.toThrow(ExitError)
      expect(printError).toHaveBeenCalledWith('No cloud accounts found.')
      expect(select).not.toHaveBeenCalled()
    })
  })

  describe('selectNetwork', () => {
    const networks = [
      {
        id: 'n1',
        name: 'Main',
        slug: 'main',
        region: 'us-east-1',
        cloudAccountId: 'ca_1',
        stackStatus: 'DEPLOYED',
      },
      {
        id: 'n2',
        name: 'Other',
        slug: 'other',
        region: 'us-west-2',
        cloudAccountId: 'ca_2',
        stackStatus: 'deployed',
      },
      {
        id: 'n3',
        name: 'Pending',
        slug: 'pending',
        region: 'us-east-1',
        cloudAccountId: 'ca_1',
        stackStatus: 'pending',
      },
      { id: 'n4', name: 'Unknown', slug: 'unknown', region: 'us-east-1', cloudAccountId: 'ca_1' },
    ]

    it('offers only deployed networks in the chosen cloud account', async () => {
      respond({ networks })
      vi.mocked(select).mockResolvedValueOnce('n1')

      await expect(selectNetwork('ca_1')).resolves.toBe('n1')
      expect(choicesOfLastSelect()).toEqual([{ name: 'Main (us-east-1) — main', value: 'n1' }])
    })

    it('exits when there is no deployed network and none is not allowed', async () => {
      respond({ networks })

      await expect(selectNetwork('ca_9')).rejects.toThrow(ExitError)
      expect(printError).toHaveBeenCalledWith(
        'No active networks found for the selected cloud account.'
      )
    })

    it('offers None first and maps it to undefined', async () => {
      respond({ networks })
      vi.mocked(select).mockResolvedValueOnce('__none__')

      await expect(selectNetwork('ca_1', { allowNone: true })).resolves.toBeUndefined()
      expect(choicesOfLastSelect()[0]).toEqual({ name: 'None', value: '__none__' })
    })

    it('still offers None when no network matches', async () => {
      respond({ networks: [] })
      vi.mocked(select).mockResolvedValueOnce('__none__')

      await expect(selectNetwork('ca_1', { allowNone: true })).resolves.toBeUndefined()
      expect(choicesOfLastSelect()).toEqual([{ name: 'None', value: '__none__' }])
    })
  })

  describe('selectRegion', () => {
    it('asks for the provider’s regions, defaulting to aws', async () => {
      respond({ cloudRegions: [{ code: 'us-east-1', name: 'N. Virginia' }] })
      vi.mocked(select).mockResolvedValueOnce('us-east-1')

      await expect(selectRegion()).resolves.toBe('us-east-1')
      expect(vi.mocked(graphqlRequest).mock.calls[0][1]).toEqual({ provider: 'aws' })
      expect(choicesOfLastSelect()).toEqual([
        { name: 'us-east-1 — N. Virginia', value: 'us-east-1' },
      ])
    })

    it('passes an explicit provider through', async () => {
      respond({ cloudRegions: [{ code: 'us-central1', name: 'Iowa' }] })
      vi.mocked(select).mockResolvedValueOnce('us-central1')

      await selectRegion('gcp')

      expect(vi.mocked(graphqlRequest).mock.calls[0][1]).toEqual({ provider: 'gcp' })
    })

    it('exits when the provider has no regions', async () => {
      respond({ cloudRegions: [] })

      await expect(selectRegion('aws')).rejects.toThrow(ExitError)
      expect(printError).toHaveBeenCalledWith('No regions found.')
    })
  })

  describe('selectRegions', () => {
    let logSpy: MockInstance

    beforeEach(() => {
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    })

    afterEach(() => {
      logSpy.mockRestore()
    })

    it('pre-checks us-east-1 by default and does not warn when it is kept', async () => {
      vi.mocked(checkbox).mockResolvedValueOnce(['us-east-1', 'eu-west-1'])

      await expect(selectRegions()).resolves.toEqual(['us-east-1', 'eu-west-1'])
      const { choices } = vi.mocked(checkbox).mock.calls[0][0] as unknown as {
        choices: { value: string; checked: boolean }[]
      }
      expect(choices.filter((c) => c.checked).map((c) => c.value)).toEqual(['us-east-1'])
      expect(logSpy).not.toHaveBeenCalled()
    })

    it('pre-checks the given defaults and warns when us-east-1 is left out', async () => {
      vi.mocked(checkbox).mockResolvedValueOnce(['eu-west-1'])

      await selectRegions(['eu-west-1'])

      const { choices } = vi.mocked(checkbox).mock.calls[0][0] as unknown as {
        choices: { value: string; checked: boolean }[]
      }
      expect(choices.filter((c) => c.checked).map((c) => c.value)).toEqual(['eu-west-1'])
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('us-east-1'))
    })
  })

  describe('selectProject', () => {
    it('offers each project by name and slug', async () => {
      respond({ projects: [{ id: 'p1', name: 'Shop', slug: 'shop' }] })
      vi.mocked(select).mockResolvedValueOnce('p1')

      await expect(selectProject()).resolves.toBe('p1')
      expect(choicesOfLastSelect()).toEqual([{ name: 'Shop — shop', value: 'p1' }])
    })

    it('exits when there are no projects', async () => {
      respond({ projects: [] })

      await expect(selectProject()).rejects.toThrow(ExitError)
      expect(printError).toHaveBeenCalledWith('No projects found.')
    })
  })

  describe('selectEnvironment', () => {
    it('scopes to the project and marks production', async () => {
      respond({
        environments: [
          { id: 'e1', name: 'production', projectId: 'p1', isProduction: true },
          { id: 'e2', name: 'staging', projectId: 'p1', isProduction: false },
        ],
      })
      vi.mocked(select).mockResolvedValueOnce('e2')

      await expect(selectEnvironment('p1')).resolves.toBe('e2')
      expect(vi.mocked(graphqlRequest).mock.calls[0][1]).toEqual({ projectId: 'p1' })
      expect(choicesOfLastSelect()).toEqual([
        { name: 'production (production)', value: 'e1' },
        { name: 'staging', value: 'e2' },
      ])
    })

    it('exits when the project has no environments', async () => {
      respond({ environments: [] })

      await expect(selectEnvironment('p1')).rejects.toThrow(ExitError)
      expect(printError).toHaveBeenCalledWith('No environments found for the selected project.')
    })
  })

  describe('selectSecret', () => {
    it('filters by cloud account and shows descriptions when present', async () => {
      respond({
        secrets: [
          { id: 's1', name: 'DB_URL', description: 'Primary DB', cloudAccountId: 'ca_1' },
          { id: 's2', name: 'API_KEY', cloudAccountId: 'ca_1' },
        ],
      })
      vi.mocked(select).mockResolvedValueOnce('s1')

      await expect(selectSecret('ca_1')).resolves.toBe('s1')
      expect(vi.mocked(graphqlRequest).mock.calls[0][1]).toEqual({ cloudAccountId: 'ca_1' })
      expect(choicesOfLastSelect()).toEqual([
        { name: 'DB_URL — Primary DB', value: 's1' },
        { name: 'API_KEY', value: 's2' },
      ])
    })

    it('sends no filter without a cloud account', async () => {
      respond({ secrets: [{ id: 's1', name: 'X', cloudAccountId: 'ca_1' }] })
      vi.mocked(select).mockResolvedValueOnce('s1')

      await selectSecret()

      expect(vi.mocked(graphqlRequest).mock.calls[0][1]).toEqual({})
    })

    it('exits when there are no secrets', async () => {
      respond({ secrets: [] })

      await expect(selectSecret()).rejects.toThrow(ExitError)
      expect(printError).toHaveBeenCalledWith('No secrets found.')
    })
  })

  describe('selectDomain', () => {
    it('returns the chosen domain’s id and name', async () => {
      respond({
        domains: [
          { id: 'd1', name: 'example.com' },
          { id: 'd2', name: 'example.org' },
        ],
      })
      vi.mocked(select).mockResolvedValueOnce('d2')

      await expect(selectDomain()).resolves.toEqual({ id: 'd2', name: 'example.org' })
    })

    it('exits when there are no domains', async () => {
      respond({ domains: [] })

      await expect(selectDomain()).rejects.toThrow(ExitError)
      expect(printError).toHaveBeenCalledWith('No domains found.')
    })

    it('exits when the selection does not match a listed domain', async () => {
      respond({ domains: [{ id: 'd1', name: 'example.com' }] })
      vi.mocked(select).mockResolvedValueOnce('d9')

      await expect(selectDomain()).rejects.toThrow(ExitError)
    })
  })

  describe('promptName', () => {
    it('labels the prompt with the resource and requires a non-blank name', async () => {
      vi.mocked(input).mockResolvedValueOnce('web')

      await expect(promptName('Network')).resolves.toBe('web')
      const config = vi.mocked(input).mock.calls[0][0] as {
        message: string
        validate: (value: string) => boolean | string
      }
      expect(config.message).toBe('Network name:')
      expect(config.validate('  ')).toBe('Name is required')
      expect(config.validate('web')).toBe(true)
    })
  })
})
