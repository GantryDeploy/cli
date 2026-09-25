import { spawn } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

import type { Command } from 'commander'

import type { DestroyBastionMutation, DestroyBastionMutationVariables } from '../generated/graphql'
import type { Bastion } from '../lib/bastion-prompts'
import {
  activeOnly,
  createBastionInteractive,
  DESTROY_BASTION_MUTATION,
  fetchBastion,
  fetchBastionPrivateKey,
  fetchBastions,
  nonDestroyed,
  selectBastion,
} from '../lib/bastion-prompts'
import { formatApiError, graphqlRequest } from '../lib/client'
import { createTable, formatDate, printError, printSuccess } from '../lib/output'
import { sanitizeTerminal } from '../lib/sanitize'

interface TempKeyFile {
  keyPath: string
  cleanup: () => void
}

export function createTempKeyFile(privateKey: string): TempKeyFile {
  const dir = mkdtempSync(join(tmpdir(), 'gantry-bastion-'))
  const keyPath = join(dir, 'key.pem')
  let cleaned = false

  const onSignal = (signal: NodeJS.Signals): void => {
    cleanup()
    process.kill(process.pid, signal)
  }

  const cleanup = (): void => {
    if (cleaned) return
    cleaned = true
    process.off('exit', cleanup)
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    rmSync(dir, { recursive: true, force: true })
  }

  process.on('exit', cleanup)
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  try {
    writeFileSync(keyPath, privateKey, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    cleanup()
    throw error
  }

  return { keyPath, cleanup }
}

function withTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`
}

function isFileExistsError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

export function registerBastionsCommand(program: Command): void {
  const bastionsCmd = program.command('bastions').description('Manage bastion hosts')

  bastionsCmd
    .command('list')
    .description('List all bastion hosts')
    .action(async () => {
      try {
        const bastions = await fetchBastions()

        if (bastions.length === 0) {
          console.log('No bastion hosts found.')
          return
        }

        const table = createTable({
          head: ['Slug', 'Name', 'Status', 'Public IP', 'Created'],
        })

        for (const bastion of bastions) {
          table.push([
            bastion.slug,
            bastion.name,
            bastion.status.toUpperCase(),
            bastion.publicIp ?? '—',
            formatDate(bastion.createdAt),
          ])
        }

        console.log(table.toString())
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  bastionsCmd
    .command('ssh [slug]')
    .description('Connect to a bastion host via SSH')
    .option('-u, --user <user>', 'SSH username', 'ec2-user')
    .action(async (slug: string | undefined, options: { user: string }) => {
      try {
        let bastion: Bastion

        if (slug) {
          const result = await fetchBastion(slug)
          if (!result) {
            printError(`Bastion host not found: ${slug}`)
            process.exit(1)
          }
          bastion = result
        } else {
          const result = await selectBastion({ filter: activeOnly })
          if (result === 'create') {
            printError('Cannot SSH into a bastion that does not exist yet.')
            process.exit(1)
          }
          bastion = result
        }

        if (bastion.status.toLowerCase() !== 'active') {
          printError(`Bastion host is not active. Current status: ${bastion.status}`)
          process.exit(1)
        }

        const { publicIp } = bastion
        if (!publicIp) {
          printError('Bastion host does not have a public IP address yet.')
          process.exit(1)
        }

        const privateKey = await fetchBastionPrivateKey(bastion.slug)

        const { keyPath, cleanup } = createTempKeyFile(privateKey)

        console.log(
          `Connecting to ${sanitizeTerminal(bastion.name)} (${sanitizeTerminal(publicIp)})...`
        )

        let sshProcess: ReturnType<typeof spawn>
        try {
          sshProcess = spawn(
            'ssh',
            [
              '-i',
              keyPath,
              '-o',
              'StrictHostKeyChecking=accept-new',
              `${options.user}@${publicIp}`,
            ],
            {
              stdio: 'inherit',
            }
          )
        } catch (error) {
          cleanup()
          throw error
        }

        sshProcess.on('close', (code) => {
          cleanup()
          process.exit(code ?? 0)
        })

        sshProcess.on('error', (err) => {
          cleanup()
          printError(`SSH connection failed: ${err.message}`)
          process.exit(1)
        })
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  bastionsCmd
    .command('key [slug]')
    .description('Display the SSH private key for a bastion host')
    .option('-o, --output <path>', 'Write the key to a new file (mode 0600) instead of stdout')
    .action(async (slug: string | undefined, options: { output?: string }) => {
      try {
        let bastion: Bastion

        if (slug) {
          const result = await fetchBastion(slug)
          if (!result) {
            printError(`Bastion host not found: ${slug}`)
            process.exit(1)
          }
          bastion = result
        } else {
          const result = await selectBastion()
          if (result === 'create') {
            printError('Cannot retrieve a key for a bastion that does not exist yet.')
            process.exit(1)
          }
          bastion = result
        }

        const privateKey = await fetchBastionPrivateKey(bastion.slug)
        const { publicIp } = bastion

        if (options.output) {
          const outputPath = resolve(options.output)
          try {
            writeFileSync(outputPath, withTrailingNewline(privateKey), {
              mode: 0o600,
              flag: 'wx',
            })
          } catch (error) {
            printError(
              isFileExistsError(error)
                ? `File already exists: ${outputPath}`
                : `Could not write the key to ${outputPath}`
            )
            process.exit(1)
          }

          printSuccess(`Private key written to ${outputPath}`)
          if (publicIp) {
            console.error(`  Connect: ssh -i ${outputPath} ec2-user@${publicIp}`)
          }
          return
        }

        console.log(privateKey)

        const keyFile = `~/.ssh/${bastion.slug}.pem`
        console.error('')
        console.error('Usage:')
        console.error(`  Save to file:    gantry bastions key ${bastion.slug} --output ${keyFile}`)
        console.error(
          `  Or via stdout:   (umask 077; gantry bastions key ${bastion.slug} > ${keyFile})`
        )

        if (publicIp) {
          console.error(`  Connect:         ssh -i ${keyFile} ec2-user@${publicIp}`)
        }
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  bastionsCmd
    .command('create')
    .description('Create a new bastion host')
    .option('--cloud <id>', 'Cloud account ID')
    .option('--network <id>', 'Network ID (must have public subnets)')
    .option('--name <name>', 'Bastion name')
    .option('--slug <slug>', 'Bastion slug (auto-generated from name if omitted)')
    .action(async (options: { cloud?: string; network?: string; name?: string; slug?: string }) => {
      try {
        const bastion = await createBastionInteractive({
          cloudAccountId: options.cloud,
          networkId: options.network,
          name: options.name,
          slug: options.slug,
          waitForActive: false,
        })

        printSuccess(`Bastion created: ${bastion.name} (${bastion.slug})`)
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  bastionsCmd
    .command('destroy [slug]')
    .description('Destroy a bastion host')
    .action(async (slug: string | undefined) => {
      try {
        let targetSlug: string

        if (slug) {
          targetSlug = slug
        } else {
          const result = await selectBastion({ filter: nonDestroyed })
          if (result === 'create') {
            printError('Cannot destroy a bastion that does not exist yet.')
            process.exit(1)
          }
          targetSlug = result.slug
        }

        const data = await graphqlRequest<DestroyBastionMutation, DestroyBastionMutationVariables>(
          DESTROY_BASTION_MUTATION,
          { slug: targetSlug }
        )

        const result = data.destroyBastion
        if (!result.success) {
          printError(result.message ?? 'Failed to destroy bastion')
          process.exit(1)
        }

        printSuccess(`Bastion destruction initiated: ${targetSlug}`)
        if (result.deploymentId) {
          console.log(`  Deployment: ${result.deploymentId}`)
        }
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })
}
