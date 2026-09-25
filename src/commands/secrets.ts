import { readFileSync } from 'fs'

import { confirm, input } from '@inquirer/prompts'
import type { Command } from 'commander'

import type {
  CreateSecretMutation,
  CreateSecretMutationVariables,
  DeleteSecretMutation,
  DeleteSecretMutationVariables,
  GetSecretKeysQuery,
  GetSecretKeysQueryVariables,
  GetSecretQuery,
  GetSecretQueryVariables,
  GetSecretsQuery,
  GetSecretsQueryVariables,
  UpdateSecretMutation,
  UpdateSecretMutationVariables,
} from '../generated/graphql'
import { formatApiError, graphqlRequest } from '../lib/client'
import { selectCloud, selectSecret } from '../lib/interactive-prompts'
import { createTable, formatDate, printError, printSuccess } from '../lib/output'
import { redact, sanitizeTerminal } from '../lib/sanitize'
import { readStdin } from '../lib/stdin'
import { isInteractive } from '../lib/terminal'

const SECRETS_QUERY = /* GraphQL */ `
  query GetSecrets($cloudAccountId: String) {
    secrets(cloudAccountId: $cloudAccountId) {
      id
      name
      description
      cloudAccountId
      createdAt
    }
  }
`

const SECRET_QUERY = /* GraphQL */ `
  query GetSecret($id: String!) {
    secret(id: $id) {
      id
      name
      description
      cloudAccountId
      createdAt
    }
  }
`

const CREATE_SECRET_MUTATION = /* GraphQL */ `
  mutation CreateSecret($input: CreateSecretInput!) {
    createSecret(input: $input) {
      success
      message
      secret {
        id
        name
        description
        cloudAccountId
        createdAt
      }
    }
  }
`

const SECRET_KEYS_QUERY = /* GraphQL */ `
  query GetSecretKeys($id: String!) {
    secret(id: $id) {
      id
      keys
    }
  }
`

const UPDATE_SECRET_MUTATION = /* GraphQL */ `
  mutation UpdateSecret($input: UpdateSecretInput!) {
    updateSecret(input: $input) {
      success
      message
    }
  }
`

const DELETE_SECRET_MUTATION = /* GraphQL */ `
  mutation DeleteSecret($id: String!) {
    deleteSecret(id: $id) {
      success
      message
    }
  }
`

const STDIN_PATH = '-'

const SET_HELP = 'Set key-value pair (repeatable; lands in shell history, prefer --from-file -)'

const FROM_FILE_HELP = 'Read secret values from a file (KEY=value per line), or - for stdin'

interface KeyValueEntry {
  text: string
  source: string
}

// Errors name only where the bad entry came from: the entry itself may be a secret.
function parseKeyValues(entries: KeyValueEntry[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const { text, source } of entries) {
    const eqIdx = text.indexOf('=')
    if (eqIdx <= 0) {
      throw new Error(`Invalid entry at ${source}. Expected KEY=value.`)
    }
    result[text.slice(0, eqIdx)] = text.slice(eqIdx + 1)
  }
  return result
}

function setFlagEntries(sets: string[]): KeyValueEntry[] {
  return sets.map((text, index) => ({ text, source: `--set #${String(index + 1)}` }))
}

const EXPORT_PREFIX = /^export\s+/

function fileEntries(content: string, sourceName: string): KeyValueEntry[] {
  return content
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .flatMap((line, index) =>
      line.trim() && !line.trimStart().startsWith('#')
        ? [
            {
              text: line.replace(EXPORT_PREFIX, ''),
              source: `${sourceName} line ${String(index + 1)}`,
            },
          ]
        : []
    )
}

async function readValuesFile(path: string): Promise<Record<string, string>> {
  if (path === STDIN_PATH) {
    return parseKeyValues(fileEntries(await readStdin(), 'stdin'))
  }
  return parseKeyValues(fileEntries(readFileSync(path, 'utf-8'), path))
}

function toKeyValuePairs(values: Record<string, string>): { key: string; value: string }[] {
  return Object.entries(values).map(([key, value]) => ({ key, value }))
}

function fail(message: string, submittedValues: readonly string[] = []): never {
  printError(redact(message, submittedValues))
  process.exit(1)
}

async function fetchRemovedKeys(
  secretId: string,
  values: Record<string, string>
): Promise<string[]> {
  const data = await graphqlRequest<GetSecretKeysQuery, GetSecretKeysQueryVariables>(
    SECRET_KEYS_QUERY,
    { id: secretId }
  )
  if (!data.secret) {
    fail('Secret not found.')
  }
  return data.secret.keys.filter((key) => !Object.hasOwn(values, key))
}

async function confirmKeyRemoval(removedKeys: string[], yes: boolean): Promise<boolean> {
  if (yes) return true
  const keyList = removedKeys.map((key) => sanitizeTerminal(key)).join(', ')
  if (!isInteractive()) {
    fail(
      `Update replaces all keys and would remove: ${keyList}. Re-run with --yes to confirm, or include those keys.`
    )
  }
  console.log(`Update replaces all keys. These keys will be removed: ${keyList}`)
  return confirm({ message: 'Remove these keys?', default: false })
}

export function registerSecretsCommand(program: Command): void {
  const secretsCmd = program.command('secrets').description('Manage secrets')

  secretsCmd
    .command('list')
    .description('List secrets')
    .option('--cloud <id>', 'Filter by cloud account ID')
    .action(async (options: { cloud?: string }) => {
      try {
        const variables: GetSecretsQueryVariables = {}
        if (options.cloud) variables.cloudAccountId = options.cloud

        const data = await graphqlRequest<GetSecretsQuery, GetSecretsQueryVariables>(
          SECRETS_QUERY,
          variables
        )
        const { secrets } = data

        if (secrets.length === 0) {
          console.log('No secrets found.')
          return
        }

        const table = createTable({
          head: ['ID', 'Name', 'Description', 'Cloud Account', 'Created'],
        })

        for (const secret of secrets) {
          table.push([
            secret.id,
            secret.name,
            secret.description ?? '-',
            secret.cloudAccountId,
            formatDate(secret.createdAt),
          ])
        }

        console.log(table.toString())
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  secretsCmd
    .command('show <id>')
    .description('Show secret details')
    .action(async (id: string) => {
      try {
        const data = await graphqlRequest<GetSecretQuery, GetSecretQueryVariables>(SECRET_QUERY, {
          id,
        })

        if (!data.secret) {
          printError(`Secret not found: ${id}`)
          process.exit(1)
        }

        const secret = data.secret
        console.log(`\nSecret: ${sanitizeTerminal(secret.name)}`)
        console.log(`  ID:            ${sanitizeTerminal(secret.id)}`)
        console.log(`  Description:   ${sanitizeTerminal(secret.description ?? '-')}`)
        console.log(`  Cloud Account: ${sanitizeTerminal(secret.cloudAccountId)}`)
        console.log(`  Created:       ${formatDate(secret.createdAt)}`)
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  secretsCmd
    .command('create')
    .description('Create a new secret')
    .option('--cloud <id>', 'Cloud account ID')
    .option('--name <name>', 'Secret name')
    .option('--description <text>', 'Description')
    .option(
      '--set <KEY=value>',
      SET_HELP,
      (val: string, prev: string[]) => [...prev, val],
      new Array<string>()
    )
    .option('--from-file <path>', FROM_FILE_HELP)
    .action(
      async (options: {
        cloud?: string
        name?: string
        description?: string
        set: string[]
        fromFile?: string
      }) => {
        let submittedValues: string[] = []
        try {
          const fromStdin = options.fromFile === STDIN_PATH
          if (fromStdin && (!options.cloud || !options.name)) {
            fail('--from-file - reads values from stdin, so --cloud and --name are required.')
          }

          const cloudAccountId = options.cloud ?? (await selectCloud())

          const name =
            options.name ??
            (await input({
              message: 'Secret name:',
              validate: (v) => (v.trim().length > 0 ? true : 'Name is required'),
            }))

          const description =
            (options.description ??
              (fromStdin
                ? ''
                : await input({
                    message: 'Description (optional, press Enter to skip):',
                  }))) ||
            undefined

          const values: Record<string, string> = options.fromFile
            ? await readValuesFile(options.fromFile)
            : {}

          if (options.set.length > 0) {
            Object.assign(values, parseKeyValues(setFlagEntries(options.set)))
          }
          submittedValues = Object.values(values)

          const data = await graphqlRequest<CreateSecretMutation, CreateSecretMutationVariables>(
            CREATE_SECRET_MUTATION,
            {
              input: {
                cloudAccountId,
                name,
                description,
                keyValuePairs: toKeyValuePairs(values),
              },
            }
          )

          const result = data.createSecret
          const secret = result.secret
          if (!result.success || !secret) {
            fail(result.message ?? 'Failed to create secret', submittedValues)
          }

          printSuccess(`Secret created: ${secret.name}`)
          console.log(`  ID: ${secret.id}`)
        } catch (error) {
          printError(formatApiError(error, submittedValues))
          process.exit(1)
        }
      }
    )

  secretsCmd
    .command('update [id]')
    .description(
      'Update a secret. Values given with --set or --from-file replace ALL existing keys; keys you omit are removed.'
    )
    .option('--description <text>', 'Update description')
    .option(
      '--set <KEY=value>',
      SET_HELP,
      (val: string, prev: string[]) => [...prev, val],
      new Array<string>()
    )
    .option('--from-file <path>', FROM_FILE_HELP)
    .option(
      '-y, --yes',
      'Confirm removing existing keys without prompting (required without a TTY)'
    )
    .action(
      async (
        id: string | undefined,
        options: {
          description?: string
          set: string[]
          fromFile?: string
          yes?: boolean
        }
      ) => {
        let submittedValues: string[] = []
        try {
          if (options.fromFile === STDIN_PATH && !id) {
            fail('--from-file - reads values from stdin, so the secret ID is required.')
          }

          const secretId = id ?? (await selectSecret())

          let values = options.fromFile ? await readValuesFile(options.fromFile) : undefined

          if (options.set.length > 0) {
            values = { ...(values ?? {}), ...parseKeyValues(setFlagEntries(options.set)) }
          }
          submittedValues = Object.values(values ?? {})

          if (values) {
            if (Object.keys(values).length === 0) {
              fail(
                'No secret values provided. Update replaces all keys, so at least one KEY=value is required.'
              )
            }
            const removedKeys = await fetchRemovedKeys(secretId, values)
            if (
              removedKeys.length > 0 &&
              !(await confirmKeyRemoval(removedKeys, options.yes ?? false))
            ) {
              console.log('Update cancelled. No changes were made.')
              return
            }
          }

          const data = await graphqlRequest<UpdateSecretMutation, UpdateSecretMutationVariables>(
            UPDATE_SECRET_MUTATION,
            {
              input: {
                id: secretId,
                description: options.description,
                keyValuePairs: values ? toKeyValuePairs(values) : undefined,
              },
            }
          )

          const result = data.updateSecret
          if (!result.success) {
            fail(result.message ?? 'Failed to update secret', submittedValues)
          }

          printSuccess('Secret updated successfully')
        } catch (error) {
          printError(formatApiError(error, submittedValues))
          process.exit(1)
        }
      }
    )

  secretsCmd
    .command('delete [id]')
    .description('Delete a secret')
    .action(async (id: string | undefined) => {
      try {
        const secretId = id ?? (await selectSecret())

        const data = await graphqlRequest<DeleteSecretMutation, DeleteSecretMutationVariables>(
          DELETE_SECRET_MUTATION,
          { id: secretId }
        )

        const result = data.deleteSecret
        if (!result.success) {
          printError(result.message ?? 'Failed to delete secret')
          process.exit(1)
        }

        printSuccess('Secret deleted successfully')
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })
}
