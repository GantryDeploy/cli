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
  fetchBastionPrivateKey: vi.fn(),
  fetchBastions: vi.fn(),
  nonDestroyed: vi.fn(),
  selectBastion: vi.fn(),
}))

const graphqlRequest = vi.hoisted(() => vi.fn())

vi.mock('fs', () => fsMocks)
vi.mock('child_process', () => ({ spawn: spawnMock }))
vi.mock('../lib/bastion-prompts', () => ({
  ...promptMocks,
  DESTROY_BASTION_MUTATION: 'mutation DestroyBastion',
}))
vi.mock('../lib/client', () => ({
  formatApiError: (error: unknown) => (error instanceof Error ? error.message : 'API error'),
  graphqlRequest,
}))

const { createTempKeyFile, registerBastionsCommand } = await import('./bastions')

const TEMP_DIR = '/tmp/gantry-bastion-abc123'
const PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END OPENSSH PRIVATE KEY-----'

const bastion = {
  slug: 'edge',
  name: 'Edge',
  status: 'active',
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
    promptMocks.fetchBastionPrivateKey.mockResolvedValue(PRIVATE_KEY)
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
    it('prints each bastion with its public IP', async () => {
      promptMocks.fetchBastions.mockResolvedValueOnce([
        { ...bastion, createdAt: '2026-04-02T09:00:00Z' },
        {
          slug: 'staging-jump',
          name: 'Staging jump',
          status: 'creating',
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
      expect(output).toContain('—')
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

  describe('ssh preconditions', () => {
    it('connects as a custom user to an interactively selected bastion', async () => {
      const child = fakeChild()
      spawnMock.mockReturnValue(child)
      promptMocks.selectBastion.mockResolvedValueOnce(bastion)

      await run(['ssh', '--user', 'ubuntu'])

      expect(promptMocks.selectBastion).toHaveBeenCalledWith({ filter: promptMocks.activeOnly })
      expect(promptMocks.fetchBastionPrivateKey).toHaveBeenCalledWith('edge')
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
      expect(promptMocks.fetchBastionPrivateKey).not.toHaveBeenCalled()
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
      expect(promptMocks.fetchBastionPrivateKey).not.toHaveBeenCalled()
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
      promptMocks.fetchBastionPrivateKey.mockRejectedValueOnce(new Error('Key not available'))

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
        `  Connect: ssh -i ${resolve('edge.pem')} ec2-user@203.0.113.10`
      )
    })

    it('keeps a key that already ends with a newline unchanged', async () => {
      promptMocks.fetchBastionPrivateKey.mockResolvedValueOnce(`${PRIVATE_KEY}\n`)
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
      expect(promptMocks.fetchBastionPrivateKey).not.toHaveBeenCalled()
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
      })
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Bastion created: Prod jump (prod-jump)')
      )
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
