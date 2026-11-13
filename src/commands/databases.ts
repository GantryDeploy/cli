import { confirm, input, select } from '@inquirer/prompts'
import type { Command } from 'commander'
import ora from 'ora'

import type {
  AdoptDatabaseMutation,
  AdoptDatabaseMutationVariables,
  CreateDatabaseMutation,
  CreateDatabaseMutationVariables,
  DatabaseLogsQuery,
  DatabaseLogsQueryVariables,
  GetDatabaseCredentialsQuery,
  GetDatabaseCredentialsQueryVariables,
  GetDatabaseEngineVersionsQuery,
  GetDatabaseEngineVersionsQueryVariables,
  GetDatabaseOperationQuery,
  GetDatabaseOperationQueryVariables,
  GetDatabasesQuery,
  GetDatabasesQueryVariables,
  GetDatabaseServiceUsersQuery,
  GetDatabaseServiceUsersQueryVariables,
  GetDatabaseSizesQuery,
  GetDatabaseSizesQueryVariables,
  GetDatabaseTunnelBastionQuery,
  GetDatabaseTunnelBastionQueryVariables,
  GetDatabaseTypesQuery,
  GetDatabaseTypesQueryVariables,
  RotateDatabaseServiceUserMutation,
  RotateDatabaseServiceUserMutationVariables,
  UpdateDatabaseMutation,
  UpdateDatabaseMutationVariables,
} from '../generated/graphql'
import {
  activeOnly,
  createBastionInteractive,
  fetchBastionCredentials,
  selectBastion,
} from '../lib/bastion-prompts'
import { formatApiError, graphqlRequest } from '../lib/client'
import { foreignAwsFlagsMessage, isAws, unsupportedCloud } from '../lib/clouds'
import {
  awsCatalogFamily,
  awsDatabaseCreateSettings,
  awsDatabaseFlavorOf,
  awsOption,
  toAwsDatabaseDeploymentMode,
  toAwsDatabaseFlavor,
  type AwsDatabaseCreateFlags,
} from '../lib/clouds/aws'
import { buildDatabaseUpdate, type DatabaseUpdateOptions } from '../lib/database-update'
import { isTerminalStatus } from '../lib/deployment-status'
import { getDefaultPort, normalizeEngine, toDatabaseEngineEnum } from '../lib/engine'
import { resolveCloud, selectNetwork } from '../lib/interactive-prompts'
import { bastionHostId } from '../lib/known-hosts'
import { streamLogs, withLogQueryOptions } from '../lib/log-stream'
import type { LogQueryOptions } from '../lib/log-stream'
import { createTable, formatDate, printError, printSuccess, slugify } from '../lib/output'
import { sanitizeTerminal } from '../lib/sanitize'
import { openDirectTunnel, openSshTunnel } from '../lib/ssh-tunnel'
import { isInteractive } from '../lib/terminal'

type Database = GetDatabasesQuery['databases'][number]

interface TunnelOptions {
  port?: string
  bastion?: string
  trustHostKey?: boolean
}

const DATABASE_LOGS = /* GraphQL */ `
  query DatabaseLogs($id: String!, $since: String, $limit: Int, $grep: String, $cursor: String) {
    databaseLogs(id: $id, since: $since, limit: $limit, grep: $grep, cursor: $cursor) {
      lines {
        timestamp
        message
      }
      cursor
    }
  }
`

const DATABASES_QUERY = /* GraphQL */ `
  query GetDatabases {
    databases {
      id
      name
      slug
      engine
      status
      cloudAccountId
      networkId
      provider
      endpoint
      port
      publiclyAccessible
      createdAt
    }
  }
`

const DATABASE_CREDENTIALS_QUERY = /* GraphQL */ `
  query GetDatabaseCredentials($id: String!) {
    databaseCredentials(id: $id) {
      success
      message
      username
      password
    }
  }
`

const DATABASE_TYPES_QUERY = /* GraphQL */ `
  query GetDatabaseTypes($provider: CloudProviderEnum!) {
    databaseTypes(provider: $provider) {
      engine
      displayName
      provider
      description
      guidance
      supportsServerless
      requiresNetwork
      providerData
    }
  }
`

const DATABASE_ENGINE_VERSIONS_QUERY = /* GraphQL */ `
  query GetDatabaseEngineVersions(
    $provider: CloudProviderEnum!
    $engine: DatabaseEngineEnum
    $region: String
    $aws: AwsDatabaseCatalogFilterInput
  ) {
    databaseEngineVersions(provider: $provider, engine: $engine, region: $region, aws: $aws) {
      engine
      version
      description
      providerData
    }
  }
`

const DATABASE_SIZES_QUERY = /* GraphQL */ `
  query GetDatabaseSizes(
    $provider: CloudProviderEnum!
    $engine: DatabaseEngineEnum
    $region: String
    $aws: AwsDatabaseCatalogFilterInput
  ) {
    databaseSizes(provider: $provider, engine: $engine, region: $region, aws: $aws) {
      size
      family
      vcpu
      memoryMb
    }
  }
`
const CREATE_DATABASE_MUTATION = /* GraphQL */ `
  mutation CreateDatabase($input: CreateDatabaseInput!) {
    createDatabase(input: $input) {
      success
      message
      database {
        id
        name
        slug
        engine
        status
      }
      deploymentId
    }
  }
`

const DATABASE_SERVICE_USERS_QUERY = /* GraphQL */ `
  query GetDatabaseServiceUsers($id: String!) {
    databaseServiceUsers(id: $id) {
      id
      databaseName
      username
      auth
      access
      status
      serviceName
      environmentSlug
    }
  }
`

const ADOPT_DATABASE_MUTATION = /* GraphQL */ `
  mutation AdoptDatabase($id: String!, $database: String!) {
    adoptDatabase(id: $id, database: $database) {
      success
      message
      deploymentId
    }
  }
`

const ROTATE_SERVICE_USER_MUTATION = /* GraphQL */ `
  mutation RotateDatabaseServiceUser(
    $id: String!
    $serviceUserId: String!
    $mode: DatabaseUserRotationMode
  ) {
    rotateDatabaseServiceUser(id: $id, serviceUserId: $serviceUserId, mode: $mode) {
      success
      message
      deploymentId
    }
  }
`

const UPDATE_DATABASE_MUTATION = /* GraphQL */ `
  mutation UpdateDatabase($id: String!, $input: UpdateDatabaseInput!) {
    updateDatabase(id: $id, input: $input) {
      success
      message
      deploymentId
    }
  }
`

const OPERATION_QUERY = /* GraphQL */ `
  query GetDatabaseOperation($id: String!) {
    deployment(id: $id) {
      status
      lastMessage
    }
  }
`
interface CatalogFlags {
  cloud?: string
  engine?: string
  region?: string
  awsFlavor?: string
}

type DatabaseVersion = GetDatabaseEngineVersionsQuery['databaseEngineVersions'][number]

/** Shared filters for the engine-version and size catalogs, refusing AWS filters on other clouds. */
async function catalogVariables(
  options: CatalogFlags
): Promise<GetDatabaseEngineVersionsQueryVariables & GetDatabaseSizesQueryVariables> {
  const { provider } = await resolveCloud(options.cloud)
  const foreign = foreignAwsFlagsMessage(provider, options)
  if (foreign) {
    printError(foreign)
    process.exit(1)
  }
  if (isAws(provider) && options.engine && !options.awsFlavor) {
    printError('Pass --aws-flavor rds or aurora to filter AWS databases by engine.')
    process.exit(1)
  }
  return {
    provider,
    ...(options.engine ? { engine: toDatabaseEngineEnum(options.engine) } : {}),
    ...(options.region ? { region: options.region } : {}),
    ...(options.awsFlavor ? { aws: { flavor: toAwsDatabaseFlavor(options.awsFlavor) } } : {}),
  }
}

function versionLabel(version: DatabaseVersion): string {
  const family = awsCatalogFamily(version.providerData)
  return family ? `${version.version} (${family})` : version.version
}

const OPERATION_POLL_MS = 2000
const OPERATION_TIMEOUT_MS = 5 * 60 * 1000

async function requireDatabase(slugOrId: string): Promise<Database> {
  const found = await findDatabase(slugOrId)
  if (!found) {
    printError('Database not found.')
    process.exit(1)
  }
  return found
}

async function confirmAdopt(server: string, database: string, yes: boolean): Promise<boolean> {
  if (yes) return true
  const warning =
    `Every table, view, sequence and schema in "${database}" on "${server}" moves to Gantry's owner role. ` +
    'Each database user that owned any of them becomes a member of that role, so it keeps working, ' +
    'but with owner rights over the whole database.'
  if (!isInteractive()) {
    printError(`${warning} Re-run with --yes to confirm.`)
    process.exit(1)
  }
  console.log(warning)
  return confirm({ message: `Adopt "${database}"?`, default: false })
}

type RotationMode = 'IN_PLACE' | 'STAGED'

function rotationWarning(username: string, mode: RotationMode | undefined): string {
  const staged = `a second user with a new password takes over on the service's next deploy, and "${username}" keeps working until no live version uses it.`
  const inPlace =
    'running instances keep the old password and fail to connect until they restart, so be ready to redeploy the service.'
  if (mode === 'IN_PLACE') return `"${username}" gets a new password now, and ${inPlace}`
  if (mode === 'STAGED') return `With a staged rotation, ${staged}`
  return `On plans with Advanced Deployments, ${staged} On other plans the password changes now, and ${inPlace}`
}

async function confirmRotate(
  user: string,
  mode: RotationMode | undefined,
  yes: boolean
): Promise<boolean> {
  if (yes) return true
  const username = sanitizeTerminal(user)
  const warning = rotationWarning(username, mode)
  if (!isInteractive()) {
    printError(`${warning} Re-run with --yes to confirm.`)
    process.exit(1)
  }
  console.log(warning)
  return confirm({ message: `Rotate the password for "${username}"?`, default: false })
}

async function waitForOperation(deploymentId: string): Promise<{ ok: boolean; message: string }> {
  const startTime = Date.now()
  while (Date.now() - startTime < OPERATION_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, OPERATION_POLL_MS))
    try {
      const { deployment } = await graphqlRequest<
        GetDatabaseOperationQuery,
        GetDatabaseOperationQueryVariables
      >(OPERATION_QUERY, { id: deploymentId })
      if (deployment && isTerminalStatus(deployment.status)) {
        return {
          ok: deployment.status === 'COMPLETE',
          message: sanitizeTerminal(deployment.lastMessage ?? ''),
        }
      }
    } catch {
      // Network errors are transient while polling; keep trying.
    }
  }
  return { ok: false, message: 'Timed out waiting for the operation to finish.' }
}

async function findDatabase(slugOrId: string): Promise<Database | undefined> {
  const data = await graphqlRequest<GetDatabasesQuery, GetDatabasesQueryVariables>(DATABASES_QUERY)
  return (
    data.databases.find((d) => d.id === slugOrId) ?? data.databases.find((d) => d.slug === slugOrId)
  )
}

export function registerDatabasesCommand(program: Command): void {
  const dbCmd = program.command('databases').alias('db').description('Manage databases')

  dbCmd
    .command('list')
    .description('List all databases')
    .action(async () => {
      try {
        const data = await graphqlRequest<GetDatabasesQuery, GetDatabasesQueryVariables>(
          DATABASES_QUERY
        )
        const { databases } = data

        if (databases.length === 0) {
          console.log('No databases found.')
          return
        }

        const table = createTable({
          head: ['ID', 'Name', 'Slug', 'Engine', 'Status', 'Created'],
        })

        for (const db of databases) {
          table.push([
            db.id,
            db.name,
            db.slug,
            db.engine,
            db.status.toUpperCase(),
            formatDate(db.createdAt),
          ])
        }

        console.log(table.toString())
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  dbCmd
    .command('engines')
    .description('List the database engines a cloud offers')
    .option('--cloud <id>', 'Cloud account ID')
    .action(async (options: { cloud?: string }) => {
      try {
        const { provider } = await resolveCloud(options.cloud)
        const data = await graphqlRequest<GetDatabaseTypesQuery, GetDatabaseTypesQueryVariables>(
          DATABASE_TYPES_QUERY,
          { provider }
        )
        if (data.databaseTypes.length === 0) {
          console.log(unsupportedCloud('databases'))
          return
        }

        const aws = isAws(provider)
        const table = createTable({
          head: ['Engine', 'Name', 'Description', ...(aws ? ['AWS Service', 'Serverless'] : [])],
        })

        for (const t of data.databaseTypes) {
          table.push([
            normalizeEngine(t.engine),
            t.displayName,
            t.description,
            ...(aws
              ? [awsDatabaseFlavorOf(t.providerData) ?? '-', t.supportsServerless ? 'Yes' : 'No']
              : []),
          ])
        }

        console.log(table.toString())
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  dbCmd
    .command('engine-versions')
    .description('List the database engine versions a cloud offers')
    .option('--cloud <id>', 'Cloud account ID')
    .option('--engine <engine>', 'Filter by engine')
    .option('--region <region>', 'Filter by region')
    .addOption(awsOption('--aws-flavor <service>', 'rds or aurora (needed with --engine)'))
    .addOption(
      awsOption('--aws-mode <mode>', 'Filter by deployment mode: provisioned or serverless')
    )
    .action(async (options: CatalogFlags & { awsMode?: string }) => {
      try {
        const variables = await catalogVariables(options)
        if (options.awsMode) {
          variables.aws = {
            ...variables.aws,
            deploymentMode: toAwsDatabaseDeploymentMode(options.awsMode),
          }
        }

        const data = await graphqlRequest<
          GetDatabaseEngineVersionsQuery,
          GetDatabaseEngineVersionsQueryVariables
        >(DATABASE_ENGINE_VERSIONS_QUERY, variables)

        if (data.databaseEngineVersions.length === 0) {
          console.log('No engine versions found matching the filters.')
          return
        }

        const table = createTable({
          head: ['Engine', 'Version', 'Description'],
        })

        for (const v of data.databaseEngineVersions) {
          table.push([normalizeEngine(v.engine), versionLabel(v), v.description])
        }

        console.log(table.toString())
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  dbCmd
    .command('sizes')
    .description('List the database server sizes a cloud offers')
    .option('--cloud <id>', 'Cloud account ID')
    .option('--engine <engine>', 'Filter by engine')
    .option('--region <region>', 'Filter by region')
    .addOption(awsOption('--aws-flavor <service>', 'rds or aurora (needed with --engine)'))
    .action(async (options: CatalogFlags) => {
      try {
        const variables = await catalogVariables(options)
        const data = await graphqlRequest<GetDatabaseSizesQuery, GetDatabaseSizesQueryVariables>(
          DATABASE_SIZES_QUERY,
          variables
        )

        if (data.databaseSizes.length === 0) {
          console.log('No sizes found matching the filters.')
          return
        }

        const table = createTable({
          head: ['Size', 'Family', 'vCPU', 'Memory (MB)'],
        })

        for (const s of data.databaseSizes) {
          table.push([s.size, s.family, String(s.vcpu), String(s.memoryMb)])
        }

        console.log(table.toString())
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  dbCmd
    .command('create')
    .description('Create a new database')
    .option('--cloud <id>', 'Cloud account ID')
    .option('--network <id>', 'Network ID')
    .option('--name <name>', 'Database name')
    .option('--slug <slug>', 'Database slug (auto-generated from name if omitted)')
    .option('--engine <engine>', 'postgresql, mysql or mariadb (see "gantry db engines")')
    .option('--size <size>', 'Server size (see "gantry db sizes")')
    .option('--storage <gb>', 'Storage in GB')
    .option('--engine-version <version>', 'Engine version (see "gantry db engine-versions")')
    .addOption(awsOption('--aws-flavor <service>', 'rds or aurora (see "gantry db engines")'))
    .addOption(awsOption('--aws-serverless', 'Use Aurora Serverless'))
    .addOption(
      awsOption(
        '--aws-no-master-rotation',
        'Keep the master password in a Gantry secret that never rotates, instead of AWS rotating it'
      )
    )
    .action(
      async (
        options: AwsDatabaseCreateFlags & {
          cloud?: string
          network?: string
          name?: string
          slug?: string
          engine?: string
          size?: string
          storage?: string
          engineVersion?: string
        }
      ) => {
        try {
          const requestedEngine = options.engine && toDatabaseEngineEnum(options.engine)
          const requestedFlavor = options.awsFlavor && toAwsDatabaseFlavor(options.awsFlavor)
          const storageGb = options.storage === undefined ? undefined : Number(options.storage)
          if (storageGb !== undefined && !Number.isInteger(storageGb)) {
            printError('--storage must be a whole number.')
            process.exit(1)
          }

          const cloud = await resolveCloud(options.cloud)
          const foreign = foreignAwsFlagsMessage(cloud.provider, options)
          if (foreign) {
            printError(foreign)
            process.exit(1)
          }
          const { databaseTypes } = await graphqlRequest<
            GetDatabaseTypesQuery,
            GetDatabaseTypesQueryVariables
          >(DATABASE_TYPES_QUERY, { provider: cloud.provider })
          if (databaseTypes.length === 0 || !isAws(cloud.provider)) {
            printError(unsupportedCloud('databases'))
            process.exit(1)
          }

          const networkId = options.network ?? (await selectNetwork(cloud.id))
          if (!networkId) {
            printError('A network is required to create a database.')
            process.exit(1)
          }

          const name =
            options.name ??
            (await input({
              message: 'Database name:',
              validate: (v) => (v.trim().length > 0 ? true : 'Name is required'),
            }))

          const offered = databaseTypes.filter(
            (t) =>
              (!requestedEngine || t.engine === requestedEngine) &&
              (!requestedFlavor || awsDatabaseFlavorOf(t.providerData) === requestedFlavor)
          )
          const onlyOffered = offered.at(0)
          if (!onlyOffered) {
            printError('That engine is not offered. See "gantry db engines".')
            process.exit(1)
          }
          const databaseType =
            offered.length === 1
              ? onlyOffered
              : await select({
                  message: 'Database engine:',
                  choices: offered.map((t) => ({
                    name: `${t.displayName} — ${t.description}`,
                    value: t,
                  })),
                })
          const { engine } = databaseType
          const flavor = awsDatabaseFlavorOf(databaseType.providerData)
          if (!flavor) {
            printError('There was an error while loading the database engines.')
            process.exit(1)
          }

          let useServerless = options.awsServerless ?? false
          if (options.awsServerless === undefined && databaseType.supportsServerless) {
            useServerless = await select({
              message: 'Use serverless mode?',
              choices: [
                { name: 'No', value: false },
                { name: 'Yes', value: true },
              ],
            })
          }

          let engineVersion = options.engineVersion
          if (!engineVersion) {
            const versionsData = await graphqlRequest<
              GetDatabaseEngineVersionsQuery,
              GetDatabaseEngineVersionsQueryVariables
            >(DATABASE_ENGINE_VERSIONS_QUERY, {
              provider: cloud.provider,
              engine,
              aws: { flavor, deploymentMode: useServerless ? 'SERVERLESS' : 'PROVISIONED' },
            })

            if (versionsData.databaseEngineVersions.length > 0) {
              engineVersion = await select({
                message: 'Engine version:',
                choices: versionsData.databaseEngineVersions.map((v) => ({
                  name: `${versionLabel(v)} — ${v.description}`,
                  value: v.version,
                })),
              })
            }
          }

          let size = options.size
          if (!size && !useServerless) {
            const sizesData = await graphqlRequest<
              GetDatabaseSizesQuery,
              GetDatabaseSizesQueryVariables
            >(DATABASE_SIZES_QUERY, { provider: cloud.provider, engine, aws: { flavor } })

            if (sizesData.databaseSizes.length > 0) {
              size = await select({
                message: 'Server size:',
                choices: sizesData.databaseSizes.map((s) => ({
                  name: `${s.size} — ${String(s.vcpu)} vCPU, ${String(s.memoryMb)} MB RAM`,
                  value: s.size,
                })),
              })
            }
          }

          // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty --slug string should fall back to a slug derived from the name, not be used verbatim
          const slug = options.slug || slugify(name)

          const data = await graphqlRequest<
            CreateDatabaseMutation,
            CreateDatabaseMutationVariables
          >(CREATE_DATABASE_MUTATION, {
            input: {
              cloudAccountId: cloud.id,
              networkId,
              name,
              slug,
              engine,
              engineVersion,
              size,
              storageGb,
              aws: awsDatabaseCreateSettings(flavor, useServerless, options),
            },
          })

          const result = data.createDatabase
          const database = result.database
          if (!result.success || !database) {
            printError(result.message ?? 'Failed to create database')
            process.exit(1)
          }

          printSuccess(`Database created: ${database.name} (${database.slug})`)
          console.log(`  ID: ${database.id}`)
          if (result.deploymentId) {
            console.log(`  Deployment: ${result.deploymentId}`)
          }
        } catch (error) {
          printError(formatApiError(error))
          process.exit(1)
        }
      }
    )

  dbCmd
    .command('credentials')
    .description('Get master credentials for a database')
    .argument('[slug]', 'Database slug')
    .action(async (slug?: string) => {
      try {
        let db: Database

        if (slug) {
          const found = await findDatabase(slug)
          if (!found) {
            printError('Database not found.')
            process.exit(1)
          }
          db = found
        } else {
          const data = await graphqlRequest<GetDatabasesQuery, GetDatabasesQueryVariables>(
            DATABASES_QUERY
          )
          const activeDbs = data.databases.filter((d) => d.status.toLowerCase() === 'active')

          if (activeDbs.length === 0) {
            printError('No active databases found.')
            process.exit(1)
          }

          const selectedId = await select({
            message: 'Select a database:',
            choices: activeDbs.map((d) => ({
              name: `${d.name} (${d.engine}) — ${d.slug}`,
              value: d.id,
            })),
          })

          const selected = activeDbs.find((d) => d.id === selectedId)
          if (!selected) {
            printError('Database not found.')
            process.exit(1)
          }
          db = selected
        }

        const remoteHost = db.endpoint?.split(':')[0] ?? ''
        const remotePort = db.port ?? getDefaultPort(db.engine)

        const spinner = ora('Fetching credentials...').start()
        const credsData = await graphqlRequest<
          GetDatabaseCredentialsQuery,
          GetDatabaseCredentialsQueryVariables
        >(DATABASE_CREDENTIALS_QUERY, { id: db.id })

        const { success, message, username, password } = credsData.databaseCredentials
        if (!success || username === null || password === null) {
          spinner.fail(message ?? 'There was an error while loading the database credentials.')
          process.exit(1)
        }

        spinner.succeed('Credentials retrieved')
        console.log(`  Host:     ${remoteHost || 'N/A'}`)
        console.log(`  Port:     ${String(remotePort)}`)
        console.log(`  Username: ${username}`)
        console.log(`  Password: ${password}`)
        console.log(`  Engine:   ${sanitizeTerminal(db.engine)}`)
        console.log(`  Database: ${sanitizeTerminal(db.name)} (${sanitizeTerminal(db.slug)})`)
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  dbCmd
    .command('users')
    .description('List the database users Gantry created for services on a server')
    .argument('<server>', 'Database server slug')
    .action(async (server: string) => {
      try {
        const db = await requireDatabase(server)
        const data = await graphqlRequest<
          GetDatabaseServiceUsersQuery,
          GetDatabaseServiceUsersQueryVariables
        >(DATABASE_SERVICE_USERS_QUERY, { id: db.id })

        if (data.databaseServiceUsers.length === 0) {
          console.log('No service database users on this server.')
          return
        }
        const table = createTable({
          head: ['Database', 'User', 'Service', 'Environment', 'Auth', 'Access', 'Status'],
        })
        for (const user of data.databaseServiceUsers) {
          table.push(
            [
              user.databaseName,
              user.username,
              user.serviceName,
              user.environmentSlug,
              user.auth,
              user.access,
              user.status,
            ].map((value) => sanitizeTerminal(value))
          )
        }
        console.log(table.toString())
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  dbCmd
    .command('adopt')
    .description(
      "Move an existing database's objects to Gantry's owner role so services can bind it"
    )
    .argument('<server>', 'Database server slug')
    .argument('<database>', 'Database inside the server')
    .option('-y, --yes', 'Skip the confirmation prompt')
    .action(async (server: string, database: string, options: { yes?: boolean }) => {
      try {
        const db = await requireDatabase(server)
        if (!(await confirmAdopt(db.slug, database, options.yes === true))) {
          console.log('Adopt cancelled.')
          return
        }

        const spinner = ora(`Adopting "${sanitizeTerminal(database)}"...`).start()
        const data = await graphqlRequest<AdoptDatabaseMutation, AdoptDatabaseMutationVariables>(
          ADOPT_DATABASE_MUTATION,
          { id: db.id, database }
        )
        const { success, message, deploymentId } = data.adoptDatabase
        if (!success || !deploymentId) {
          spinner.fail(message ?? 'There was an error while updating the database.')
          process.exit(1)
        }

        const outcome = await waitForOperation(deploymentId)
        if (!outcome.ok) {
          spinner.fail(outcome.message || 'There was an error while updating the database.')
          process.exit(1)
        }
        spinner.succeed(outcome.message || `Database "${sanitizeTerminal(database)}" adopted.`)
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  dbCmd
    .command('rotate-user')
    .description('Give a password service database user a new password')
    .argument('<server>', 'Database server slug')
    .argument('<username>', 'Service user, as `gantry db users` lists it')
    .option(
      '--in-place',
      'Change the password on the same user now, even on plans with Advanced Deployments'
    )
    .option(
      '--staged',
      'Create a second user that the next deploy switches to (Advanced Deployments plans)'
    )
    .option('-y, --yes', 'Skip the confirmation prompt')
    .action(
      async (
        server: string,
        username: string,
        options: { yes?: boolean; inPlace?: boolean; staged?: boolean }
      ) => {
        try {
          if (options.inPlace && options.staged) {
            printError('Choose either --in-place or --staged, not both.')
            process.exit(1)
          }
          const mode: RotationMode | undefined = options.inPlace
            ? 'IN_PLACE'
            : options.staged
              ? 'STAGED'
              : undefined
          const db = await requireDatabase(server)
          const { databaseServiceUsers } = await graphqlRequest<
            GetDatabaseServiceUsersQuery,
            GetDatabaseServiceUsersQueryVariables
          >(DATABASE_SERVICE_USERS_QUERY, { id: db.id })
          const user = databaseServiceUsers.find((u) => u.username === username)
          if (!user) {
            printError('Database user not found.')
            process.exit(1)
          }
          if (!(await confirmRotate(user.username, mode, options.yes === true))) {
            console.log('Rotation cancelled.')
            return
          }

          const spinner = ora(`Rotating "${sanitizeTerminal(user.username)}"...`).start()
          const data = await graphqlRequest<
            RotateDatabaseServiceUserMutation,
            RotateDatabaseServiceUserMutationVariables
          >(ROTATE_SERVICE_USER_MUTATION, {
            id: db.id,
            serviceUserId: user.id,
            mode,
          })
          const { success, message, deploymentId } = data.rotateDatabaseServiceUser
          if (!success || !deploymentId) {
            spinner.fail(message ?? 'There was an error while updating the database user.')
            process.exit(1)
          }

          const outcome = await waitForOperation(deploymentId)
          if (!outcome.ok) {
            spinner.fail(outcome.message || 'There was an error while updating the database user.')
            process.exit(1)
          }
          spinner.succeed(outcome.message)
        } catch (error) {
          printError(formatApiError(error))
          process.exit(1)
        }
      }
    )

  dbCmd
    .command('update')
    .description('Change a database server. Setting changes apply right away.')
    .argument('<server>', 'Database server slug')
    .option('--name <name>', 'New display name')
    .option('--size <size>', 'Provisioned servers. Restarts the server briefly.')
    .option('--storage <gb>', 'Storage in GB. It can only grow.')
    .option('--backup-days <days>', 'Days of automatic backups. 0 turns backups off.')
    .option('--high-availability', 'Add a standby copy in a second zone')
    .option('--no-high-availability', 'Remove the standby copy')
    .addOption(
      awsOption('--aws-min-capacity <acu>', 'Aurora Serverless minimum capacity, in steps of 0.5')
    )
    .addOption(
      awsOption('--aws-max-capacity <acu>', 'Aurora Serverless maximum capacity, in steps of 0.5')
    )
    .addOption(
      awsOption(
        '--aws-pause-after <seconds>',
        'Aurora Serverless with minimum 0: idle seconds before pausing'
      )
    )
    .addOption(awsOption('--aws-storage-type <type>', 'RDS storage: gp3, io1 or io2'))
    .addOption(awsOption('--aws-iops <iops>', 'RDS: required for io1 and io2 storage'))
    .addOption(awsOption('--aws-performance-insights', 'Turn Performance Insights on'))
    .addOption(awsOption('--aws-no-performance-insights', 'Turn Performance Insights off'))
    .addOption(awsOption('--aws-master-rotation', 'Let AWS rotate the master password'))
    .addOption(
      awsOption(
        '--aws-no-master-rotation',
        'Keep the master password in a Gantry secret that never rotates'
      )
    )
    .option('-y, --yes', 'Skip the confirmation prompt')
    .action(async (server: string, options: DatabaseUpdateOptions & { yes?: boolean }) => {
      try {
        const update = buildDatabaseUpdate(options)
        if (!update.ok) {
          printError(update.message)
          process.exit(1)
        }
        const db = await requireDatabase(server)
        const foreign = foreignAwsFlagsMessage(db.provider, options)
        if (foreign) {
          printError(foreign)
          process.exit(1)
        }
        if (update.warnings.length > 0 && options.yes !== true) {
          const warning = update.warnings.join(' ')
          if (!isInteractive()) {
            printError(`${warning} Re-run with --yes to confirm.`)
            process.exit(1)
          }
          console.log(warning)
          if (!(await confirm({ message: `Update "${db.slug}"?`, default: false }))) {
            console.log('Update cancelled.')
            return
          }
        }

        const data = await graphqlRequest<UpdateDatabaseMutation, UpdateDatabaseMutationVariables>(
          UPDATE_DATABASE_MUTATION,
          { id: db.id, input: update.input }
        )
        const { success, message, deploymentId } = data.updateDatabase
        if (!success) {
          printError(message ?? 'There was an error while updating the database.')
          process.exit(1)
        }
        printSuccess(message ?? 'Database updated.')
        if (deploymentId) {
          console.log(`  Deployment: ${deploymentId}`)
        }
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  dbCmd
    .command('tunnel')
    .description('Create a local tunnel to a database server')
    .argument('[slug]', 'Database slug')
    .option('--port <port>', 'Local port to expose')
    .option('--bastion <slug>', 'Bastion host slug')
    .option('--trust-host-key', 'Trust and record an unknown bastion host key without prompting')
    .action(async (slug?: string, options?: TunnelOptions) => {
      try {
        let db: Database

        if (slug) {
          const found = await findDatabase(slug)
          if (!found) {
            printError('Database not found.')
            process.exit(1)
          }
          db = found
        } else {
          const data = await graphqlRequest<GetDatabasesQuery, GetDatabasesQueryVariables>(
            DATABASES_QUERY
          )
          const activeDbs = data.databases.filter((d) => d.status.toLowerCase() === 'active')

          if (activeDbs.length === 0) {
            printError('No active databases found.')
            process.exit(1)
          }

          const isPublic = (d: Database) => d.publiclyAccessible

          const selectedId = await select({
            message: 'Select a database:',
            choices: activeDbs.map((d) => ({
              name: `${d.name} (${d.engine}) — ${d.slug} [${isPublic(d) ? 'public' : 'private'}]`,
              value: d.id,
            })),
          })

          const selected = activeDbs.find((d) => d.id === selectedId)
          if (!selected) {
            printError('Database not found.')
            process.exit(1)
          }
          db = selected
        }

        const isPublicDb = db.publiclyAccessible
        const remoteHost = db.endpoint?.split(':')[0] ?? ''

        if (!remoteHost) {
          printError('Database endpoint not available. The database may still be provisioning.')
          process.exit(1)
        }

        const remotePort = db.port ?? getDefaultPort(db.engine)

        if (isPublicDb && !options?.bastion) {
          const action = await select({
            message: 'This database is publicly accessible and can be connected to directly.',
            choices: [
              { name: 'Show direct connection details', value: 'details' },
              { name: 'Create a local tunnel anyway', value: 'tunnel' },
            ],
          })

          if (action === 'details') {
            const spinner = ora('Fetching credentials...').start()
            const credsData = await graphqlRequest<
              GetDatabaseCredentialsQuery,
              GetDatabaseCredentialsQueryVariables
            >(DATABASE_CREDENTIALS_QUERY, { id: db.id })

            const { success, message, username, password } = credsData.databaseCredentials
            if (!success || username === null || password === null) {
              spinner.fail(message ?? 'There was an error while loading the database credentials.')
              process.exit(1)
            }

            spinner.succeed('Connection details:')
            console.log(`  Host:     ${remoteHost}`)
            console.log(`  Port:     ${String(remotePort)}`)
            console.log(`  Username: ${username}`)
            console.log(`  Password: ${password}`)
            console.log(`  Engine:   ${sanitizeTerminal(db.engine)}`)
            return
          }
        }

        const localPort = options?.port
          ? parseInt(options.port, 10)
          : parseInt(
              await input({
                message: 'Local port to expose:',
                default: String(remotePort),
                validate: (v) => {
                  const n = parseInt(v, 10)
                  if (isNaN(n) || n < 1 || n > 65535) return 'Enter a valid port (1-65535)'
                  return true
                },
              }),
              10
            )

        if (isPublicDb && !options?.bastion) {
          const spinner = ora('Creating direct tunnel...').start()
          try {
            const tunnel = await openDirectTunnel({
              remoteHost,
              remotePort,
              localPort,
            })

            spinner.succeed('Tunnel connected')
            console.log(`  Host:     localhost`)
            console.log(`  Port:     ${String(tunnel.localPort)}`)
            console.log(`  Engine:   ${sanitizeTerminal(db.engine)}`)
            console.log(`  Database: ${sanitizeTerminal(remoteHost)}`)
            console.log('')
            console.log('  Press Ctrl+C to close the tunnel.')

            await new Promise<void>((resolve) => {
              let closing = false
              process.on('SIGINT', () => {
                void (async () => {
                  if (closing) return
                  closing = true
                  console.log('\n  Closing tunnel...')
                  await tunnel.close()
                  resolve()
                })()
              })
            })
            return
          } catch (error) {
            spinner.fail(
              `Failed to connect: ${error instanceof Error ? error.message : String(error)}`
            )
            process.exit(1)
          }
        }

        let bastionSlug: string

        if (options?.bastion) {
          bastionSlug = options.bastion
        } else {
          const result = await selectBastion({
            networkId: db.networkId,
            includeCreateOption: true,
            filter: activeOnly,
          })

          if (result === 'create') {
            const bastion = await createBastionInteractive({
              cloudAccountId: db.cloudAccountId,
              networkId: db.networkId,
              waitForActive: true,
            })
            bastionSlug = bastion.slug
          } else {
            bastionSlug = result.slug
          }
        }

        const spinner = ora('Connecting tunnel...').start()

        try {
          const credentials = await fetchBastionCredentials(bastionSlug)
          const bastionData = await graphqlRequest<
            GetDatabaseTunnelBastionQuery,
            GetDatabaseTunnelBastionQueryVariables
          >(
            /* GraphQL */ `
              query GetDatabaseTunnelBastion($slug: String!) {
                bastion(slug: $slug) {
                  id
                  publicIp
                }
              }
            `,
            {
              slug: bastionSlug,
            }
          )

          const { bastion } = bastionData
          const bastionIp = bastion?.publicIp
          if (!bastion || !bastionIp) {
            spinner.fail('Bastion host does not have a public IP address.')
            process.exit(1)
          }

          const tunnel = await openSshTunnel({
            bastionHost: bastionIp,
            bastionUsername: credentials.sshUser,
            hostKey: {
              hostId: bastionHostId({ id: bastion.id, publicIp: bastionIp }),
              label: bastionSlug,
              expectedFingerprint: credentials.hostKeyFingerprint,
              trustHostKey: options?.trustHostKey,
              pauseOutput: () => spinner.stop(),
              resumeOutput: () => spinner.start(),
            },
            privateKey: credentials.privateKey,
            remoteHost,
            remotePort,
            localPort,
          })

          spinner.succeed('Tunnel connected')
          console.log(`  Host:     localhost`)
          console.log(`  Port:     ${String(tunnel.localPort)}`)
          console.log(`  Engine:   ${sanitizeTerminal(db.engine)}`)
          console.log(`  Database: ${sanitizeTerminal(remoteHost)}`)
          console.log('')
          console.log('  Press Ctrl+C to close the tunnel.')

          await new Promise<void>((resolve) => {
            let closing = false
            process.on('SIGINT', () => {
              void (async () => {
                if (closing) return
                closing = true
                console.log('\n  Closing tunnel...')
                await tunnel.close()
                resolve()
              })()
            })
          })
        } catch (error) {
          spinner.fail(
            `Failed to connect: ${error instanceof Error ? error.message : String(error)}`
          )
          process.exit(1)
        }
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  withLogQueryOptions(
    dbCmd
      .command('logs')
      .description("Show a database's engine logs")
      .argument('<slug>', 'Database slug')
  ).action(async (slug: string, options: LogQueryOptions) => {
    let db: Database
    try {
      db = await requireDatabase(slug)
    } catch (error) {
      printError(formatApiError(error))
      process.exit(1)
    }

    await streamLogs(
      async (cursor) =>
        (
          await graphqlRequest<DatabaseLogsQuery, DatabaseLogsQueryVariables>(DATABASE_LOGS, {
            id: db.id,
            since: options.since,
            limit: options.limit,
            grep: options.grep,
            cursor,
          })
        ).databaseLogs,
      options.refresh === true,
      `No log lines for ${slug} in the last ${options.since}.`
    )
  })
}
