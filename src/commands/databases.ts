import { input, select } from '@inquirer/prompts'
import type { Command } from 'commander'
import ora from 'ora'

import type {
  CreateDatabaseMutation,
  CreateDatabaseMutationVariables,
  GetDatabaseCredentialsQuery,
  GetDatabaseCredentialsQueryVariables,
  GetDatabaseEngineVersionsQuery,
  GetDatabaseEngineVersionsQueryVariables,
  GetDatabaseInstanceClassesQuery,
  GetDatabaseInstanceClassesQueryVariables,
  GetDatabasesQuery,
  GetDatabasesQueryVariables,
  GetDatabaseTunnelBastionQuery,
  GetDatabaseTunnelBastionQueryVariables,
  GetDatabaseTypesQuery,
  GetDatabaseTypesQueryVariables,
} from '../generated/graphql'
import {
  activeOnly,
  createBastionInteractive,
  fetchBastionCredentials,
  selectBastion,
} from '../lib/bastion-prompts'
import { formatApiError, graphqlRequest } from '../lib/client'
import {
  getDefaultPort,
  normalizeEngine,
  toCatalogEngine,
  toDatabaseEngineEnum,
} from '../lib/engine'
import { selectCloud, selectNetwork } from '../lib/interactive-prompts'
import { bastionHostId } from '../lib/known-hosts'
import { createTable, formatDate, printError, printSuccess, slugify } from '../lib/output'
import { sanitizeTerminal } from '../lib/sanitize'
import { openDirectTunnel, openSshTunnel } from '../lib/ssh-tunnel'

type Database = GetDatabasesQuery['databases'][number]

interface TunnelOptions {
  port?: string
  bastion?: string
  trustHostKey?: boolean
}

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
  query GetDatabaseTypes($provider: String) {
    databaseTypes(provider: $provider) {
      type
      displayName
      provider
      description
      guidance
      supportsServerless
      requiresNetwork
    }
  }
`

const DATABASE_ENGINE_VERSIONS_QUERY = /* GraphQL */ `
  query GetDatabaseEngineVersions($engine: String, $deploymentMode: String, $region: String) {
    databaseEngineVersions(engine: $engine, deploymentMode: $deploymentMode, region: $region) {
      engine
      version
      family
      description
      supportedModes
    }
  }
`

const DATABASE_INSTANCE_CLASSES_QUERY = /* GraphQL */ `
  query GetDatabaseInstanceClasses($engine: String, $region: String) {
    databaseInstanceClasses(engine: $engine, region: $region) {
      instanceClass
      family
      size
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
    .description('List available database engines')
    .action(async () => {
      try {
        const data = await graphqlRequest<GetDatabaseTypesQuery, GetDatabaseTypesQueryVariables>(
          DATABASE_TYPES_QUERY
        )

        const table = createTable({
          head: ['Engine', 'Name', 'Description', 'Serverless'],
        })

        for (const t of data.databaseTypes) {
          table.push([t.type, t.displayName, t.description, t.supportsServerless ? 'Yes' : 'No'])
        }

        console.log(table.toString())
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  dbCmd
    .command('engine-versions')
    .description('List available database engine versions')
    .option('--engine <engine>', 'Filter by engine')
    .option('--region <region>', 'Filter by region')
    .option('--mode <mode>', 'Filter by deployment mode (provisioned, serverless)')
    .action(async (options: { engine?: string; region?: string; mode?: string }) => {
      try {
        const variables: GetDatabaseEngineVersionsQueryVariables = {}
        if (options.engine) variables.engine = toCatalogEngine(options.engine)
        if (options.region) variables.region = options.region
        if (options.mode) variables.deploymentMode = options.mode

        const data = await graphqlRequest<
          GetDatabaseEngineVersionsQuery,
          GetDatabaseEngineVersionsQueryVariables
        >(DATABASE_ENGINE_VERSIONS_QUERY, variables)

        if (data.databaseEngineVersions.length === 0) {
          console.log('No engine versions found matching the filters.')
          return
        }

        const table = createTable({
          head: ['Engine', 'Version', 'Family', 'Modes', 'Description'],
        })

        for (const v of data.databaseEngineVersions) {
          table.push([v.engine, v.version, v.family, v.supportedModes.join(', '), v.description])
        }

        console.log(table.toString())
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  dbCmd
    .command('instance-classes')
    .description('List available database instance classes')
    .option('--engine <engine>', 'Filter by engine')
    .option('--region <region>', 'Filter by region')
    .action(async (options: { engine?: string; region?: string }) => {
      try {
        const variables: GetDatabaseInstanceClassesQueryVariables = {}
        if (options.engine) variables.engine = toCatalogEngine(options.engine)
        if (options.region) variables.region = options.region

        const data = await graphqlRequest<
          GetDatabaseInstanceClassesQuery,
          GetDatabaseInstanceClassesQueryVariables
        >(DATABASE_INSTANCE_CLASSES_QUERY, variables)

        if (data.databaseInstanceClasses.length === 0) {
          console.log('No instance classes found matching the filters.')
          return
        }

        const table = createTable({
          head: ['Instance Class', 'Family', 'Size', 'vCPU', 'Memory (MB)'],
        })

        for (const ic of data.databaseInstanceClasses) {
          table.push([ic.instanceClass, ic.family, ic.size, String(ic.vcpu), String(ic.memoryMb)])
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
    .option('--engine <engine>', 'Database engine (see "gantry db engines")')
    .option('--instance-class <class>', 'Instance class (see "gantry db instance-classes")')
    .option('--engine-version <version>', 'Engine version (see "gantry db engine-versions")')
    .option('--serverless', 'Use serverless mode (Aurora only)')
    .action(
      async (options: {
        cloud?: string
        network?: string
        name?: string
        slug?: string
        engine?: string
        instanceClass?: string
        engineVersion?: string
        serverless?: boolean
      }) => {
        try {
          const cloudAccountId = options.cloud ?? (await selectCloud())
          const networkId = options.network ?? (await selectNetwork(cloudAccountId))
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

          let selectedEngine = options.engine
          if (!selectedEngine) {
            const enginesData = await graphqlRequest<
              GetDatabaseTypesQuery,
              GetDatabaseTypesQueryVariables
            >(DATABASE_TYPES_QUERY)

            selectedEngine = await select({
              message: 'Database engine:',
              choices: enginesData.databaseTypes.map((t) => ({
                name: `${t.displayName} — ${t.description}`,
                value: t.type,
              })),
            })
          }
          const engine = toDatabaseEngineEnum(selectedEngine)

          let useServerless = options.serverless ?? false
          if (!options.serverless && options.serverless === undefined) {
            const enginesData = await graphqlRequest<
              GetDatabaseTypesQuery,
              GetDatabaseTypesQueryVariables
            >(DATABASE_TYPES_QUERY)
            const engineInfo = enginesData.databaseTypes.find(
              (t) => normalizeEngine(t.type) === normalizeEngine(engine)
            )
            if (engineInfo?.supportsServerless) {
              useServerless = await select({
                message: 'Use serverless mode?',
                choices: [
                  { name: 'No', value: false },
                  { name: 'Yes', value: true },
                ],
              })
            }
          }

          let engineVersion = options.engineVersion
          if (!engineVersion) {
            const mode = useServerless ? 'serverless' : 'provisioned'
            const versionsData = await graphqlRequest<
              GetDatabaseEngineVersionsQuery,
              GetDatabaseEngineVersionsQueryVariables
            >(DATABASE_ENGINE_VERSIONS_QUERY, {
              engine: toCatalogEngine(engine),
              deploymentMode: mode,
            })

            if (versionsData.databaseEngineVersions.length > 0) {
              engineVersion = await select({
                message: 'Engine version:',
                choices: versionsData.databaseEngineVersions.map((v) => ({
                  name: `${v.version} (${v.family}) — ${v.description}`,
                  value: v.version,
                })),
              })
            }
          }

          let instanceClass = options.instanceClass
          if (!instanceClass && !useServerless) {
            const classesData = await graphqlRequest<
              GetDatabaseInstanceClassesQuery,
              GetDatabaseInstanceClassesQueryVariables
            >(DATABASE_INSTANCE_CLASSES_QUERY, { engine: toCatalogEngine(engine) })

            if (classesData.databaseInstanceClasses.length > 0) {
              instanceClass = await select({
                message: 'Instance class:',
                choices: classesData.databaseInstanceClasses.map((ic) => ({
                  name: `${ic.instanceClass} — ${String(ic.vcpu)} vCPU, ${String(ic.memoryMb)} MB RAM`,
                  value: ic.instanceClass,
                })),
              })
            }
          }

          // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty --slug string should fall back to a slug derived from the name, not be used verbatim
          const slug = options.slug || slugify(name)
          const providerData: Record<string, unknown> = {
            deploymentMode: useServerless ? 'serverless' : 'provisioned',
          }
          if (instanceClass) providerData.instanceClass = instanceClass
          if (engineVersion) providerData.engineVersion = engineVersion

          const data = await graphqlRequest<
            CreateDatabaseMutation,
            CreateDatabaseMutationVariables
          >(CREATE_DATABASE_MUTATION, {
            input: {
              cloudAccountId,
              networkId,
              name,
              slug,
              engine,
              providerData,
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

          const isPublic = (d: Database) => d.publiclyAccessible === true

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

        const isPublicDb = db.publiclyAccessible === true
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
                  instanceId
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
            hostKey: {
              hostId: bastionHostId(bastion),
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
}
