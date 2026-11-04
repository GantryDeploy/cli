import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

const graphqlRequest = vi.hoisted(() => vi.fn())
const spinner = vi.hoisted(() => ({
  fail: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  succeed: vi.fn(),
}))
const promptMocks = vi.hoisted(() => ({ confirm: vi.fn(), input: vi.fn(), select: vi.fn() }))
const isInteractive = vi.hoisted(() => vi.fn())
const bastionMocks = vi.hoisted(() => ({
  activeOnly: vi.fn(),
  createBastionInteractive: vi.fn(),
  fetchBastionCredentials: vi.fn(),
  selectBastion: vi.fn(),
}))
const tunnelMocks = vi.hoisted(() => ({ openDirectTunnel: vi.fn(), openSshTunnel: vi.fn() }))
const cloudMocks = vi.hoisted(() => ({
  resolveCloud: vi.fn((id?: string) => Promise.resolve({ id: id ?? 'cloud_1', provider: 'AWS' })),
  selectNetwork: vi.fn(),
}))

vi.mock('ora', () => ({ default: () => ({ ...spinner, start: () => spinner }) }))
vi.mock('@inquirer/prompts', () => promptMocks)
vi.mock('../lib/client', () => ({
  formatApiError: (error: unknown) => (error instanceof Error ? error.message : 'API error'),
  graphqlRequest,
}))
vi.mock('../lib/bastion-prompts', () => bastionMocks)
vi.mock('../lib/interactive-prompts', () => cloudMocks)
vi.mock('../lib/ssh-tunnel', () => tunnelMocks)
vi.mock('../lib/terminal', () => ({ isInteractive }))

const { registerDatabasesCommand } = await import('./databases')

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

const database = {
  id: 'db-id-1',
  name: 'Primary',
  slug: 'primary',
  engine: 'POSTGRESQL',
  status: 'ACTIVE',
  cloudAccountId: 'cloud-1',
  networkId: 'h4nw8r',
  endpoint: 'primary.example.internal:5432',
  port: 5432,
  createdAt: '2026-01-01T00:00:00Z',
}

const publicDatabase = {
  ...database,
  id: 'db-id-2',
  name: 'Reporting',
  slug: 'reporting',
  engine: 'MYSQL',
  endpoint: 'reporting.abc123.us-east-1.rds.amazonaws.com:3306',
  port: 3306,
  publiclyAccessible: true,
}

const credentials = {
  databaseCredentials: { success: true, username: 'gantry_admin', password: 'Zq8#v2Lm!' },
}

const bastion = {
  bastion: { id: 'r3bq9m', publicIp: '203.0.113.10' },
}

async function run(args: string[]): Promise<void> {
  const program = new Command()
  program.exitOverride()
  registerDatabasesCommand(program)
  await program.parseAsync(['node', 'gantry', 'databases', ...args])
}

function sentQuery(call: number): string {
  return String(graphqlRequest.mock.calls[call]?.[0])
}

function sentVariables(call: number): unknown {
  return graphqlRequest.mock.calls[call]?.[1]
}

describe('databases command', () => {
  let errorSpy: MockInstance
  let logSpy: MockInstance

  const logLines = () => logSpy.mock.calls.map((c) => c.map(String).join(' '))
  const logOutput = () => logLines().join('\n')
  const errorOutput = () => errorSpy.mock.calls.flat().join(' ')

  beforeEach(() => {
    vi.resetAllMocks()
    cloudMocks.resolveCloud.mockImplementation((id?: string) =>
      Promise.resolve({ id: id ?? 'cloud_1', provider: 'AWS' })
    )
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
    it('prints a row per database with an upper-cased status', async () => {
      graphqlRequest.mockResolvedValueOnce({
        databases: [database, { ...publicDatabase, status: 'pending' }],
      })

      await run(['list'])

      expect(sentQuery(0)).toContain('query GetDatabases')
      const output = logOutput()
      expect(output).toContain('primary')
      expect(output).toContain('POSTGRESQL')
      expect(output).toContain('reporting')
      expect(output).toContain('PENDING')
      expect(output).toContain('ACTIVE')
    })

    it('says so when there are no databases', async () => {
      graphqlRequest.mockResolvedValueOnce({ databases: [] })

      await run(['list'])

      expect(logSpy).toHaveBeenCalledWith('No databases found.')
    })

    it('exits non-zero when the API fails', async () => {
      graphqlRequest.mockRejectedValueOnce(new Error('Unauthorized'))

      await expect(run(['list'])).rejects.toThrow('process.exit(1)')

      expect(errorOutput()).toContain('Unauthorized')
    })
  })

  describe('engines', () => {
    const types = {
      databaseTypes: [
        {
          engine: 'POSTGRESQL',
          displayName: 'Aurora PostgreSQL',
          description: 'Managed Aurora',
          supportsServerless: true,
          providerData: { provider: 'aws', flavor: 'aurora' },
        },
        {
          engine: 'MYSQL',
          displayName: 'MySQL',
          description: 'RDS MySQL',
          supportsServerless: false,
          providerData: { provider: 'aws', flavor: 'rds' },
        },
      ],
    }

    it("lists each of the cloud's engines with the AWS service and serverless support", async () => {
      graphqlRequest.mockResolvedValueOnce(types)

      await run(['engines', '--cloud', 'cloud-1'])

      expect(sentVariables(0)).toEqual({ provider: 'AWS' })
      const output = logOutput()
      expect(output).toContain('Aurora PostgreSQL')
      expect(output).toContain('aurora')
      expect(output).toContain('Yes')
      expect(output).toContain('No')
    })

    it('shows only the shared columns for another cloud', async () => {
      cloudMocks.resolveCloud.mockResolvedValueOnce({ id: 'ca_9mx4', provider: 'GCP' })
      graphqlRequest.mockResolvedValueOnce(types)

      await run(['engines', '--cloud', 'ca_9mx4'])

      expect(logOutput()).not.toContain('AWS Service')
      expect(logOutput()).not.toContain('Serverless')
    })

    it('says when the cloud has no database engines', async () => {
      graphqlRequest.mockResolvedValueOnce({ databaseTypes: [] })

      await run(['engines', '--cloud', 'cloud-1'])

      expect(logLines()).toEqual(["This cloud doesn't support databases yet."])
    })

    it('exits non-zero when the API fails', async () => {
      graphqlRequest.mockRejectedValueOnce(new Error('boom'))

      await expect(run(['engines', '--cloud', 'cloud-1'])).rejects.toThrow('process.exit(1)')
    })
  })

  describe('engine-versions', () => {
    it('sends the engine, region and AWS service and mode', async () => {
      graphqlRequest.mockResolvedValueOnce({
        databaseEngineVersions: [
          {
            engine: 'POSTGRESQL',
            version: '16.4',
            description: 'Aurora PostgreSQL 16.4',
            providerData: {
              provider: 'aws',
              flavor: 'aurora',
              parameterGroupFamily: 'aurora-postgresql16',
              deploymentModes: ['provisioned', 'serverless'],
            },
          },
        ],
      })

      await run([
        'engine-versions',
        '--cloud',
        'cloud-1',
        '--engine',
        'POSTGRESQL',
        '--aws-flavor',
        'aurora',
        '--region',
        'us-east-1',
        '--aws-mode',
        'serverless',
      ])

      expect(sentVariables(0)).toEqual({
        provider: 'AWS',
        engine: 'POSTGRESQL',
        region: 'us-east-1',
        aws: { flavor: 'aurora', deploymentMode: 'SERVERLESS' },
      })
      const output = logOutput()
      expect(output).toContain('16.4 (aurora-postgresql16)')
    })

    it('asks for the AWS service when filtering AWS databases by engine', async () => {
      await expect(
        run(['engine-versions', '--cloud', 'cloud-1', '--engine', 'mysql'])
      ).rejects.toThrow('process.exit(1)')

      expect(errorOutput()).toContain(
        'Pass --aws-flavor rds or aurora to filter AWS databases by engine.'
      )
      expect(graphqlRequest).not.toHaveBeenCalled()
    })

    it('refuses AWS filters on another cloud', async () => {
      cloudMocks.resolveCloud.mockResolvedValueOnce({ id: 'ca_9mx4', provider: 'GCP' })

      await expect(
        run(['engine-versions', '--cloud', 'ca_9mx4', '--aws-flavor', 'rds'])
      ).rejects.toThrow('process.exit(1)')

      expect(errorOutput()).toContain('--aws-flavor only applies to AWS cloud accounts.')
    })

    it('reports when nothing matches', async () => {
      graphqlRequest.mockResolvedValueOnce({ databaseEngineVersions: [] })

      await run(['engine-versions', '--cloud', 'cloud-1'])

      expect(sentVariables(0)).toEqual({ provider: 'AWS' })
      expect(logSpy).toHaveBeenCalledWith('No engine versions found matching the filters.')
    })

    it('exits non-zero when the API fails', async () => {
      graphqlRequest.mockRejectedValueOnce(new Error('boom'))

      await expect(run(['engine-versions', '--cloud', 'cloud-1'])).rejects.toThrow(
        'process.exit(1)'
      )
    })
  })

  describe('sizes', () => {
    it('sends the engine, region and AWS service and prints each size', async () => {
      graphqlRequest.mockResolvedValueOnce({
        databaseSizes: [{ size: 'db.t4g.medium', family: 't4g', vcpu: 2, memoryMb: 4096 }],
      })

      await run([
        'sizes',
        '--cloud',
        'cloud-1',
        '--engine',
        'postgres',
        '--aws-flavor',
        'rds',
        '--region',
        'eu-west-1',
      ])

      expect(sentVariables(0)).toEqual({
        provider: 'AWS',
        engine: 'POSTGRESQL',
        region: 'eu-west-1',
        aws: { flavor: 'rds' },
      })
      const output = logOutput()
      expect(output).toContain('db.t4g.medium')
      expect(output).toContain('4096')
    })

    it('reports when nothing matches', async () => {
      graphqlRequest.mockResolvedValueOnce({ databaseSizes: [] })

      await run(['sizes', '--cloud', 'cloud-1'])

      expect(logSpy).toHaveBeenCalledWith('No sizes found matching the filters.')
    })

    it('exits non-zero when the API fails', async () => {
      graphqlRequest.mockRejectedValueOnce(new Error('boom'))

      await expect(run(['sizes', '--cloud', 'cloud-1'])).rejects.toThrow('process.exit(1)')
    })
  })

  describe('create', () => {
    const createArgs = ['create', '--cloud', 'cloud-1', '--network', 'h4nw8r', '--name', 'Primary']
    const aws = (flavor: string) => ({ provider: 'aws', flavor })
    const offered = [
      {
        engine: 'POSTGRESQL',
        displayName: 'PostgreSQL',
        description: 'RDS PostgreSQL',
        supportsServerless: false,
        providerData: aws('rds'),
      },
      {
        engine: 'POSTGRESQL',
        displayName: 'Aurora PostgreSQL',
        description: 'Managed Aurora',
        supportsServerless: true,
        providerData: aws('aurora'),
      },
      {
        engine: 'MYSQL',
        displayName: 'MySQL',
        description: 'RDS MySQL',
        supportsServerless: false,
        providerData: aws('rds'),
      },
      {
        engine: 'MYSQL',
        displayName: 'Aurora MySQL',
        description: 'Aurora MySQL',
        supportsServerless: true,
        providerData: aws('aurora'),
      },
      {
        engine: 'MARIADB',
        displayName: 'MariaDB',
        description: 'RDS MariaDB',
        supportsServerless: false,
        providerData: aws('rds'),
      },
    ]

    it.each([
      [['--engine', 'postgres', '--aws-flavor', 'rds'], 'POSTGRESQL', 'rds'],
      [['--engine', 'POSTGRESQL', '--aws-flavor', 'aurora'], 'POSTGRESQL', 'aurora'],
      [['--engine', 'MARIADB'], 'MARIADB', 'rds'],
    ])('%j sends engine %s on %s', async (flags, engine, flavor) => {
      promptMocks.select.mockResolvedValueOnce(false)
      graphqlRequest
        .mockResolvedValueOnce({ databaseTypes: offered })
        .mockResolvedValueOnce({ databaseEngineVersions: [] })
        .mockResolvedValueOnce({ databaseSizes: [] })
        .mockResolvedValueOnce({ createDatabase: { success: true, database } })

      await run([...createArgs, ...flags])

      expect(sentVariables(0)).toEqual({ provider: 'AWS' })
      expect(sentVariables(1)).toMatchObject({ provider: 'AWS', engine, aws: { flavor } })
      expect(sentVariables(3)).toMatchObject({ input: { engine, aws: { flavor } } })
    })

    it('asks which AWS service runs an engine offered on more than one', async () => {
      promptMocks.select.mockResolvedValueOnce(offered[1]).mockResolvedValueOnce(false)
      graphqlRequest
        .mockResolvedValueOnce({ databaseTypes: offered })
        .mockResolvedValueOnce({ databaseEngineVersions: [] })
        .mockResolvedValueOnce({ databaseSizes: [] })
        .mockResolvedValueOnce({ createDatabase: { success: true, database } })

      await run([...createArgs, '--engine', 'postgres'])

      const { choices } = promptMocks.select.mock.calls[0]?.[0] as {
        choices: { name: string }[]
      }
      expect(choices.map((c) => c.name)).toEqual([
        'PostgreSQL — RDS PostgreSQL',
        'Aurora PostgreSQL — Managed Aurora',
      ])
      expect(sentVariables(3)).toMatchObject({ input: { aws: { flavor: 'aurora' } } })
    })

    it('uses every flag without prompting', async () => {
      graphqlRequest.mockResolvedValueOnce({ databaseTypes: offered }).mockResolvedValueOnce({
        createDatabase: { success: true, database, deploymentId: 'm2xa5q' },
      })

      await run([
        ...createArgs,
        '--slug',
        'main-db',
        '--engine',
        'postgresql',
        '--aws-flavor',
        'aurora',
        '--size',
        'db.r6g.large',
        '--engine-version',
        '16.4',
        '--aws-serverless',
      ])

      expect(graphqlRequest).toHaveBeenCalledTimes(2)
      expect(cloudMocks.resolveCloud).toHaveBeenCalledWith('cloud-1')
      expect(promptMocks.input).not.toHaveBeenCalled()
      expect(promptMocks.select).not.toHaveBeenCalled()
      expect(sentVariables(1)).toEqual({
        input: {
          cloudAccountId: 'cloud-1',
          networkId: 'h4nw8r',
          name: 'Primary',
          slug: 'main-db',
          engine: 'POSTGRESQL',
          engineVersion: '16.4',
          size: 'db.r6g.large',
          aws: { flavor: 'aurora', deploymentMode: 'SERVERLESS' },
        },
      })
      const output = logOutput()
      expect(output).toContain('Database created: Primary (primary)')
      expect(output).toContain('  ID: db-id-1')
      expect(output).toContain('  Deployment: m2xa5q')
    })

    it('sends storage as a shared setting', async () => {
      graphqlRequest
        .mockResolvedValueOnce({ databaseTypes: offered })
        .mockResolvedValueOnce({ createDatabase: { success: true, database } })

      await run([
        ...createArgs,
        '--engine',
        'mysql',
        '--aws-flavor',
        'rds',
        '--size',
        'db.t4g.micro',
        '--storage',
        '100',
        '--engine-version',
        '8.0.39',
      ])

      expect(sentVariables(1)).toMatchObject({
        input: { storageGb: 100, aws: { flavor: 'rds', deploymentMode: 'PROVISIONED' } },
      })
    })

    it('turns master password rotation off with --aws-no-master-rotation', async () => {
      graphqlRequest.mockResolvedValueOnce({ databaseTypes: offered }).mockResolvedValueOnce({
        createDatabase: { success: true, database, deploymentId: 'm2xa5q' },
      })

      await run([
        ...createArgs,
        '--engine',
        'postgresql',
        '--aws-flavor',
        'aurora',
        '--engine-version',
        '16.4',
        '--aws-serverless',
        '--aws-no-master-rotation',
      ])

      expect(sentVariables(1)).toMatchObject({
        input: { aws: { masterPasswordRotation: false } },
      })
    })

    it('prompts for everything when no flags are given', async () => {
      const aurora = offered[1]
      cloudMocks.resolveCloud.mockResolvedValueOnce({ id: 'cloud-9', provider: 'AWS' })
      cloudMocks.selectNetwork.mockResolvedValueOnce('x9mf3d')
      promptMocks.input.mockResolvedValueOnce('Orders DB')
      promptMocks.select
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce('16.4')
        .mockResolvedValueOnce('db.r6g.large')
      graphqlRequest
        .mockResolvedValueOnce({ databaseTypes: [aurora] })
        .mockResolvedValueOnce({
          databaseEngineVersions: [
            {
              engine: 'POSTGRESQL',
              version: '16.4',
              description: 'Aurora 16.4',
              providerData: { provider: 'aws', parameterGroupFamily: 'aurora-postgresql16' },
            },
          ],
        })
        .mockResolvedValueOnce({
          databaseSizes: [{ size: 'db.r6g.large', family: 'r6g', vcpu: 2, memoryMb: 16384 }],
        })
        .mockResolvedValueOnce({ createDatabase: { success: true, database } })

      await run(['create'])

      expect(cloudMocks.resolveCloud).toHaveBeenCalledWith(undefined)
      expect(cloudMocks.selectNetwork).toHaveBeenCalledWith('cloud-9')
      const nameValidate = (
        promptMocks.input.mock.calls[0]?.[0] as { validate: (v: string) => unknown }
      ).validate
      expect(nameValidate('  ')).toBe('Name is required')
      expect(nameValidate('Orders')).toBe(true)

      const selectChoices = (i: number) =>
        (promptMocks.select.mock.calls[i]?.[0] as { choices: { name: string; value: unknown }[] })
          .choices
      expect(selectChoices(1)).toEqual([
        { name: '16.4 (aurora-postgresql16) — Aurora 16.4', value: '16.4' },
      ])
      expect(selectChoices(2)).toEqual([
        { name: 'db.r6g.large — 2 vCPU, 16384 MB RAM', value: 'db.r6g.large' },
      ])
      expect(sentVariables(1)).toEqual({
        provider: 'AWS',
        engine: 'POSTGRESQL',
        aws: { flavor: 'aurora', deploymentMode: 'PROVISIONED' },
      })
      expect(sentVariables(2)).toEqual({
        provider: 'AWS',
        engine: 'POSTGRESQL',
        aws: { flavor: 'aurora' },
      })
      expect(sentVariables(3)).toEqual({
        input: {
          cloudAccountId: 'cloud-9',
          networkId: 'x9mf3d',
          name: 'Orders DB',
          slug: 'orders-db',
          engine: 'POSTGRESQL',
          engineVersion: '16.4',
          size: 'db.r6g.large',
          aws: { flavor: 'aurora', deploymentMode: 'PROVISIONED' },
        },
      })
    })

    it('skips the size when serverless is chosen interactively', async () => {
      promptMocks.select.mockResolvedValueOnce(true).mockResolvedValueOnce('3.08.0')
      graphqlRequest
        .mockResolvedValueOnce({ databaseTypes: offered })
        .mockResolvedValueOnce({
          databaseEngineVersions: [
            {
              engine: 'MYSQL',
              version: '3.08.0',
              description: 'Aurora MySQL 3.08',
              providerData: { provider: 'aws', parameterGroupFamily: 'aurora-mysql8.0' },
            },
          ],
        })
        .mockResolvedValueOnce({ createDatabase: { success: true, database } })

      await run([...createArgs, '--engine', 'mysql', '--aws-flavor', 'aurora'])

      expect(sentVariables(1)).toEqual({
        provider: 'AWS',
        engine: 'MYSQL',
        aws: { flavor: 'aurora', deploymentMode: 'SERVERLESS' },
      })
      expect(sentQuery(2)).toContain('mutation CreateDatabase')
      expect(sentVariables(2)).toMatchObject({
        input: {
          engine: 'MYSQL',
          engineVersion: '3.08.0',
          aws: { flavor: 'aurora', deploymentMode: 'SERVERLESS' },
        },
      })
    })

    it('derives the slug from the name when --slug is empty', async () => {
      graphqlRequest
        .mockResolvedValueOnce({ databaseTypes: offered })
        .mockResolvedValueOnce({ createDatabase: { success: true, database } })

      await run([
        ...createArgs,
        '--slug',
        '',
        '--engine',
        'mariadb',
        '--engine-version',
        '10.11',
        '--size',
        'db.t4g.micro',
      ])

      expect(sentVariables(1)).toMatchObject({ input: { slug: 'primary' } })
    })

    it('refuses an engine and service pair that is not offered', async () => {
      graphqlRequest.mockResolvedValueOnce({ databaseTypes: offered })

      await expect(
        run([...createArgs, '--engine', 'mariadb', '--aws-flavor', 'aurora'])
      ).rejects.toThrow('process.exit(1)')

      expect(graphqlRequest).toHaveBeenCalledTimes(1)
      expect(errorOutput()).toContain('That engine is not offered. See "gantry db engines".')
    })

    it('refuses a cloud with no database engines', async () => {
      cloudMocks.resolveCloud.mockResolvedValueOnce({ id: 'ca_9mx4', provider: 'GCP' })
      graphqlRequest.mockResolvedValueOnce({ databaseTypes: [] })

      await expect(run([...createArgs, '--engine', 'mysql'])).rejects.toThrow('process.exit(1)')

      expect(errorOutput()).toContain("This cloud doesn't support databases yet.")
      expect(graphqlRequest).toHaveBeenCalledTimes(1)
    })

    it('refuses AWS flags on another cloud', async () => {
      cloudMocks.resolveCloud.mockResolvedValueOnce({ id: 'ca_9mx4', provider: 'GCP' })

      await expect(run([...createArgs, '--aws-serverless'])).rejects.toThrow('process.exit(1)')

      expect(errorOutput()).toContain('--aws-serverless only applies to AWS cloud accounts.')
      expect(graphqlRequest).not.toHaveBeenCalled()
    })

    it.each(['sqlserver', 'valkey', 'aurora'])(
      'rejects the unknown --engine %j before calling the API',
      async (engine) => {
        await expect(run([...createArgs, '--engine', engine])).rejects.toThrow('process.exit(1)')

        expect(graphqlRequest).not.toHaveBeenCalled()
        expect(errorOutput()).toContain(
          'Unknown database engine. Supported engines: mariadb, mysql, postgresql'
        )
      }
    )

    it('rejects an unknown --aws-flavor before calling the API', async () => {
      await expect(
        run([...createArgs, '--engine', 'mysql', '--aws-flavor', 'docdb'])
      ).rejects.toThrow('process.exit(1)')

      expect(graphqlRequest).not.toHaveBeenCalled()
      expect(errorOutput()).toContain('Unknown AWS database service. Use rds or aurora.')
    })

    it('fails without creating anything when no network is selected', async () => {
      cloudMocks.selectNetwork.mockResolvedValueOnce(undefined)
      graphqlRequest.mockResolvedValueOnce({ databaseTypes: offered })

      await expect(
        run(['create', '--cloud', 'cloud-1', '--name', 'Primary', '--engine', 'mariadb'])
      ).rejects.toThrow('process.exit(1)')

      expect(cloudMocks.selectNetwork).toHaveBeenCalledWith('cloud-1')
      expect(errorOutput()).toContain('A network is required to create a database.')
      expect(promptMocks.input).not.toHaveBeenCalled()
      expect(graphqlRequest).toHaveBeenCalledTimes(1)
    })

    it.each([
      [
        { success: false, message: 'Network has no private subnets' },
        'Network has no private subnets',
      ],
      [{ success: false }, 'Failed to create database'],
      [{ success: true }, 'Failed to create database'],
    ])('fails when the mutation result is %j', async (createDatabase, message) => {
      graphqlRequest
        .mockResolvedValueOnce({ databaseTypes: offered })
        .mockResolvedValueOnce({ createDatabase })

      await expect(
        run([
          ...createArgs,
          '--engine',
          'mariadb',
          '--engine-version',
          '10.11',
          '--size',
          'db.t4g.micro',
        ])
      ).rejects.toThrow('process.exit(1)')

      expect(errorOutput()).toContain(message)
    })
  })

  describe('users', () => {
    it('lists each service user on the server', async () => {
      graphqlRequest.mockResolvedValueOnce({ databases: [database] }).mockResolvedValueOnce({
        databaseServiceUsers: [
          {
            databaseName: 'wordpress',
            username: 'g_web_3f9a0c1e',
            auth: 'password',
            access: 'admin',
            status: 'active',
            serviceName: 'web',
            environmentSlug: 'production',
          },
        ],
      })

      await run(['users', 'primary'])

      expect(sentQuery(1)).toContain('query GetDatabaseServiceUsers($id: String!)')
      expect(sentVariables(1)).toEqual({ id: 'db-id-1' })
      expect(logOutput()).toContain('g_web_3f9a0c1e')
      expect(logOutput()).toContain('production')
    })

    it('says so when Gantry created no users on the server', async () => {
      graphqlRequest
        .mockResolvedValueOnce({ databases: [database] })
        .mockResolvedValueOnce({ databaseServiceUsers: [] })

      await run(['users', 'primary'])

      expect(logLines()).toEqual(['No service database users on this server.'])
    })
  })

  describe('adopt', () => {
    const started = {
      adoptDatabase: {
        success: true,
        message: 'Database adopt started.',
        deploymentId: 'dep_4kq8zt',
      },
    }

    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    async function runToEnd(args: string[]): Promise<void> {
      const outcome = run(args).then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error : new Error(String(error)))
      )
      await vi.advanceTimersByTimeAsync(2000)
      const error = await outcome
      if (error) throw error
    }

    it('adopts with --yes and reports the finished operation', async () => {
      graphqlRequest
        .mockResolvedValueOnce({ databases: [database] })
        .mockResolvedValueOnce(started)
        .mockResolvedValueOnce({
          deployment: { status: 'COMPLETE', lastMessage: 'Database "wordpress" adopted.' },
        })

      await runToEnd(['adopt', 'primary', 'wordpress', '--yes'])

      expect(sentQuery(1)).toContain('mutation AdoptDatabase($id: String!, $database: String!)')
      expect(sentVariables(1)).toEqual({ id: 'db-id-1', database: 'wordpress' })
      expect(sentVariables(2)).toEqual({ id: 'dep_4kq8zt' })
      expect(spinner.succeed).toHaveBeenCalledWith('Database "wordpress" adopted.')
      expect(promptMocks.confirm).not.toHaveBeenCalled()
    })

    it('exits with the operation message when the adopt fails', async () => {
      graphqlRequest
        .mockResolvedValueOnce({ databases: [database] })
        .mockResolvedValueOnce(started)
        .mockResolvedValueOnce({
          deployment: {
            status: 'FAILED',
            lastMessage: 'There was an error while updating the database.',
          },
        })

      await expect(runToEnd(['adopt', 'primary', 'wordpress', '--yes'])).rejects.toThrow(
        'process.exit(1)'
      )
      expect(spinner.fail).toHaveBeenCalledWith('There was an error while updating the database.')
    })

    it('asks before adopting and stops when declined', async () => {
      isInteractive.mockReturnValue(true)
      promptMocks.confirm.mockResolvedValue(false)
      graphqlRequest.mockResolvedValueOnce({ databases: [database] })

      await run(['adopt', 'primary', 'wordpress'])

      expect(logOutput()).toContain('becomes a member of that role')
      expect(logLines()).toContain('Adopt cancelled.')
      expect(graphqlRequest).toHaveBeenCalledTimes(1)
    })

    it('refuses to adopt without --yes when it cannot ask', async () => {
      isInteractive.mockReturnValue(false)
      graphqlRequest.mockResolvedValueOnce({ databases: [database] })

      await expect(run(['adopt', 'primary', 'wordpress'])).rejects.toThrow('process.exit(1)')

      expect(errorOutput()).toContain('Re-run with --yes to confirm.')
      expect(graphqlRequest).toHaveBeenCalledTimes(1)
    })
  })

  describe('rotate-user', () => {
    const serviceUsers = {
      databaseServiceUsers: [
        {
          id: 'sdb_7k2m9q',
          databaseName: 'wordpress',
          username: 'g_web_3f9a0c1e',
          auth: 'password',
          access: 'admin',
          status: 'active',
          serviceName: 'web',
          environmentSlug: 'production',
        },
      ],
    }
    const started = {
      rotateDatabaseServiceUser: {
        success: true,
        message: 'Database user rotation started.',
        deploymentId: 'dep_7tq4wx',
      },
    }

    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    async function runToEnd(args: string[]): Promise<void> {
      const outcome = run(args).then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error : new Error(String(error)))
      )
      await vi.advanceTimersByTimeAsync(2000)
      const error = await outcome
      if (error) throw error
    }

    it('rotates the named user with --yes and reports what to do next', async () => {
      const done =
        'New database user "g_web_3f9a0c1e_b" is ready. Deploy web in production to switch to it. "g_web_3f9a0c1e" keeps working until no live version uses it.'
      graphqlRequest
        .mockResolvedValueOnce({ databases: [database] })
        .mockResolvedValueOnce(serviceUsers)
        .mockResolvedValueOnce(started)
        .mockResolvedValueOnce({ deployment: { status: 'COMPLETE', lastMessage: done } })

      await runToEnd(['rotate-user', 'primary', 'g_web_3f9a0c1e', '--yes'])

      expect(sentQuery(2)).toContain(
        'rotateDatabaseServiceUser(id: $id, serviceUserId: $serviceUserId, mode: $mode)'
      )
      expect(sentVariables(2)).toEqual({ id: 'db-id-1', serviceUserId: 'sdb_7k2m9q' })
      expect(sentVariables(3)).toEqual({ id: 'dep_7tq4wx' })
      expect(spinner.succeed).toHaveBeenCalledWith(done)
    })

    it('rotates in place with --in-place, even on a plan with Advanced Deployments', async () => {
      graphqlRequest
        .mockResolvedValueOnce({ databases: [database] })
        .mockResolvedValueOnce(serviceUsers)
        .mockResolvedValueOnce(started)
        .mockResolvedValueOnce({ deployment: { status: 'COMPLETE', lastMessage: 'rotated' } })

      await runToEnd(['rotate-user', 'primary', 'g_web_3f9a0c1e', '--in-place', '--yes'])

      expect(sentVariables(2)).toEqual({
        id: 'db-id-1',
        serviceUserId: 'sdb_7k2m9q',
        mode: 'IN_PLACE',
      })
    })

    it('asks for a staged rotation with --staged', async () => {
      graphqlRequest
        .mockResolvedValueOnce({ databases: [database] })
        .mockResolvedValueOnce(serviceUsers)
        .mockResolvedValueOnce(started)
        .mockResolvedValueOnce({ deployment: { status: 'COMPLETE', lastMessage: 'staged' } })

      await runToEnd(['rotate-user', 'primary', 'g_web_3f9a0c1e', '--staged', '--yes'])

      expect(sentVariables(2)).toEqual({
        id: 'db-id-1',
        serviceUserId: 'sdb_7k2m9q',
        mode: 'STAGED',
      })
    })

    it('refuses both --in-place and --staged', async () => {
      await expect(
        run(['rotate-user', 'primary', 'g_web_3f9a0c1e', '--in-place', '--staged', '--yes'])
      ).rejects.toThrow('process.exit(1)')

      expect(errorOutput()).toContain('Choose either --in-place or --staged, not both.')
      expect(graphqlRequest).not.toHaveBeenCalled()
    })

    it('warns only about the in-place outcome with --in-place', async () => {
      isInteractive.mockReturnValue(true)
      promptMocks.confirm.mockResolvedValue(false)
      graphqlRequest
        .mockResolvedValueOnce({ databases: [database] })
        .mockResolvedValueOnce(serviceUsers)

      await run(['rotate-user', 'primary', 'g_web_3f9a0c1e', '--in-place'])

      expect(logOutput()).toContain('"g_web_3f9a0c1e" gets a new password now')
      expect(logOutput()).not.toContain('Advanced Deployments')
    })

    it('exits with the reason a rotation cannot start', async () => {
      graphqlRequest
        .mockResolvedValueOnce({ databases: [database] })
        .mockResolvedValueOnce(serviceUsers)
        .mockResolvedValueOnce({
          rotateDatabaseServiceUser: {
            success: false,
            message: 'A rotation for this database user is already waiting for a deploy.',
            deploymentId: null,
          },
        })

      await expect(runToEnd(['rotate-user', 'primary', 'g_web_3f9a0c1e', '--yes'])).rejects.toThrow(
        'process.exit(1)'
      )
      expect(spinner.fail).toHaveBeenCalledWith(
        'A rotation for this database user is already waiting for a deploy.'
      )
    })

    it('refuses a user Gantry did not create', async () => {
      graphqlRequest
        .mockResolvedValueOnce({ databases: [database] })
        .mockResolvedValueOnce(serviceUsers)

      await expect(run(['rotate-user', 'primary', 'reporting', '--yes'])).rejects.toThrow(
        'process.exit(1)'
      )
      expect(errorOutput()).toContain('Database user not found.')
      expect(graphqlRequest).toHaveBeenCalledTimes(2)
    })

    it('warns about both rotation kinds and stops when declined', async () => {
      isInteractive.mockReturnValue(true)
      promptMocks.confirm.mockResolvedValue(false)
      graphqlRequest
        .mockResolvedValueOnce({ databases: [database] })
        .mockResolvedValueOnce(serviceUsers)

      await run(['rotate-user', 'primary', 'g_web_3f9a0c1e'])

      expect(logOutput()).toContain('be ready to redeploy the service')
      expect(logLines()).toContain('Rotation cancelled.')
      expect(graphqlRequest).toHaveBeenCalledTimes(2)
    })
  })

  describe('credentials', () => {
    it.each(['primary', 'db-id-1'])(
      'resolves %s from the database list and requests credentials by id',
      async (arg) => {
        graphqlRequest
          .mockResolvedValueOnce({ databases: [database] })
          .mockResolvedValueOnce(credentials)

        await run(['credentials', arg])

        expect(graphqlRequest).toHaveBeenCalledTimes(2)
        expect(sentQuery(0)).toContain('query GetDatabases')
        expect(sentQuery(1)).toContain('query GetDatabaseCredentials($id: String!)')
        expect(sentQuery(1)).not.toContain('slug')
        expect(sentVariables(1)).toEqual({ id: 'db-id-1' })
      }
    )

    it('prints the credentials exactly', async () => {
      graphqlRequest
        .mockResolvedValueOnce({ databases: [database] })
        .mockResolvedValueOnce(credentials)

      await run(['credentials', 'primary'])

      expect(spinner.succeed).toHaveBeenCalledWith('Credentials retrieved')
      expect(logLines()).toEqual([
        '  Host:     primary.example.internal',
        '  Port:     5432',
        '  Username: gantry_admin',
        '  Password: Zq8#v2Lm!',
        '  Engine:   POSTGRESQL',
        '  Database: Primary (primary)',
      ])
    })

    it('prints the public endpoint and provider port for a publicly accessible database', async () => {
      graphqlRequest
        .mockResolvedValueOnce({ databases: [publicDatabase] })
        .mockResolvedValueOnce(credentials)

      await run(['credentials', 'reporting'])

      expect(logLines()).toEqual([
        '  Host:     reporting.abc123.us-east-1.rds.amazonaws.com',
        '  Port:     3306',
        '  Username: gantry_admin',
        '  Password: Zq8#v2Lm!',
        '  Engine:   MYSQL',
        '  Database: Reporting (reporting)',
      ])
    })

    it('shows N/A when the endpoint is not yet known', async () => {
      graphqlRequest
        .mockResolvedValueOnce({ databases: [{ ...database, endpoint: null }] })
        .mockResolvedValueOnce(credentials)

      await run(['credentials', 'primary'])

      expect(logLines()[0]).toBe('  Host:     N/A')
      expect(logLines()[1]).toBe('  Port:     5432')
    })

    it.each([
      ['MYSQL', '3306'],
      ['MARIADB', '3306'],
      ['POSTGRESQL', '5432'],
    ])('uses the %s default port when the provider has none', async (engine, port) => {
      graphqlRequest
        .mockResolvedValueOnce({
          databases: [{ ...database, engine, endpoint: 'db.internal', port: null }],
        })
        .mockResolvedValueOnce(credentials)

      await run(['credentials', 'primary'])

      expect(logOutput()).toContain(`Port:     ${port}`)
    })

    it('fails clearly for an unknown engine with no provider port', async () => {
      graphqlRequest.mockResolvedValueOnce({
        databases: [{ ...database, engine: 'SQLSERVER', endpoint: 'db.internal', port: null }],
      })

      await expect(run(['credentials', 'primary'])).rejects.toThrow('process.exit(1)')

      expect(graphqlRequest).toHaveBeenCalledTimes(1)
      expect(errorOutput()).toContain('Unknown database or cache engine.')
    })

    it('uses the provider port for an unknown engine', async () => {
      graphqlRequest
        .mockResolvedValueOnce({
          databases: [
            {
              ...database,
              engine: 'SQLSERVER',
              endpoint: 'db.internal',
              port: 1433,
            },
          ],
        })
        .mockResolvedValueOnce(credentials)

      await run(['credentials', 'primary'])

      expect(logLines()[1]).toBe('  Port:     1433')
    })

    it('prompts for an active database when no slug is given', async () => {
      graphqlRequest
        .mockResolvedValueOnce({
          databases: [{ ...database, id: 'db-id-0', status: 'PENDING' }, database],
        })
        .mockResolvedValueOnce(credentials)
      promptMocks.select.mockResolvedValueOnce('db-id-1')

      await run(['credentials'])

      expect(promptMocks.select).toHaveBeenCalledWith({
        message: 'Select a database:',
        choices: [{ name: 'Primary (POSTGRESQL) — primary', value: 'db-id-1' }],
      })
      expect(sentVariables(1)).toEqual({ id: 'db-id-1' })
    })

    it('fails when there are no active databases', async () => {
      graphqlRequest.mockResolvedValueOnce({ databases: [{ ...database, status: 'FAILED' }] })

      await expect(run(['credentials'])).rejects.toThrow('process.exit(1)')

      expect(errorOutput()).toContain('No active databases found.')
    })

    it('fails when the selection does not match a database', async () => {
      graphqlRequest.mockResolvedValueOnce({ databases: [database] })
      promptMocks.select.mockResolvedValueOnce('db-id-gone')

      await expect(run(['credentials'])).rejects.toThrow('process.exit(1)')

      expect(errorOutput()).toContain('Database not found.')
    })

    it('fails without requesting credentials when no database matches', async () => {
      graphqlRequest.mockResolvedValueOnce({ databases: [database] })

      await expect(run(['credentials', 'missing'])).rejects.toThrow('process.exit(1)')

      expect(graphqlRequest).toHaveBeenCalledTimes(1)
      expect(errorOutput()).toContain('Database not found.')
    })

    it.each([
      [{ success: false, message: 'Secret not found' }, 'Secret not found'],
      [{ success: false }, 'There was an error while loading the database credentials.'],
    ])('fails the spinner when credentials are unavailable (%j)', async (result, message) => {
      graphqlRequest
        .mockResolvedValueOnce({ databases: [database] })
        .mockResolvedValueOnce({ databaseCredentials: result })

      await expect(run(['credentials', 'primary'])).rejects.toThrow('process.exit(1)')

      expect(spinner.fail).toHaveBeenCalledWith(message)
      expect(logSpy).not.toHaveBeenCalled()
    })

    it.each([
      { success: true, username: null, password: 'Zq8#v2Lm!' },
      { success: true, username: 'gantry_admin', password: null },
      { success: true, username: null, password: null },
    ])('fails generically when success is true but a credential is null (%j)', async (result) => {
      graphqlRequest
        .mockResolvedValueOnce({ databases: [database] })
        .mockResolvedValueOnce({ databaseCredentials: result })

      await expect(run(['credentials', 'primary'])).rejects.toThrow('process.exit(1)')

      expect(spinner.fail).toHaveBeenCalledWith(
        'There was an error while loading the database credentials.'
      )
      expect(spinner.succeed).not.toHaveBeenCalled()
      expect(logSpy).not.toHaveBeenCalled()
      expect(errorOutput()).not.toContain('undefined')
    })
  })

  describe('lookup', () => {
    it('prefers an exact id match over a slug match', async () => {
      graphqlRequest
        .mockResolvedValueOnce({
          databases: [
            { ...database, id: 'db-id-2', slug: 'db-id-1', name: 'Slug match' },
            { ...database, name: 'Id match' },
          ],
        })
        .mockResolvedValueOnce(credentials)

      await run(['credentials', 'db-id-1'])

      expect(sentVariables(1)).toEqual({ id: 'db-id-1' })
      expect(logOutput()).toContain('Database: Id match')
    })
  })

  describe('tunnel', () => {
    let sigintHandlers: (() => void)[]
    const close = vi.fn()

    beforeEach(() => {
      sigintHandlers = []
      const realOn = process.on.bind(process)
      vi.spyOn(process, 'on').mockImplementation(((event: string, listener: () => void) => {
        if (event === 'SIGINT') {
          sigintHandlers.push(listener)
          return process
        }
        return realOn(event, listener)
      }) as typeof process.on)
      close.mockResolvedValue(undefined)
      bastionMocks.fetchBastionCredentials.mockResolvedValue({
        privateKey: 'fake-bastion-private-key',
        sshUser: 'ubuntu',
        hostPublicKey: null,
        hostKeyFingerprint: 'SHA256:ZLHH8qScCNumv6jTt1L8kj+sFVAHleXj5Y3NxKTXIWs',
      })
      tunnelMocks.openSshTunnel.mockResolvedValue({ localPort: 15432, close })
      tunnelMocks.openDirectTunnel.mockResolvedValue({ localPort: 13306, close })
    })

    async function runUntilSigint(args: string[]): Promise<void> {
      const pending = run(args)
      await vi.waitFor(() => {
        expect(sigintHandlers).toHaveLength(1)
      })
      sigintHandlers[0]?.()
      sigintHandlers[0]?.()
      await pending
    }

    it('tunnels through the named bastion, passes the host-key policy and closes on SIGINT', async () => {
      graphqlRequest.mockResolvedValueOnce({ databases: [database] }).mockResolvedValueOnce(bastion)

      await runUntilSigint([
        'tunnel',
        'primary',
        '--bastion',
        'ops-bastion',
        '--port',
        '15432',
        '--trust-host-key',
      ])

      expect(bastionMocks.selectBastion).not.toHaveBeenCalled()
      expect(promptMocks.input).not.toHaveBeenCalled()
      expect(bastionMocks.fetchBastionCredentials).toHaveBeenCalledWith('ops-bastion')
      expect(sentQuery(1)).toContain('query GetDatabaseTunnelBastion($slug: String!)')
      expect(sentVariables(1)).toEqual({ slug: 'ops-bastion' })

      const config = tunnelMocks.openSshTunnel.mock.calls[0]?.[0] as {
        hostKey: { pauseOutput: () => void; resumeOutput: () => void }
      }
      expect(config).toEqual({
        bastionHost: '203.0.113.10',
        bastionUsername: 'ubuntu',
        hostKey: {
          hostId: 'bastion-r3bq9m@203.0.113.10',
          label: 'ops-bastion',
          expectedFingerprint: 'SHA256:ZLHH8qScCNumv6jTt1L8kj+sFVAHleXj5Y3NxKTXIWs',
          trustHostKey: true,
          pauseOutput: expect.any(Function) as unknown,
          resumeOutput: expect.any(Function) as unknown,
        },
        privateKey: 'fake-bastion-private-key',
        remoteHost: 'primary.example.internal',
        remotePort: 5432,
        localPort: 15432,
      })
      spinner.stop.mockClear()
      spinner.start.mockClear()
      config.hostKey.pauseOutput()
      expect(spinner.stop).toHaveBeenCalledTimes(1)
      expect(spinner.start).not.toHaveBeenCalled()
      config.hostKey.resumeOutput()
      expect(spinner.start).toHaveBeenCalledTimes(1)

      expect(spinner.succeed).toHaveBeenCalledWith('Tunnel connected')
      expect(logLines()).toEqual([
        '  Host:     localhost',
        '  Port:     15432',
        '  Engine:   POSTGRESQL',
        '  Database: primary.example.internal',
        '',
        '  Press Ctrl+C to close the tunnel.',
        '\n  Closing tunnel...',
      ])
      expect(close).toHaveBeenCalledTimes(1)
    })

    it('leaves trustHostKey unset without --trust-host-key', async () => {
      graphqlRequest.mockResolvedValueOnce({ databases: [database] }).mockResolvedValueOnce(bastion)

      await runUntilSigint(['tunnel', 'primary', '--bastion', 'ops-bastion', '--port', '15432'])

      expect(tunnelMocks.openSshTunnel).toHaveBeenCalledWith(
        expect.objectContaining({
          hostKey: expect.objectContaining({ trustHostKey: undefined }) as unknown,
        })
      )
    })

    it('uses the bastion chosen from the network', async () => {
      graphqlRequest.mockResolvedValueOnce({ databases: [database] }).mockResolvedValueOnce(bastion)
      bastionMocks.selectBastion.mockResolvedValueOnce({ slug: 'net-bastion' })

      await runUntilSigint(['tunnel', 'primary', '--port', '15432'])

      expect(bastionMocks.selectBastion).toHaveBeenCalledWith({
        networkId: 'h4nw8r',
        includeCreateOption: true,
        filter: bastionMocks.activeOnly,
      })
      expect(bastionMocks.fetchBastionCredentials).toHaveBeenCalledWith('net-bastion')
    })

    it('creates a bastion when asked and waits for it', async () => {
      graphqlRequest.mockResolvedValueOnce({ databases: [database] }).mockResolvedValueOnce(bastion)
      bastionMocks.selectBastion.mockResolvedValueOnce('create')
      bastionMocks.createBastionInteractive.mockResolvedValueOnce({ slug: 'new-bastion' })

      await runUntilSigint(['tunnel', 'primary', '--port', '15432'])

      expect(bastionMocks.createBastionInteractive).toHaveBeenCalledWith({
        cloudAccountId: 'cloud-1',
        networkId: 'h4nw8r',
        waitForActive: true,
      })
      expect(bastionMocks.fetchBastionCredentials).toHaveBeenCalledWith('new-bastion')
    })

    it.each([
      ['MYSQL', '3306'],
      ['MARIADB', '3306'],
      ['POSTGRESQL', '5432'],
    ])('offers and tunnels to the %s default port', async (engine, port) => {
      graphqlRequest
        .mockResolvedValueOnce({
          databases: [{ ...database, engine, endpoint: 'db.internal', port: null }],
        })
        .mockResolvedValueOnce(bastion)
      promptMocks.input.mockResolvedValueOnce(port)

      await runUntilSigint(['tunnel', 'primary', '--bastion', 'ops-bastion'])

      const prompt = promptMocks.input.mock.calls[0]?.[0] as {
        default: string
        validate: (v: string) => unknown
      }
      expect(prompt.default).toBe(port)
      expect(prompt.validate('0')).toBe('Enter a valid port (1-65535)')
      expect(prompt.validate('65536')).toBe('Enter a valid port (1-65535)')
      expect(prompt.validate('abc')).toBe('Enter a valid port (1-65535)')
      expect(prompt.validate(port)).toBe(true)
      expect(tunnelMocks.openSshTunnel).toHaveBeenCalledWith(
        expect.objectContaining({ remotePort: Number(port), localPort: Number(port) })
      )
    })

    it('fails clearly for an unknown engine with no provider port', async () => {
      graphqlRequest.mockResolvedValueOnce({
        databases: [{ ...database, engine: 'SQLSERVER', endpoint: 'db.internal', port: null }],
      })

      await expect(run(['tunnel', 'primary', '--bastion', 'ops-bastion'])).rejects.toThrow(
        'process.exit(1)'
      )

      expect(errorOutput()).toContain('Unknown database or cache engine.')
      expect(promptMocks.input).not.toHaveBeenCalled()
      expect(tunnelMocks.openSshTunnel).not.toHaveBeenCalled()
    })

    it('offers the provider port for an unknown engine', async () => {
      graphqlRequest
        .mockResolvedValueOnce({
          databases: [
            {
              ...database,
              engine: 'SQLSERVER',
              endpoint: 'db.internal',
              port: 1433,
            },
          ],
        })
        .mockResolvedValueOnce(bastion)
      promptMocks.input.mockResolvedValueOnce('1433')

      await runUntilSigint(['tunnel', 'primary', '--bastion', 'ops-bastion'])

      expect(promptMocks.input).toHaveBeenCalledWith(expect.objectContaining({ default: '1433' }))
    })

    it('fails when the bastion has no public IP', async () => {
      graphqlRequest
        .mockResolvedValueOnce({ databases: [database] })
        .mockResolvedValueOnce({ bastion: { id: 'r3bq9m', publicIp: null } })

      await expect(
        run(['tunnel', 'primary', '--bastion', 'ops-bastion', '--port', '15432'])
      ).rejects.toThrow('process.exit(1)')

      expect(spinner.fail).toHaveBeenCalledWith('Bastion host does not have a public IP address.')
      expect(tunnelMocks.openSshTunnel).not.toHaveBeenCalled()
    })

    it.each([
      [
        new Error('All configured authentication methods failed'),
        'All configured authentication methods failed',
      ],
      ['ECONNREFUSED', 'ECONNREFUSED'],
    ])('reports an SSH failure (%s)', async (failure, message) => {
      graphqlRequest.mockResolvedValueOnce({ databases: [database] }).mockResolvedValueOnce(bastion)
      tunnelMocks.openSshTunnel.mockRejectedValueOnce(failure)

      await expect(
        run(['tunnel', 'primary', '--bastion', 'ops-bastion', '--port', '15432'])
      ).rejects.toThrow('process.exit(1)')

      expect(spinner.fail).toHaveBeenCalledWith(`Failed to connect: ${message}`)
    })

    it('labels active databases public or private when prompting', async () => {
      graphqlRequest.mockResolvedValueOnce({
        databases: [database, publicDatabase, { ...database, id: 'db-id-3', status: 'PENDING' }],
      })
      promptMocks.select.mockResolvedValueOnce('db-id-gone')

      await expect(run(['tunnel'])).rejects.toThrow('process.exit(1)')

      expect(promptMocks.select).toHaveBeenCalledWith({
        message: 'Select a database:',
        choices: [
          { name: 'Primary (POSTGRESQL) — primary [private]', value: 'db-id-1' },
          { name: 'Reporting (MYSQL) — reporting [public]', value: 'db-id-2' },
        ],
      })
      expect(errorOutput()).toContain('Database not found.')
    })

    it('tunnels to the database picked from the prompt', async () => {
      graphqlRequest.mockResolvedValueOnce({ databases: [database] }).mockResolvedValueOnce(bastion)
      promptMocks.select.mockResolvedValueOnce('db-id-1')

      await runUntilSigint(['tunnel', '--bastion', 'ops-bastion', '--port', '15432'])

      expect(tunnelMocks.openSshTunnel).toHaveBeenCalledWith(
        expect.objectContaining({ remoteHost: 'primary.example.internal' })
      )
    })

    it('fails when there are no active databases', async () => {
      graphqlRequest.mockResolvedValueOnce({ databases: [{ ...database, status: 'PENDING' }] })

      await expect(run(['tunnel'])).rejects.toThrow('process.exit(1)')

      expect(errorOutput()).toContain('No active databases found.')
    })

    it('looks a database up by listing and filtering on slug', async () => {
      graphqlRequest.mockResolvedValueOnce({ databases: [{ ...database, endpoint: null }] })

      await expect(run(['tunnel', 'primary'])).rejects.toThrow('process.exit(1)')

      expect(graphqlRequest).toHaveBeenCalledTimes(1)
      expect(sentQuery(0)).toContain('query GetDatabases')
      expect(errorOutput()).toContain('Database endpoint not available')
    })

    it('fails when no database matches', async () => {
      graphqlRequest.mockResolvedValueOnce({ databases: [] })

      await expect(run(['tunnel', 'missing'])).rejects.toThrow('process.exit(1)')

      expect(errorOutput()).toContain('Database not found.')
    })

    describe('publicly accessible database', () => {
      it('shows the direct connection details exactly', async () => {
        graphqlRequest
          .mockResolvedValueOnce({ databases: [publicDatabase] })
          .mockResolvedValueOnce(credentials)
        promptMocks.select.mockResolvedValueOnce('details')

        await run(['tunnel', 'reporting'])

        expect(promptMocks.select).toHaveBeenCalledWith({
          message: 'This database is publicly accessible and can be connected to directly.',
          choices: [
            { name: 'Show direct connection details', value: 'details' },
            { name: 'Create a local tunnel anyway', value: 'tunnel' },
          ],
        })
        expect(sentVariables(1)).toEqual({ id: 'db-id-2' })
        expect(spinner.succeed).toHaveBeenCalledWith('Connection details:')
        expect(logLines()).toEqual([
          '  Host:     reporting.abc123.us-east-1.rds.amazonaws.com',
          '  Port:     3306',
          '  Username: gantry_admin',
          '  Password: Zq8#v2Lm!',
          '  Engine:   MYSQL',
        ])
        expect(tunnelMocks.openDirectTunnel).not.toHaveBeenCalled()
      })

      it.each([
        [{ success: false, message: 'Secret not found' }, 'Secret not found'],
        [{ success: false }, 'There was an error while loading the database credentials.'],
      ])('fails when the details cannot be loaded (%j)', async (result, message) => {
        graphqlRequest
          .mockResolvedValueOnce({ databases: [publicDatabase] })
          .mockResolvedValueOnce({ databaseCredentials: result })
        promptMocks.select.mockResolvedValueOnce('details')

        await expect(run(['tunnel', 'reporting'])).rejects.toThrow('process.exit(1)')

        expect(spinner.fail).toHaveBeenCalledWith(message)
      })

      it('opens a direct tunnel without a bastion and closes it on SIGINT', async () => {
        graphqlRequest.mockResolvedValueOnce({ databases: [publicDatabase] })
        promptMocks.select.mockResolvedValueOnce('tunnel')
        promptMocks.input.mockResolvedValueOnce('13306')

        await runUntilSigint(['tunnel', 'reporting'])

        expect(promptMocks.input).toHaveBeenCalledWith(expect.objectContaining({ default: '3306' }))
        expect(tunnelMocks.openDirectTunnel).toHaveBeenCalledWith({
          remoteHost: 'reporting.abc123.us-east-1.rds.amazonaws.com',
          remotePort: 3306,
          localPort: 13306,
        })
        expect(bastionMocks.selectBastion).not.toHaveBeenCalled()
        expect(tunnelMocks.openSshTunnel).not.toHaveBeenCalled()
        expect(spinner.succeed).toHaveBeenCalledWith('Tunnel connected')
        expect(logLines()).toEqual([
          '  Host:     localhost',
          '  Port:     13306',
          '  Engine:   MYSQL',
          '  Database: reporting.abc123.us-east-1.rds.amazonaws.com',
          '',
          '  Press Ctrl+C to close the tunnel.',
          '\n  Closing tunnel...',
        ])
        expect(close).toHaveBeenCalledTimes(1)
      })

      it.each([
        [new Error('listen EADDRINUSE'), 'listen EADDRINUSE'],
        ['EACCES', 'EACCES'],
      ])('reports a direct tunnel failure (%s)', async (failure, message) => {
        graphqlRequest.mockResolvedValueOnce({ databases: [publicDatabase] })
        promptMocks.select.mockResolvedValueOnce('tunnel')
        tunnelMocks.openDirectTunnel.mockRejectedValueOnce(failure)

        await expect(run(['tunnel', 'reporting', '--port', '13306'])).rejects.toThrow(
          'process.exit(1)'
        )

        expect(spinner.fail).toHaveBeenCalledWith(`Failed to connect: ${message}`)
      })

      it('goes through the bastion when --bastion is given', async () => {
        graphqlRequest
          .mockResolvedValueOnce({ databases: [publicDatabase] })
          .mockResolvedValueOnce(bastion)

        await runUntilSigint(['tunnel', 'reporting', '--bastion', 'ops-bastion', '--port', '13306'])

        expect(promptMocks.select).not.toHaveBeenCalled()
        expect(tunnelMocks.openDirectTunnel).not.toHaveBeenCalled()
        expect(tunnelMocks.openSshTunnel).toHaveBeenCalledWith(
          expect.objectContaining({
            bastionHost: '203.0.113.10',
            remoteHost: 'reporting.abc123.us-east-1.rds.amazonaws.com',
            remotePort: 3306,
            localPort: 13306,
          })
        )
      })
    })
  })
})
