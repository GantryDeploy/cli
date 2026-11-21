import { spawn } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'

import type { Command } from 'commander'

import type { DestroyBastionMutation, DestroyBastionMutationVariables } from '../generated/graphql'
import type { Bastion } from '../lib/bastion-prompts'
import {
  activeOnly,
  createBastionInteractive,
  DESTROY_BASTION_MUTATION,
  fetchBastion,
  fetchBastionCredentials,
  fetchBastions,
  nonDestroyed,
  selectBastion,
} from '../lib/bastion-prompts'
import { privateBastionTransport } from '../lib/bastion-transports'
import { formatApiError, graphqlRequest } from '../lib/client'
import { createTable, formatDate, printError, printSuccess } from '../lib/output'
import { sanitizeTerminal } from '../lib/sanitize'

import { joinCommand } from './shell'

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

function assertEd25519PublicKey(hostPublicKey: string): void {
  if (!/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/.test(hostPublicKey)) {
    throw new Error('The bastion host key returned by the API is not a valid ed25519 key.')
  }
}

/** How `ssh` reaches a bastion: its public address, or the bastion's slug through `gantry bastions proxy`. */
export interface SshRoute {
  host: string
  proxyCommand: string | null
}

export function sshRoute(bastion: Pick<Bastion, 'slug' | 'publicAccess' | 'publicIp'>): SshRoute {
  if (bastion.publicAccess) {
    if (!bastion.publicIp) throw new Error('Bastion host does not have a public IP address yet.')
    return { host: bastion.publicIp, proxyCommand: null }
  }
  return { host: bastion.slug, proxyCommand: `gantry bastions proxy ${bastion.slug}` }
}

export function manualConnectHints(
  keyFile: string,
  route: SshRoute,
  sshUser: string,
  hostPublicKey: string | null
): string[] {
  const hint = (label: string, command: string) => `  ${`${label}:`.padEnd(17)}${command}`
  const proxy = route.proxyCommand ? ` -o ProxyCommand='${route.proxyCommand}'` : ''
  if (!hostPublicKey) {
    return [hint('Connect', `ssh -i ${keyFile}${proxy} ${sshUser}@${route.host}`)]
  }

  assertEd25519PublicKey(hostPublicKey)
  return [
    hint('Trust host key', `echo '${route.host} ${hostPublicKey}' >> ~/.ssh/known_hosts`),
    hint(
      'Connect',
      `ssh -i ${keyFile}${proxy} -o StrictHostKeyChecking=yes -o HostKeyAlgorithms=ssh-ed25519 ${sshUser}@${route.host}`
    ),
  ]
}

/** Runs this same CLI as the ProxyCommand, so it works without `gantry` on PATH. */
export function selfProxyCommand(slug: string): string {
  return joinCommand([process.execPath, process.argv[1], 'bastions', 'proxy', slug])
}

/**
 * With a host key from the API, pin `ssh` to it through a known_hosts file
 * beside the temporary private key (removed with it). Without one, the bastion
 * predates recorded host keys and `ssh` falls back to trust on first use.
 */
export function hostKeyCheckingArgs(
  keyPath: string,
  host: string,
  hostPublicKey: string | null
): string[] {
  if (!hostPublicKey) return ['-o', 'StrictHostKeyChecking=accept-new']

  assertEd25519PublicKey(hostPublicKey)
  const knownHostsPath = join(dirname(keyPath), 'known_hosts')
  writeFileSync(knownHostsPath, `${host} ${hostPublicKey}\n`, { mode: 0o600, flag: 'wx' })
  return [
    '-o',
    `UserKnownHostsFile=${knownHostsPath}`,
    '-o',
    'GlobalKnownHostsFile=/dev/null',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'HostKeyAlgorithms=ssh-ed25519',
  ]
}

interface CreateBastionOptions {
  cloud?: string
  network?: string
  name?: string
  slug?: string
  public?: boolean
  allowCidr?: string[]
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
          head: ['Slug', 'Name', 'Status', 'Access', 'Created'],
        })

        for (const bastion of bastions) {
          table.push([
            bastion.slug,
            bastion.name,
            bastion.status.toUpperCase(),
            bastion.publicAccess ? (bastion.publicIp ?? 'public') : 'private',
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
    .command('ssh')
    .argument('[slug]', 'Bastion slug (prompts to pick one when omitted)')
    .description('Connect to a bastion host via SSH')
    .option('-u, --user <user>', "SSH username (defaults to the bastion's user)")
    .action(async (slug: string | undefined, options: { user?: string }) => {
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

        const route = sshRoute(bastion)
        if (route.proxyCommand) privateBastionTransport(bastion.provider).assertReady()

        const credentials = await fetchBastionCredentials(bastion.slug)

        const { keyPath, cleanup } = createTempKeyFile(credentials.privateKey)

        console.log(
          `Connecting to ${sanitizeTerminal(bastion.name)} (${sanitizeTerminal(route.host)})...`
        )

        let sshProcess: ReturnType<typeof spawn>
        try {
          sshProcess = spawn(
            'ssh',
            [
              '-i',
              keyPath,
              ...(route.proxyCommand
                ? ['-o', `ProxyCommand=${selfProxyCommand(bastion.slug)}`]
                : []),
              ...hostKeyCheckingArgs(keyPath, route.host, credentials.hostPublicKey),
              `${options.user ?? credentials.sshUser}@${route.host}`,
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
    .command('key')
    .argument('[slug]', 'Bastion slug (prompts to pick one when omitted)')
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

        const { privateKey, sshUser, hostPublicKey } = await fetchBastionCredentials(bastion.slug)
        const keyFile = options.output ? resolve(options.output) : `~/.ssh/${bastion.slug}.pem`
        const connectHints =
          bastion.publicAccess && !bastion.publicIp
            ? []
            : manualConnectHints(keyFile, sshRoute(bastion), sshUser, hostPublicKey)

        if (options.output) {
          const outputPath = keyFile
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
          connectHints.forEach((line) => {
            console.error(line)
          })
          return
        }

        console.log(privateKey)

        console.error('')
        console.error('Usage:')
        console.error(`  Save to file:    gantry bastions key ${bastion.slug} --output ${keyFile}`)
        console.error(
          `  Or via stdout:   (umask 077; gantry bastions key ${bastion.slug} > ${keyFile})`
        )
        connectHints.forEach((line) => {
          console.error(line)
        })
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  bastionsCmd
    .command('proxy')
    .argument('<slug>', 'Bastion slug')
    .description(
      "Connect stdin and stdout to a private bastion's SSH port, for use as an ssh ProxyCommand"
    )
    .action(async (slug: string) => {
      // stdout carries the SSH stream, so every message goes to stderr.
      let exitCode: number
      try {
        const bastion = await fetchBastion(slug)
        if (!bastion) throw new Error(`Bastion host not found: ${slug}`)
        exitCode = await privateBastionTransport(bastion.provider).proxy(slug)
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
      process.exit(exitCode)
    })

  bastionsCmd
    .command('create')
    .description('Create a new bastion host')
    .option('--cloud <id>', 'Cloud account ID')
    .option('--network <id>', 'Network ID')
    .option('--name <name>', 'Bastion name')
    .option('--slug <slug>', 'Bastion slug (auto-generated from name if omitted)')
    .option(
      '--public',
      'Give the bastion a public address that takes SSH. Without it the bastion has no inbound access and is reached through the CLI. Fixed at create.'
    )
    .option(
      '--allow-cidr <cidr>',
      'CIDR block allowed to SSH to a public bastion (repeatable; default: any address)',
      (cidr: string, previous: string[] | undefined) => [...(previous ?? []), cidr]
    )
    .action(async (options: CreateBastionOptions) => {
      if (options.allowCidr && !options.public) {
        printError('--allow-cidr applies only with --public.')
        process.exit(1)
      }
      try {
        const bastion = await createBastionInteractive({
          cloudAccountId: options.cloud,
          networkId: options.network,
          name: options.name,
          slug: options.slug,
          waitForActive: false,
          publicAccess: options.public === true,
          allowedCidrs: options.allowCidr,
        })

        printSuccess(`Bastion created: ${bastion.name} (${bastion.slug})`)
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  bastionsCmd
    .command('destroy')
    .argument('[slug]', 'Bastion slug (prompts to pick one when omitted)')
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
