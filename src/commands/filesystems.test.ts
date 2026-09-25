import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

const graphqlRequest = vi.hoisted(() => vi.fn())
const input = vi.hoisted(() => vi.fn())
const select = vi.hoisted(() => vi.fn())
const selectCloud = vi.hoisted(() => vi.fn())
const selectNetwork = vi.hoisted(() => vi.fn())
const spinner = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }))

vi.mock('@inquirer/prompts', () => ({ input, select }))
vi.mock('ora', () => ({ default: () => spinner }))
vi.mock('../lib/client', () => ({
  formatApiError: (error: unknown) => (error instanceof Error ? error.message : 'API error'),
  graphqlRequest,
}))
vi.mock('../lib/interactive-prompts', () => ({ selectCloud, selectNetwork }))

const { registerFilesystemsCommand } = await import('./filesystems')

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

async function run(args: string[]): Promise<void> {
  const program = new Command()
  registerFilesystemsCommand(program)
  await program.parseAsync(['node', 'gantry', 'filesystems', ...args])
}

const networks = {
  networks: [
    { id: 'net_other', name: 'Other', region: 'us-west-2', cloudAccountId: 'cloud_1' },
    { id: 'h4nw8r', name: 'Production VPC', region: 'us-east-1', cloudAccountId: 'cloud_1' },
  ],
}

const created = {
  success: true,
  filesystem: {
    id: 'f7kd2x',
    name: 'Uploads',
    slug: 'uploads',
    type: 'EFS',
    status: 'PENDING',
  },
}

describe('filesystems command', () => {
  let logSpy: MockInstance
  let errorSpy: MockInstance

  beforeEach(() => {
    vi.clearAllMocks()
    spinner.start.mockReturnValue(spinner)
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

  function answerModes(): void {
    select
      .mockResolvedValueOnce('maxIO')
      .mockResolvedValueOnce('provisioned')
      .mockResolvedValueOnce(false)
  }

  describe('list', () => {
    it('prints filesystems with uppercased type and status', async () => {
      graphqlRequest.mockResolvedValueOnce({
        filesystems: [
          {
            id: 'f7kd2x',
            name: 'Uploads\x1b]0;pwned\x07',
            slug: 'uploads',
            type: 'efs',
            status: 'active',
            cloudAccountId: 'cloud_1',
            networkId: 'h4nw8r',
            createdAt: '2026-05-05T12:00:00Z',
          },
        ],
      })

      await run(['list'])

      expect(String(graphqlRequest.mock.calls[0]?.[0])).toContain('query GetFilesystems')
      expect(printed()).toContain('f7kd2x')
      expect(printed()).toContain('EFS')
      expect(printed()).toContain('ACTIVE')
      expect(printed()).toContain('May 5, 2026')
      expect(printed()).not.toContain('pwned')
    })

    it('reports when there are no filesystems', async () => {
      graphqlRequest.mockResolvedValueOnce({ filesystems: [] })

      await run(['list'])

      expect(printed()).toBe('No filesystems found.')
    })

    it('prints the API error and exits non-zero', async () => {
      graphqlRequest.mockRejectedValueOnce(new Error('Unauthorized'))

      await expect(run(['list'])).rejects.toThrow('process.exit(1)')

      expect(printedErrors()).toContain('Unauthorized')
    })
  })

  describe('create', () => {
    it('creates an EFS filesystem in the network region from flags and prompts', async () => {
      graphqlRequest
        .mockResolvedValueOnce(networks)
        .mockResolvedValueOnce({ createFilesystem: created })
      answerModes()

      await run([
        'create',
        '--cloud',
        'cloud_1',
        '--network',
        'h4nw8r',
        '--name',
        'Uploads',
        '--slug',
        'up',
      ])

      expect(selectCloud).not.toHaveBeenCalled()
      expect(selectNetwork).not.toHaveBeenCalled()
      expect(input).not.toHaveBeenCalled()
      expect(String(graphqlRequest.mock.calls[0]?.[0])).toContain('query GetFilesystemNetworks')
      expect(String(graphqlRequest.mock.calls[1]?.[0])).toContain('mutation CreateFilesystem')
      expect(graphqlRequest.mock.calls[1]?.[1]).toEqual({
        input: {
          cloudAccountId: 'cloud_1',
          networkId: 'h4nw8r',
          name: 'Uploads',
          slug: 'up',
          type: 'EFS',
          providerData: {
            region: 'us-east-1',
            performanceMode: 'maxIO',
            throughputMode: 'provisioned',
            encrypted: false,
          },
        },
      })
      expect(spinner.stop).toHaveBeenCalled()
      expect(printed()).toContain('Filesystem created: Uploads (uploads)')
      expect(printed()).toContain('ID: f7kd2x')
    })

    it('selects the cloud and network and derives the slug from a prompted name', async () => {
      selectCloud.mockResolvedValueOnce('cloud_1')
      selectNetwork.mockResolvedValueOnce('h4nw8r')
      input.mockResolvedValueOnce('Media Assets')
      graphqlRequest
        .mockResolvedValueOnce(networks)
        .mockResolvedValueOnce({ createFilesystem: created })
      select
        .mockResolvedValueOnce('generalPurpose')
        .mockResolvedValueOnce('elastic')
        .mockResolvedValueOnce(true)

      await run(['create'])

      expect(selectNetwork).toHaveBeenCalledWith('cloud_1')
      const { validate } = input.mock.calls[0]?.[0] as { validate: (v: string) => string | true }
      expect(validate('  ')).toBe('Name is required')
      expect(validate('x')).toBe(true)
      expect(graphqlRequest.mock.calls[1]?.[1]).toMatchObject({
        input: {
          slug: 'media-assets',
          providerData: {
            performanceMode: 'generalPurpose',
            throughputMode: 'elastic',
            encrypted: true,
          },
        },
      })
    })

    it('fails when no network is selected', async () => {
      selectNetwork.mockResolvedValueOnce(undefined)

      await expect(run(['create', '--cloud', 'cloud_1'])).rejects.toThrow('process.exit(1)')

      expect(printedErrors()).toContain('A network is required to create a filesystem.')
      expect(graphqlRequest).not.toHaveBeenCalled()
    })

    it('fails when the network does not exist', async () => {
      graphqlRequest.mockResolvedValueOnce(networks)

      await expect(
        run(['create', '--cloud', 'cloud_1', '--network', 'net_missing'])
      ).rejects.toThrow('process.exit(1)')

      expect(printedErrors()).toContain('Selected network not found.')
      expect(graphqlRequest).toHaveBeenCalledTimes(1)
    })

    it('strips terminal escapes from the returned ID', async () => {
      graphqlRequest.mockResolvedValueOnce(networks).mockResolvedValueOnce({
        createFilesystem: {
          ...created,
          filesystem: { ...created.filesystem, id: 'f7kd2x\x1b]0;pwned\x07' },
        },
      })
      answerModes()

      await run(['create', '--cloud', 'cloud_1', '--network', 'h4nw8r', '--name', 'Uploads'])

      expect(printed()).toContain('ID: f7kd2x')
      expect(printed()).not.toContain('pwned')
    })

    it('exits with the server message when creation fails', async () => {
      graphqlRequest.mockResolvedValueOnce(networks).mockResolvedValueOnce({
        createFilesystem: { success: false, message: 'EFS quota exceeded' },
      })
      answerModes()

      await expect(
        run(['create', '--cloud', 'cloud_1', '--network', 'h4nw8r', '--name', 'Uploads'])
      ).rejects.toThrow('process.exit(1)')

      expect(printedErrors()).toContain('EFS quota exceeded')
    })

    it('falls back to a generic message when no filesystem is returned', async () => {
      graphqlRequest
        .mockResolvedValueOnce(networks)
        .mockResolvedValueOnce({ createFilesystem: { success: true } })
      answerModes()

      await expect(
        run(['create', '--cloud', 'cloud_1', '--network', 'h4nw8r', '--name', 'Uploads'])
      ).rejects.toThrow(ExitError)

      expect(printedErrors()).toContain('There was an error while creating the filesystem.')
    })

    it('stops the spinner before printing an API error', async () => {
      graphqlRequest.mockResolvedValueOnce(networks).mockRejectedValueOnce(new Error('Throttled'))
      answerModes()

      await expect(
        run(['create', '--cloud', 'cloud_1', '--network', 'h4nw8r', '--name', 'Uploads'])
      ).rejects.toThrow('process.exit(1)')

      expect(spinner.stop).toHaveBeenCalled()
      expect(spinner.stop.mock.invocationCallOrder[0]).toBeLessThan(
        errorSpy.mock.invocationCallOrder[0] ?? 0
      )
      expect(printedErrors()).toContain('Throttled')
    })
  })
})
