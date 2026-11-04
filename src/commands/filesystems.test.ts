import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

const graphqlRequest = vi.hoisted(() => vi.fn())
const input = vi.hoisted(() => vi.fn())
const select = vi.hoisted(() => vi.fn())
const resolveCloud = vi.hoisted(() =>
  vi.fn((id?: string) => Promise.resolve({ id: id ?? 'cloud_1', provider: 'AWS' }))
)
const selectNetwork = vi.hoisted(() => vi.fn())
const spinner = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }))
const isInteractive = vi.hoisted(() => vi.fn(() => true))

vi.mock('@inquirer/prompts', () => ({ input, select }))
vi.mock('ora', () => ({ default: () => spinner }))
vi.mock('../lib/terminal', () => ({ isInteractive }))
vi.mock('../lib/client', () => ({
  formatApiError: (error: unknown) => (error instanceof Error ? error.message : 'API error'),
  graphqlRequest,
}))
vi.mock('../lib/interactive-prompts', () => ({ resolveCloud, selectNetwork }))

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
    {
      id: 'net_other',
      name: 'Other',
      region: 'us-west-2',
      provider: 'aws',
      cloudAccountId: 'cloud_1',
    },
    {
      id: 'q8vm3t',
      name: 'Edge VPC',
      region: 'us-central1',
      provider: 'gcp',
      cloudAccountId: 'cloud_2',
    },
    {
      id: 'h4nw8r',
      name: 'Production VPC',
      region: 'us-east-1',
      provider: 'aws',
      cloudAccountId: 'cloud_1',
    },
  ],
}

const created = {
  success: true,
  filesystem: {
    id: 'f7kd2x',
    name: 'Uploads',
    slug: 'uploads',
    provider: 'aws',
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
      .mockResolvedValueOnce('MAX_IO')
      .mockResolvedValueOnce('PROVISIONED')
      .mockResolvedValueOnce(false)
    input.mockResolvedValueOnce('256')
  }

  describe('list', () => {
    it('prints filesystems with their cloud, region and uppercased status', async () => {
      graphqlRequest.mockResolvedValueOnce({
        filesystems: [
          {
            id: 'f7kd2x',
            name: 'Uploads\x1b]0;pwned\x07',
            slug: 'uploads',
            provider: 'aws',
            region: 'eu-west-1',
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
      expect(printed()).toContain('AWS')
      expect(printed()).toContain('eu-west-1')
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
    it('creates a filesystem with the AWS settings from flags and prompts', async () => {
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

      expect(resolveCloud).toHaveBeenCalledWith(expect.any(String))
      expect(selectNetwork).not.toHaveBeenCalled()
      expect(input).toHaveBeenCalledTimes(1)
      expect(input.mock.calls[0]?.[0]).toMatchObject({
        message: 'Provisioned throughput (MiB/s):',
      })
      expect(String(graphqlRequest.mock.calls[0]?.[0])).toContain('query GetFilesystemNetworks')
      expect(String(graphqlRequest.mock.calls[1]?.[0])).toContain('mutation CreateFilesystem')
      expect(graphqlRequest.mock.calls[1]?.[1]).toEqual({
        input: {
          cloudAccountId: 'cloud_1',
          networkId: 'h4nw8r',
          name: 'Uploads',
          slug: 'up',
          aws: {
            performanceMode: 'MAX_IO',
            throughputMode: 'PROVISIONED',
            provisionedThroughputMibps: 256,
            encrypted: false,
          },
        },
      })
      expect(spinner.stop).toHaveBeenCalled()
      expect(printed()).toContain('Filesystem created: Uploads (uploads)')
      expect(printed()).toContain('ID: f7kd2x')
    })

    it('selects the cloud and network and derives the slug from a prompted name', async () => {
      resolveCloud.mockResolvedValueOnce({ id: 'cloud_1', provider: 'AWS' })
      selectNetwork.mockResolvedValueOnce('h4nw8r')
      input.mockResolvedValueOnce('Media Assets')
      graphqlRequest
        .mockResolvedValueOnce(networks)
        .mockResolvedValueOnce({ createFilesystem: created })
      select
        .mockResolvedValueOnce('GENERAL_PURPOSE')
        .mockResolvedValueOnce('ELASTIC')
        .mockResolvedValueOnce(true)

      await run(['create'])

      expect(selectNetwork).toHaveBeenCalledWith('cloud_1')
      const { validate } = input.mock.calls[0]?.[0] as { validate: (v: string) => string | true }
      expect(validate('  ')).toBe('Name is required')
      expect(validate('x')).toBe(true)
      expect(graphqlRequest.mock.calls[1]?.[1]).toMatchObject({
        input: {
          slug: 'media-assets',
          aws: {
            performanceMode: 'GENERAL_PURPOSE',
            throughputMode: 'ELASTIC',
            encrypted: true,
          },
        },
      })
    })

    it('offers no elastic throughput with Max I/O and checks the throughput range', async () => {
      graphqlRequest
        .mockResolvedValueOnce(networks)
        .mockResolvedValueOnce({ createFilesystem: created })
      answerModes()

      await run(['create', '--cloud', 'cloud_1', '--network', 'h4nw8r', '--name', 'Uploads'])

      const { choices } = select.mock.calls[1]?.[0] as { choices: { value: string }[] }
      expect(choices.map((choice) => choice.value)).toEqual(['BURSTING', 'PROVISIONED'])
      const { validate } = input.mock.calls[0]?.[0] as { validate: (v: string) => string | true }
      expect(validate('0')).toBe('Enter a whole number from 1 to 3414')
      expect(validate('12.5')).toBe('Enter a whole number from 1 to 3414')
      expect(validate('3414')).toBe(true)
    })

    it('refuses a cloud without filesystems before asking anything', async () => {
      resolveCloud.mockResolvedValueOnce({ id: 'cloud_2', provider: 'GCP' })

      await expect(
        run(['create', '--cloud', 'cloud_2', '--network', 'q8vm3t', '--name', 'Uploads'])
      ).rejects.toThrow(ExitError)

      expect(printedErrors()).toContain("This cloud doesn't support filesystems yet.")
      expect(select).not.toHaveBeenCalled()
      expect(graphqlRequest).not.toHaveBeenCalled()
    })

    it('takes every AWS setting from flags without a terminal', async () => {
      isInteractive.mockReturnValue(false)
      graphqlRequest
        .mockResolvedValueOnce(networks)
        .mockResolvedValueOnce({ createFilesystem: created })

      await run([
        'create',
        '--cloud',
        'cloud_1',
        '--network',
        'h4nw8r',
        '--name',
        'Uploads',
        '--aws-performance-mode',
        'general-purpose',
        '--aws-throughput-mode',
        'provisioned',
        '--aws-throughput-mibps',
        '512',
        '--aws-encrypted',
      ])

      expect(select).not.toHaveBeenCalled()
      expect(input).not.toHaveBeenCalled()
      expect(graphqlRequest.mock.calls[1]?.[1]).toMatchObject({
        input: {
          aws: {
            performanceMode: 'GENERAL_PURPOSE',
            throughputMode: 'PROVISIONED',
            provisionedThroughputMibps: 512,
            encrypted: true,
          },
        },
      })
      isInteractive.mockReturnValue(true)
    })

    it.each([
      [
        ['--aws-performance-mode', 'turbo'],
        '--aws-performance-mode must be general-purpose or max-io',
      ],
      [
        ['--aws-performance-mode', 'max-io', '--aws-throughput-mode', 'elastic'],
        'Elastic throughput is not available with max-io performance.',
      ],
      [
        ['--aws-throughput-mode', 'bursting', '--aws-throughput-mibps', '128'],
        '--aws-throughput-mibps needs --aws-throughput-mode provisioned',
      ],
      [
        ['--aws-throughput-mode', 'provisioned', '--aws-throughput-mibps', '5000'],
        '--aws-throughput-mibps must be a whole number from 1 to 3414',
      ],
    ])('refuses %j before creating anything', async (flags, message) => {
      graphqlRequest.mockResolvedValueOnce(networks)

      await expect(
        run(['create', '--cloud', 'cloud_1', '--network', 'h4nw8r', '--name', 'Uploads', ...flags])
      ).rejects.toThrow(ExitError)

      expect(printedErrors()).toContain(message)
      expect(graphqlRequest).toHaveBeenCalledTimes(1)
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
