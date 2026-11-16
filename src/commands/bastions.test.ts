import { EventEmitter } from 'events'
import { join, resolve } from 'path'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

import type { Bastion } from '../lib/bastion-prompts'

const fsMocks = vi.hoisted(() => ({
  mkdtempSync: vi.fn(),
  rmSync: vi.fn(),
  writeFileSync: vi.fn(),
}))

const spawnMock = vi.hoisted(() => vi.fn())

const promptMocks = vi.hoisted(() => ({
  activeOnly: vi.fn(),
  createBastionInteractive: vi.fn(),
  fetchBastion: vi.fn(),
  fetchBastionCredentials: vi.fn(),
  fetchBastions: vi.fn(),
  nonDestroyed: vi.fn(),
  selectBastion: vi.fn(),
}))

const graphqlRequest = vi.hoisted(() => vi.fn())
const sessionMocks = vi.hoisted(() => ({
  proxySession: vi.fn(),
  startBastionSession: vi.fn(),
}))
const sessionPluginInstalled = vi.hoisted(() => vi.fn())

vi.mock('fs', () => fsMocks)
vi.mock('../lib/bastion-session', () => sessionMocks)
vi.mock('../lib/session-plugin', () => ({
  PLUGIN_MISSING_MESSAGE: 'session-manager-plugin was not found.',
  sessionPluginInstalled,
}))
vi.mock('child_process', () => ({ spawn: spawnMock }))
vi.mock('../lib/bastion-prompts', () => ({
  ...promptMocks,
  DESTROY_BASTION_MUTATION: 'mutation DestroyBastion',
}))
vi.mock('../lib/client', () => ({
  formatApiError: (error: unknown) => (error instanceof Error ? error.message : 'API error'),
  graphqlRequest,
}))

const { createTempKeyFile, registerBastionsCommand, selfProxyCommand } = await import('./bastions')

const TEMP_DIR = '/tmp/gantry-bastion-abc123'
const PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END OPENSSH PRIVATE KEY-----'

const bastion = {
  slug: 'edge',
  name: 'Edge',
  status: 'active',
  publicAccess: true,
  publicIp: '203.0.113.10',
} as unknown as Bastion

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

function fakeChild(): EventEmitter {
  return new EventEmitter()
}

async function run(args: string[]): Promise<void> {
  const program = new Command()
  program.exitOverride()
  registerBastionsCommand(program)
  await program.parseAsync(['node', 'gantry', 'bastions', ...args])
}

function listenerCounts(): Record<string, number> {
  return {
    exit: process.listenerCount('exit'),
    SIGINT: process.listenerCount('SIGINT'),
    SIGTERM: process.listenerCount('SIGTERM'),
  }
}

describe('bastions command', () => {
  let exitSpy: MockInstance
  let errorSpy: MockInstance
  let initialListeners: Record<string, number>

  beforeEach(() => {
    vi.clearAllMocks()
    initialListeners = listenerCounts()
    fsMocks.mkdtempSync.mockReturnValue(TEMP_DIR)
    promptMocks.fetchBastion.mockResolvedValue(bastion)
    promptMocks.fetchBastionCredentials.mockResolvedValue({
      privateKey: PRIVATE_KEY,
      sshUser: 'ec2-user',
      hostPublicKey: null,
      hostKeyFingerprint: null,
    })
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitError(code as number | undefined)
    })
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('createTempKeyFile', () => {
    it('writes the key into a fresh private directory with wx and 0600', () => {
      const { keyPath, cleanup } = createTempKeyFile(PRIVATE_KEY)

      expect(fsMocks.mkdtempSync).toHaveBeenCalledWith(expect.stringMatching(/gantry-bastion-$/))
      expect(keyPath).toBe(join(TEMP_DIR, 'key.pem'))
      expect(fsMocks.writeFileSync).toHaveBeenCalledWith(keyPath, PRIVATE_KEY, {
        mode: 0o600,
        flag: 'wx',
      })

      cleanup()
    })

    it('removes the directory and its listeners on cleanup, only once', () => {
      const { cleanup } = createTempKeyFile(PRIVATE_KEY)
      expect(process.listenerCount('SIGINT')).toBe(initialListeners.SIGINT + 1)

      cleanup()
      cleanup()

      expect(fsMocks.rmSync).toHaveBeenCalledTimes(1)
      expect(fsMocks.rmSync).toHaveBeenCalledWith(TEMP_DIR, { recursive: true, force: true })
      expect(listenerCounts()).toEqual(initialListeners)
    })

    it.each(['SIGINT', 'SIGTERM'] as const)(
      'cleans up and re-raises %s so the process still terminates',
      (signal) => {
        const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
        createTempKeyFile(PRIVATE_KEY)

        process.emit(signal, signal)

        expect(fsMocks.rmSync).toHaveBeenCalledWith(TEMP_DIR, { recursive: true, force: true })
        expect(listenerCounts()).toEqual(initialListeners)
        expect(killSpy).toHaveBeenCalledWith(process.pid, signal)
      }
    )

    it('cleans up on process exit', () => {
      createTempKeyFile(PRIVATE_KEY)

      process.emit('exit', 0)

      expect(fsMocks.rmSync).toHaveBeenCalledWith(TEMP_DIR, { recursive: true, force: true })
      expect(listenerCounts()).toEqual(initialListeners)
    })

    it('cleans up and rethrows when the key cannot be written', () => {
      fsMocks.writeFileSync.mockImplementationOnce(() => {
        throw new Error('EEXIST')
      })

      expect(() => createTempKeyFile(PRIVATE_KEY)).toThrow('EEXIST')
      expect(fsMocks.rmSync).toHaveBeenCalledWith(TEMP_DIR, { recursive: true, force: true })
      expect(listenerCounts()).toEqual(initialListeners)
    })
  })

  describe('ssh', () => {
    it('passes the temp key to ssh and removes it when ssh closes', async () => {
      const child = fakeChild()
      spawnMock.mockReturnValue(child)

      await run(['ssh', 'edge'])

      expect(spawnMock).toHaveBeenCalledWith(
        'ssh',
        expect.arrayContaining(['-i', join(TEMP_DIR, 'key.pem'), 'ec2-user@203.0.113.10']),
        { stdio: 'inherit' }
      )
      expect(fsMocks.rmSync).not.toHaveBeenCalled()

      expect(() => child.emit('close', 0)).toThrow(ExitError)
      expect(fsMocks.rmSync).toHaveBeenCalledWith(TEMP_DIR, { recursive: true, force: true })
      expect(exitSpy).toHaveBeenCalledWith(0)
      expect(listenerCounts()).toEqual(initialListeners)
    })

    it('removes the key when ssh fails to start', async () => {
      const child = fakeChild()
      spawnMock.mockReturnValue(child)

      await run(['ssh', 'edge'])

      expect(() => child.emit('error', new Error('ENOENT'))).toThrow(ExitError)
      expect(fsMocks.rmSync).toHaveBeenCalledWith(TEMP_DIR, { recursive: true, force: true })
      expect(exitSpy).toHaveBeenCalledWith(1)
      expect(listenerCounts()).toEqual(initialListeners)
    })

    it('reaches a private bastion by slug through this CLI as the ProxyCommand', async () => {
      spawnMock.mockReturnValue(fakeChild())
      sessionPluginInstalled.mockReturnValue(true)
      promptMocks.fetchBastion.mockResolvedValueOnce({
        ...bastion,
        publicAccess: false,
        publicIp: null,
      })

      await run(['ssh', 'edge'])

      const args = spawnMock.mock.calls[0]?.[1] as string[]
      expect(args).toContain(`ProxyCommand=${selfProxyCommand('edge')}`)
      expect(args.at(-1)).toBe('ec2-user@edge')
    })

    it('quotes a CLI path holding spaces in the ProxyCommand', () => {
      const { argv, execPath } = process
      process.argv = ['node', '/Users/ops team/.npm/bin/gantry']
      Object.defineProperty(process, 'execPath', { value: '/usr/local/bin/node' })
      try {
        expect(selfProxyCommand('edge')).toBe(
          "/usr/local/bin/node '/Users/ops team/.npm/bin/gantry' bastions proxy edge"
        )
      } finally {
        process.argv = argv
        Object.defineProperty(process, 'execPath', { value: execPath })
      }
    })

    it('refuses a private bastion without the session plugin, before fetching its key', async () => {
      sessionPluginInstalled.mockReturnValue(false)
      promptMocks.fetchBastion.mockResolvedValueOnce({
        ...bastion,
        publicAccess: false,
        publicIp: null,
      })

      await expect(run(['ssh', 'edge'])).rejects.toThrow(ExitError)

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('session-manager-plugin was not found.')
      )
      expect(promptMocks.fetchBastionCredentials).not.toHaveBeenCalled()
      expect(spawnMock).not.toHaveBeenCalled()
    })

    it('removes the key when spawn throws synchronously', async () => {
      spawnMock.mockImplementation(() => {
        throw new Error('spawn failed')
      })

      await expect(run(['ssh', 'edge'])).rejects.toThrow(ExitError)

      expect(fsMocks.rmSync).toHaveBeenCalledWith(TEMP_DIR, { recursive: true, force: true })
      expect(exitSpy).toHaveBeenCalledWith(1)
      expect(listenerCounts()).toEqual(initialListeners)
    })
  })

  describe('key', () => {
    it('writes the key to --output with wx and 0600', async () => {
      await run(['key', 'edge', '--output', 'edge.pem'])

      expect(fsMocks.writeFileSync).toHaveBeenCalledWith(resolve('edge.pem'), `${PRIVATE_KEY}\n`, {
        mode: 0o600,
        flag: 'wx',
      })
      expect(console.log).not.toHaveBeenCalledWith(PRIVATE_KEY)
    })

    it('refuses to overwrite an existing --output file', async () => {
      fsMocks.writeFileSync.mockImplementationOnce(() => {
        throw Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' })
      })

      await expect(run(['key', 'edge', '--output', 'edge.pem'])).rejects.toThrow(ExitError)

      expect(exitSpy).toHaveBeenCalledWith(1)
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(`File already exists: ${resolve('edge.pem')}`)
      )
    })

    it('reports a generic error when --output cannot be written', async () => {
      fsMocks.writeFileSync.mockImplementationOnce(() => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      })

      await expect(run(['key', 'edge', '--output', 'edge.pem'])).rejects.toThrow(ExitError)

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Could not write the key to ${resolve('edge.pem')}`)
      )
      expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('EACCES'))
    })

    it('prints the key to stdout and recommends --output or umask 077', async () => {
      await run(['key', 'edge'])

      expect(console.log).toHaveBeenCalledWith(PRIVATE_KEY)
      expect(fsMocks.writeFileSync).not.toHaveBeenCalled()
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('gantry bastions key edge --output ~/.ssh/edge.pem')
      )
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('umask 077'))
    })
  })

  describe('list', () => {
    it('prints each bastion with how it is reached', async () => {
      promptMocks.fetchBastions.mockResolvedValueOnce([
        { ...bastion, createdAt: '2026-04-02T09:00:00Z' },
        {
          slug: 'staging-jump',
          name: 'Staging jump',
          status: 'creating',
          publicAccess: false,
          publicIp: null,
          createdAt: '2026-04-03T09:00:00Z',
        },
      ])

      await run(['list'])

      const output = String(vi.mocked(console.log).mock.calls[0]?.[0])
      expect(output).toContain('edge')
      expect(output).toContain('ACTIVE')
      expect(output).toContain('203.0.113.10')
      expect(output).toContain('staging-jump')
      expect(output).toContain('CREATING')
      expect(output).toContain('private')
    })

    it('says so when there are no bastions', async () => {
      promptMocks.fetchBastions.mockResolvedValueOnce([])

      await run(['list'])

      expect(console.log).toHaveBeenCalledWith('No bastion hosts found.')
    })

    it('exits with the API error', async () => {
      promptMocks.fetchBastions.mockRejectedValueOnce(new Error('Not authenticated'))

      await expect(run(['list'])).rejects.toThrow(ExitError)

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Not authenticated'))
    })
  })

  describe('ssh host key pinning', () => {
    const hostPublicKey =
      'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICYYpJ9NxY3QwueHe9yfjYTdR8TqLEhJ5iV1nJjM/dj2'

    it('pins ssh to the host key Gantry recorded through a temporary known_hosts file', async () => {
      spawnMock.mockReturnValue(fakeChild())
      promptMocks.fetchBastionCredentials.mockResolvedValueOnce({
        privateKey: PRIVATE_KEY,
        sshUser: 'ec2-user',
        hostPublicKey,
        hostKeyFingerprint: 'SHA256:ZLHH8qScCNumv6jTt1L8kj+sFVAHleXj5Y3NxKTXIWs',
      })

      await run(['ssh', 'edge'])

      const knownHosts = join(TEMP_DIR, 'known_hosts')
      expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
        knownHosts,
        `203.0.113.10 ${hostPublicKey}\n`,
        { mode: 0o600, flag: 'wx' }
      )
      expect(spawnMock).toHaveBeenCalledWith(
        'ssh',
        [
          '-i',
          join(TEMP_DIR, 'key.pem'),
          '-o',
          `UserKnownHostsFile=${knownHosts}`,
          '-o',
          'GlobalKnownHostsFile=/dev/null',
          '-o',
          'StrictHostKeyChecking=yes',
          '-o',
          'HostKeyAlgorithms=ssh-ed25519',
          'ec2-user@203.0.113.10',
        ],
        { stdio: 'inherit' }
      )
    })

    it('refuses a malformed host key and removes the temporary key', async () => {
      promptMocks.fetchBastionCredentials.mockResolvedValueOnce({
        privateKey: PRIVATE_KEY,
        sshUser: 'ec2-user',
        hostPublicKey: `${hostPublicKey}\n203.0.113.66 ssh-ed25519 AAAA`,
        hostKeyFingerprint: 'SHA256:ZLHH8qScCNumv6jTt1L8kj+sFVAHleXj5Y3NxKTXIWs',
      })

      await expect(run(['ssh', 'edge'])).rejects.toThrow(ExitError)

      expect(spawnMock).not.toHaveBeenCalled()
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('not a valid ed25519 key'))
      expect(fsMocks.rmSync).toHaveBeenCalledWith(TEMP_DIR, { recursive: true, force: true })
    })
  })

  describe('ssh preconditions', () => {
    it('connects as a custom user to an interactively selected bastion', async () => {
      const child = fakeChild()
      spawnMock.mockReturnValue(child)
      promptMocks.selectBastion.mockResolvedValueOnce(bastion)

      await run(['ssh', '--user', 'ubuntu'])

      expect(promptMocks.selectBastion).toHaveBeenCalledWith({ filter: promptMocks.activeOnly })
      expect(promptMocks.fetchBastionCredentials).toHaveBeenCalledWith('edge')
      expect(spawnMock).toHaveBeenCalledWith(
        'ssh',
        [
          '-i',
          join(TEMP_DIR, 'key.pem'),
          '-o',
          'StrictHostKeyChecking=accept-new',
          'ubuntu@203.0.113.10',
        ],
        { stdio: 'inherit' }
      )
      expect(console.log).toHaveBeenCalledWith('Connecting to Edge (203.0.113.10)...')

      expect(() => child.emit('close', 255)).toThrow(ExitError)
      expect(exitSpy).toHaveBeenCalledWith(255)
    })

    it('exits 0 when ssh closes without an exit code', async () => {
      const child = fakeChild()
      spawnMock.mockReturnValue(child)

      await run(['ssh', 'edge'])

      expect(() => child.emit('close', null)).toThrow(ExitError)
      expect(exitSpy).toHaveBeenCalledWith(0)
      expect(fsMocks.rmSync).toHaveBeenCalledWith(TEMP_DIR, { recursive: true, force: true })
    })

    it('reports the spawn error message', async () => {
      const child = fakeChild()
      spawnMock.mockReturnValue(child)

      await run(['ssh', 'edge'])

      expect(() => child.emit('error', new Error('spawn ssh ENOENT'))).toThrow(ExitError)
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('SSH connection failed: spawn ssh ENOENT')
      )
    })

    it('refuses an unknown slug', async () => {
      promptMocks.fetchBastion.mockResolvedValueOnce(null)

      await expect(run(['ssh', 'ghost'])).rejects.toThrow(ExitError)

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Bastion host not found: ghost')
      )
      expect(promptMocks.fetchBastionCredentials).not.toHaveBeenCalled()
      expect(spawnMock).not.toHaveBeenCalled()
    })

    it('refuses the create choice', async () => {
      promptMocks.selectBastion.mockResolvedValueOnce('create')

      await expect(run(['ssh'])).rejects.toThrow(ExitError)

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Cannot SSH into a bastion that does not exist yet.')
      )
      expect(spawnMock).not.toHaveBeenCalled()
    })

    it('refuses a bastion that is not active', async () => {
      promptMocks.fetchBastion.mockResolvedValueOnce({ ...bastion, status: 'CREATING' })

      await expect(run(['ssh', 'edge'])).rejects.toThrow(ExitError)

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Bastion host is not active. Current status: CREATING')
      )
      expect(promptMocks.fetchBastionCredentials).not.toHaveBeenCalled()
    })

    it.each([undefined, null])('refuses a bastion without a public IP (%j)', async (publicIp) => {
      promptMocks.fetchBastion.mockResolvedValueOnce({ ...bastion, publicIp })

      await expect(run(['ssh', 'edge'])).rejects.toThrow(ExitError)

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Bastion host does not have a public IP address yet.')
      )
      expect(fsMocks.mkdtempSync).not.toHaveBeenCalled()
    })

    it('writes no temp key when the private key cannot be fetched', async () => {
      promptMocks.fetchBastionCredentials.mockRejectedValueOnce(new Error('Key not available'))

      await expect(run(['ssh', 'edge'])).rejects.toThrow(ExitError)

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Key not available'))
      expect(fsMocks.mkdtempSync).not.toHaveBeenCalled()
      expect(spawnMock).not.toHaveBeenCalled()
    })
  })

  describe('key selection', () => {
    it('prints the connect hint after writing --output', async () => {
      await run(['key', 'edge', '--output', 'edge.pem'])

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining(`Private key written to ${resolve('edge.pem')}`)
      )
      expect(errorSpy).toHaveBeenCalledWith(
        `  Connect:         ssh -i ${resolve('edge.pem')} ec2-user@203.0.113.10`
      )
    })

    it('pins the recorded host key in the connect hints', async () => {
      const hostPublicKey =
        'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICYYpJ9NxY3QwueHe9yfjYTdR8TqLEhJ5iV1nJjM/dj2'
      promptMocks.fetchBastionCredentials.mockResolvedValueOnce({
        privateKey: PRIVATE_KEY,
        sshUser: 'ec2-user',
        hostPublicKey,
        hostKeyFingerprint: 'SHA256:ZLHH8qScCNumv6jTt1L8kj+sFVAHleXj5Y3NxKTXIWs',
      })

      await run(['key', 'edge'])

      expect(errorSpy).toHaveBeenCalledWith(
        `  Trust host key:  echo '203.0.113.10 ${hostPublicKey}' >> ~/.ssh/known_hosts`
      )
      expect(errorSpy).toHaveBeenCalledWith(
        '  Connect:         ssh -i ~/.ssh/edge.pem -o StrictHostKeyChecking=yes -o HostKeyAlgorithms=ssh-ed25519 ec2-user@203.0.113.10'
      )
    })

    it('hints a private bastion by slug through gantry bastions proxy', async () => {
      const hostPublicKey =
        'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICYYpJ9NxY3QwueHe9yfjYTdR8TqLEhJ5iV1nJjM/dj2'
      promptMocks.fetchBastion.mockResolvedValueOnce({
        ...bastion,
        publicAccess: false,
        publicIp: null,
      })
      promptMocks.fetchBastionCredentials.mockResolvedValueOnce({
        privateKey: PRIVATE_KEY,
        sshUser: 'ec2-user',
        hostPublicKey,
        hostKeyFingerprint: 'SHA256:ZLHH8qScCNumv6jTt1L8kj+sFVAHleXj5Y3NxKTXIWs',
      })

      await run(['key', 'edge'])

      expect(errorSpy).toHaveBeenCalledWith(
        `  Trust host key:  echo 'edge ${hostPublicKey}' >> ~/.ssh/known_hosts`
      )
      expect(errorSpy).toHaveBeenCalledWith(
        "  Connect:         ssh -i ~/.ssh/edge.pem -o ProxyCommand='gantry bastions proxy edge' -o StrictHostKeyChecking=yes -o HostKeyAlgorithms=ssh-ed25519 ec2-user@edge"
      )
    })

    it('prints no key when the recorded host key is malformed', async () => {
      promptMocks.fetchBastionCredentials.mockResolvedValueOnce({
        privateKey: PRIVATE_KEY,
        sshUser: 'ec2-user',
        hostPublicKey: "ssh-ed25519 AAAA' >> ~/.bashrc; echo '",
        hostKeyFingerprint: 'SHA256:ZLHH8qScCNumv6jTt1L8kj+sFVAHleXj5Y3NxKTXIWs',
      })

      await expect(run(['key', 'edge'])).rejects.toThrow(ExitError)

      expect(console.log).not.toHaveBeenCalledWith(PRIVATE_KEY)
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('not a valid ed25519 key'))
    })

    it('keeps a key that already ends with a newline unchanged', async () => {
      promptMocks.fetchBastionCredentials.mockResolvedValueOnce({
        privateKey: `${PRIVATE_KEY}\n`,
        sshUser: 'ec2-user',
        hostPublicKey: null,
        hostKeyFingerprint: null,
      })
      promptMocks.fetchBastion.mockResolvedValueOnce({ ...bastion, publicIp: null })

      await run(['key', 'edge', '--output', 'edge.pem'])

      expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
        resolve('edge.pem'),
        `${PRIVATE_KEY}\n`,
        expect.anything()
      )
      expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('Connect:'))
    })

    it('prints to stdout for a selected bastion without a public IP', async () => {
      promptMocks.selectBastion.mockResolvedValueOnce({ ...bastion, publicIp: null })

      await run(['key'])

      expect(promptMocks.selectBastion).toHaveBeenCalledWith()
      expect(console.log).toHaveBeenCalledWith(PRIVATE_KEY)
      expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('Connect:'))
    })

    it('prints the connect hint on stdout output when the bastion has an IP', async () => {
      await run(['key', 'edge'])

      expect(errorSpy).toHaveBeenCalledWith(
        '  Connect:         ssh -i ~/.ssh/edge.pem ec2-user@203.0.113.10'
      )
    })

    it('refuses an unknown slug', async () => {
      promptMocks.fetchBastion.mockResolvedValueOnce(null)

      await expect(run(['key', 'ghost'])).rejects.toThrow(ExitError)

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Bastion host not found: ghost')
      )
      expect(promptMocks.fetchBastionCredentials).not.toHaveBeenCalled()
    })

    it('refuses the create choice', async () => {
      promptMocks.selectBastion.mockResolvedValueOnce('create')

      await expect(run(['key'])).rejects.toThrow(ExitError)

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Cannot retrieve a key for a bastion that does not exist yet.')
      )
      expect(console.log).not.toHaveBeenCalled()
    })
  })

  describe('create', () => {
    it('passes the flags to the interactive flow without waiting', async () => {
      promptMocks.createBastionInteractive.mockResolvedValueOnce({
        ...bastion,
        slug: 'prod-jump',
        name: 'Prod jump',
      })

      await run([
        'create',
        '--cloud',
        'cld_1',
        '--network',
        'h4nw8r',
        '--name',
        'Prod jump',
        '--slug',
        'prod-jump',
      ])

      expect(promptMocks.createBastionInteractive).toHaveBeenCalledWith({
        cloudAccountId: 'cld_1',
        networkId: 'h4nw8r',
        name: 'Prod jump',
        slug: 'prod-jump',
        waitForActive: false,
        publicAccess: false,
        allowedCidrs: undefined,
      })
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Bastion created: Prod jump (prod-jump)')
      )
    })

    it('creates a public bastion open to each --allow-cidr', async () => {
      promptMocks.createBastionInteractive.mockResolvedValueOnce(bastion)

      await run([
        'create',
        '--name',
        'Edge',
        '--public',
        '--allow-cidr',
        '203.0.113.0/24',
        '--allow-cidr',
        '198.51.100.7/32',
      ])

      expect(promptMocks.createBastionInteractive).toHaveBeenCalledWith(
        expect.objectContaining({
          publicAccess: true,
          allowedCidrs: ['203.0.113.0/24', '198.51.100.7/32'],
        })
      )
    })

    it('refuses --allow-cidr without --public', async () => {
      await expect(run(['create', '--allow-cidr', '203.0.113.0/24'])).rejects.toThrow(
        'process.exit(1)'
      )

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('--allow-cidr applies only with --public.')
      )
      expect(promptMocks.createBastionInteractive).not.toHaveBeenCalled()
    })
  })

  describe('proxy', () => {
    const SESSION = {
      region: 'us-east-2',
      sessionId: 'gantry-bastion-session-0a1b2c3d4e5f67890',
      streamUrl: 'wss://ssmmessages.us-east-2.amazonaws.com/v1/data-channel/session',
      tokenValue: 'AAEAAQ-session-token',
      target: 'i-0a1b2c3d4e5f67890',
    }

    it("hands stdio to the bastion's session and exits with the plugin's code", async () => {
      sessionMocks.startBastionSession.mockResolvedValueOnce(SESSION)
      sessionMocks.proxySession.mockResolvedValueOnce(0)

      await expect(run(['proxy', 'edge'])).rejects.toThrow('process.exit(0)')

      expect(sessionMocks.startBastionSession).toHaveBeenCalledWith('edge')
      expect(sessionMocks.proxySession).toHaveBeenCalledWith(SESSION)
    })

    it('reports a refused session on stderr only', async () => {
      const stdout = vi.spyOn(process.stdout, 'write')
      sessionMocks.startBastionSession.mockRejectedValueOnce(
        new Error("This bastion isn't ready for sessions yet.")
      )

      await expect(run(['proxy', 'edge'])).rejects.toThrow('process.exit(1)')

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("This bastion isn't ready for sessions yet.")
      )
      expect(console.log).not.toHaveBeenCalled()
      expect(stdout).not.toHaveBeenCalled()
    })

    it('exits with the API error', async () => {
      promptMocks.createBastionInteractive.mockRejectedValueOnce(
        new Error('Network has no public subnets')
      )

      await expect(run(['create'])).rejects.toThrow(ExitError)

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Network has no public subnets')
      )
    })
  })

  describe('destroy', () => {
    it('destroys the named bastion and prints the deployment', async () => {
      graphqlRequest.mockResolvedValueOnce({
        destroyBastion: { success: true, deploymentId: 'dep_bst_1' },
      })

      await run(['destroy', 'edge'])

      expect(graphqlRequest).toHaveBeenCalledWith('mutation DestroyBastion', { slug: 'edge' })
      expect(promptMocks.selectBastion).not.toHaveBeenCalled()
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Bastion destruction initiated: edge')
      )
      expect(console.log).toHaveBeenCalledWith('  Deployment: dep_bst_1')
    })

    it('destroys an interactively selected bastion', async () => {
      promptMocks.selectBastion.mockResolvedValueOnce(bastion)
      graphqlRequest.mockResolvedValueOnce({ destroyBastion: { success: true } })

      await run(['destroy'])

      expect(promptMocks.selectBastion).toHaveBeenCalledWith({ filter: promptMocks.nonDestroyed })
      expect(graphqlRequest).toHaveBeenCalledWith('mutation DestroyBastion', { slug: 'edge' })
      expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Deployment:'))
    })

    it('refuses the create choice', async () => {
      promptMocks.selectBastion.mockResolvedValueOnce('create')

      await expect(run(['destroy'])).rejects.toThrow(ExitError)

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Cannot destroy a bastion that does not exist yet.')
      )
      expect(graphqlRequest).not.toHaveBeenCalled()
    })

    it('exits with the server message', async () => {
      graphqlRequest.mockResolvedValueOnce({
        destroyBastion: { success: false, message: 'Bastion is already being deleted' },
      })

      await expect(run(['destroy', 'edge'])).rejects.toThrow(ExitError)

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Bastion is already being deleted')
      )
    })

    it('uses a generic message when a refusal has none', async () => {
      graphqlRequest.mockResolvedValueOnce({ destroyBastion: { success: false } })

      await expect(run(['destroy', 'edge'])).rejects.toThrow(ExitError)

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to destroy bastion'))
    })

    it('exits with the API error', async () => {
      graphqlRequest.mockRejectedValueOnce(new Error('Bastion not found'))

      await expect(run(['destroy', 'edge'])).rejects.toThrow(ExitError)

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Bastion not found'))
    })
  })
})
