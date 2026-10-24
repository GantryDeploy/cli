import { EventEmitter } from 'events'
import { mkdtempSync, rmSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'

import { confirm } from '@inquirer/prompts'
import type { ConnectConfig } from 'ssh2'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fingerprintHostKey, readKnownHost, recordKnownHost } from './known-hosts'
import { openDirectTunnel, openSshTunnel } from './ssh-tunnel'

interface FakeClient extends EventEmitter {
  end: () => void
  forwardOut: ReturnType<typeof vi.fn>
  config: ConnectConfig | null
}

interface FakeSocket extends EventEmitter {
  pipe: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
}

interface FakeServer extends EventEmitter {
  handler: (socket: FakeSocket) => void
  listen: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  address: () => { port: number }
}

const clients = vi.hoisted((): FakeClient[] => [])
const netState = vi.hoisted(() => ({
  servers: [] as FakeServer[],
  connections: [] as { port: number; host: string; socket: FakeSocket }[],
  listenError: null as Error | null,
  closeCallsBack: true,
}))

vi.mock('net', async () => {
  const { EventEmitter: Emitter } = await import('events')

  const socket = (): FakeSocket => {
    const s = new Emitter() as FakeSocket
    s.pipe = vi.fn((dest: unknown) => dest)
    s.destroy = vi.fn()
    return s
  }

  const createServer = (handler: (socket: FakeSocket) => void): FakeServer => {
    const server = new Emitter() as FakeServer
    server.handler = handler
    server.address = () => ({ port: 45678 })
    server.listen = vi.fn((_port: number, _host: string, onListening: () => void) => {
      if (netState.listenError) server.emit('error', netState.listenError)
      else onListening()
    })
    server.close = vi.fn((onClosed?: () => void) => {
      if (netState.closeCallsBack) onClosed?.()
    })
    netState.servers.push(server)
    return server
  }

  const connect = (port: number, host: string) => {
    const s = socket()
    netState.connections.push({ port, host, socket: s })
    return s
  }

  return { createServer, connect, default: { createServer, connect } }
})

vi.mock('ssh2', async () => {
  const { EventEmitter: Emitter } = await import('events')

  class Client extends Emitter {
    config: ConnectConfig | null = null
    end = vi.fn()
    forwardOut = vi.fn()
    connect = vi.fn((config: ConnectConfig) => {
      this.config = config
    })

    constructor() {
      super()
      clients.push(this)
    }
  }

  return { Client }
})
vi.mock(import('os'), async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, homedir: vi.fn() }
})
vi.mock('@inquirer/prompts', () => ({ confirm: vi.fn() }))

const KEY = Buffer.from('bastion-host-key')
const OTHER_KEY = Buffer.from('attacker-host-key')

function setTty(value: boolean) {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true })
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true })
}

function open(trustHostKey?: boolean, expectedFingerprint: string | null = null) {
  const tunnel = openSshTunnel({
    bastionHost: '1.2.3.4',
    hostKey: { hostId: 'i-0abc', label: 'my-bastion', expectedFingerprint, trustHostKey },
    privateKey: 'fake-key',
    remoteHost: 'db.internal',
    remotePort: 5432,
  })
  const client = clients.at(-1)
  if (!client?.config) throw new Error('connect was not called')
  return { tunnel, client, config: client.config }
}

function runVerifier(config: ConnectConfig, key: Buffer): Promise<boolean> {
  return new Promise((resolve) => {
    const verifier = config.hostVerifier as (key: Buffer, verify: (ok: boolean) => void) => void
    verifier(key, resolve)
  })
}

async function expectRejectedWith(client: FakeClient, tunnel: Promise<unknown>, pattern: RegExp) {
  client.emit('error', new Error('Host denied (verification failed)'))
  await expect(tunnel).rejects.toThrow(pattern)
}

describe('openSshTunnel host key verification', () => {
  let home: string
  const stdinTty = process.stdin.isTTY
  const stdoutTty = process.stdout.isTTY
  const originalCi = process.env.CI

  beforeEach(() => {
    clients.length = 0
    home = mkdtempSync(join(tmpdir(), 'gantry-ssh-tunnel-'))
    vi.mocked(homedir).mockReturnValue(home)
    vi.mocked(confirm).mockReset()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    delete process.env.CI
    setTty(true)
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    vi.mocked(console.log).mockRestore()
    if (originalCi === undefined) delete process.env.CI
    else process.env.CI = originalCi
    Object.defineProperty(process.stdin, 'isTTY', { value: stdinTty, configurable: true })
    Object.defineProperty(process.stdout, 'isTTY', { value: stdoutTty, configurable: true })
  })

  it('passes a host verifier and leaves the handshake timeout to the tunnel', () => {
    const { tunnel, client, config } = open()

    expect(typeof config.hostVerifier).toBe('function')
    expect(config.hostHash).toBeUndefined()
    expect(config.readyTimeout).toBe(0)
    expect(config.algorithms).toBeUndefined()

    client.emit('error', new Error('boom'))
    return expect(tunnel).rejects.toThrow('SSH connection failed: boom')
  })

  it('accepts the key Gantry recorded at provisioning without prompting, and records it', async () => {
    const { tunnel, client, config } = open(false, fingerprintHostKey(KEY))

    expect(config.algorithms).toEqual({ serverHostKey: ['ssh-ed25519'] })
    await expect(runVerifier(config, KEY)).resolves.toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    expect(readKnownHost('i-0abc')).toBe(fingerprintHostKey(KEY))

    client.emit('error', new Error('closed'))
    await expect(tunnel).rejects.toThrow()
  })

  it('refuses a key that differs from the one Gantry recorded, even with --trust-host-key', async () => {
    const { tunnel, client, config } = open(true, fingerprintHostKey(KEY))

    await expect(runVerifier(config, OTHER_KEY)).resolves.toBe(false)
    expect(confirm).not.toHaveBeenCalled()
    expect(readKnownHost('i-0abc')).toBeNull()
    await expectRejectedWith(client, tunnel, /does not match the one Gantry recorded/)
  })

  it('accepts and records an unknown key the user trusts', async () => {
    vi.mocked(confirm).mockResolvedValue(true)
    const { tunnel, client, config } = open()

    await expect(runVerifier(config, KEY)).resolves.toBe(true)
    expect(confirm).toHaveBeenCalledOnce()
    expect(readKnownHost('i-0abc')).toBe(fingerprintHostKey(KEY))

    client.emit('error', new Error('later failure'))
    await expect(tunnel).rejects.toThrow('SSH connection failed: later failure')
  })

  it('does not time out while waiting for the user to answer the prompt', async () => {
    vi.useFakeTimers()
    try {
      let answer: (value: boolean) => void = () => undefined
      vi.mocked(confirm).mockReturnValue(
        new Promise<boolean>((resolve) => {
          answer = resolve
        })
      )
      const { tunnel, client, config } = open()
      const settled = vi.fn()
      tunnel.catch(settled)

      const verified = runVerifier(config, KEY)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(settled).not.toHaveBeenCalled()

      answer(true)
      await expect(verified).resolves.toBe(true)

      await vi.advanceTimersByTimeAsync(30_000)
      await expect(tunnel).rejects.toThrow('SSH tunnel timed out')
      expect(client.end).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects an unknown key the user declines', async () => {
    vi.mocked(confirm).mockResolvedValue(false)
    const { tunnel, client, config } = open()

    await expect(runVerifier(config, KEY)).resolves.toBe(false)
    expect(readKnownHost('i-0abc')).toBeNull()
    await expectRejectedWith(client, tunnel, /was not trusted/)
  })

  it('settles when the connection closes while the user is declining the prompt', async () => {
    vi.mocked(confirm).mockResolvedValue(false)
    const { tunnel, client, config } = open()

    await expect(runVerifier(config, KEY)).resolves.toBe(false)
    client.emit('close')
    await expect(tunnel).rejects.toThrow(/was not trusted/)
  })

  it('rejects when the connection closes before the tunnel opens', async () => {
    const { tunnel, client } = open()

    client.emit('close')
    await expect(tunnel).rejects.toThrow(/closed before the tunnel opened/)
  })

  it('accepts a known matching key without prompting', async () => {
    recordKnownHost('i-0abc', fingerprintHostKey(KEY))
    const { tunnel, client, config } = open()

    await expect(runVerifier(config, KEY)).resolves.toBe(true)
    expect(confirm).not.toHaveBeenCalled()

    client.emit('error', new Error('closed'))
    await expect(tunnel).rejects.toThrow()
  })

  it('refuses a mismatched key without prompting', async () => {
    recordKnownHost('i-0abc', fingerprintHostKey(KEY))
    const { tunnel, client, config } = open(true)

    await expect(runVerifier(config, OTHER_KEY)).resolves.toBe(false)
    expect(confirm).not.toHaveBeenCalled()
    expect(readKnownHost('i-0abc')).toBe(fingerprintHostKey(KEY))
    await expectRejectedWith(client, tunnel, /does not match/)
  })

  it('fails without a TTY when --trust-host-key is not passed', async () => {
    setTty(false)
    const { tunnel, client, config } = open()

    await expect(runVerifier(config, KEY)).resolves.toBe(false)
    expect(confirm).not.toHaveBeenCalled()
    await expectRejectedWith(client, tunnel, /Pass --trust-host-key/)
  })

  it('records the key without a TTY when --trust-host-key is passed', async () => {
    setTty(false)
    const { tunnel, client, config } = open(true)

    await expect(runVerifier(config, KEY)).resolves.toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    expect(readKnownHost('i-0abc')).toBe(fingerprintHostKey(KEY))

    client.emit('error', new Error('closed'))
    await expect(tunnel).rejects.toThrow()
  })

  it('reports a generic host key error when the store cannot be read', async () => {
    vi.mocked(homedir).mockImplementation(() => {
      throw new Error('EACCES: internal detail')
    })
    const { tunnel, client, config } = open()

    await expect(runVerifier(config, KEY)).resolves.toBe(false)
    await expectRejectedWith(client, tunnel, /^The bastion host key could not be verified\.$/)
  })
})

function last<T>(items: T[]): T {
  const item = items.at(-1)
  if (item === undefined) throw new Error('expected at least one item')
  return item
}

function fakeSocket(): FakeSocket {
  const socket = new EventEmitter() as FakeSocket
  socket.pipe = vi.fn((dest: unknown) => dest)
  socket.destroy = vi.fn()
  return socket
}

describe('openSshTunnel forwarding', () => {
  beforeEach(() => {
    clients.length = 0
    netState.servers.length = 0
    netState.listenError = null
    netState.closeCallsBack = true
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function openReady() {
    const tunnel = openSshTunnel({
      bastionHost: '1.2.3.4',
      bastionPort: 2222,
      bastionUsername: 'ubuntu',
      hostKey: { hostId: 'i-0abc', label: 'my-bastion', expectedFingerprint: null },
      privateKey: 'fake-key',
      remoteHost: 'db.internal',
      remotePort: 5432,
      localPort: 15432,
    })
    const client = last(clients)
    client.emit('ready')
    return { tunnel, client, server: last(netState.servers) }
  }

  it('connects with the given bastion settings and listens on loopback', async () => {
    const { tunnel, client, server } = openReady()

    await expect(tunnel).resolves.toMatchObject({ localPort: 45678 })
    expect(client.config).toMatchObject({ host: '1.2.3.4', port: 2222, username: 'ubuntu' })
    expect(server.listen).toHaveBeenCalledWith(15432, '127.0.0.1', expect.any(Function))
  })

  it('defaults to port 22 as ec2-user', () => {
    const tunnel = openSshTunnel({
      bastionHost: '1.2.3.4',
      hostKey: { hostId: 'i-0abc', label: 'b', expectedFingerprint: null },
      privateKey: 'k',
      remoteHost: 'db',
      remotePort: 5432,
    })
    const client = last(clients)
    expect(client.config).toMatchObject({ port: 22, username: 'ec2-user' })
    client.emit('error', new Error('x'))
    return expect(tunnel).rejects.toThrow()
  })

  it('forwards each local connection to the remote host and tears both ends down together', async () => {
    const { tunnel, client, server } = openReady()
    await tunnel
    const socket = fakeSocket()
    const stream = fakeSocket()

    server.handler(socket)
    expect(client.forwardOut).toHaveBeenCalledWith(
      '127.0.0.1',
      0,
      'db.internal',
      5432,
      expect.any(Function)
    )
    const onForward = client.forwardOut.mock.calls[0][4] as (err: Error | null, s: unknown) => void
    onForward(null, stream)

    expect(socket.pipe).toHaveBeenCalledWith(stream)
    expect(stream.pipe).toHaveBeenCalledWith(socket)
    socket.emit('error', new Error('reset'))
    stream.emit('close')
    expect(socket.destroy).toHaveBeenCalled()
    socket.emit('close')
    expect(stream.destroy).toHaveBeenCalled()
  })

  it('drops the local connection when forwarding is refused', async () => {
    const { tunnel, client, server } = openReady()
    await tunnel
    const socket = fakeSocket()

    server.handler(socket)
    const onForward = client.forwardOut.mock.calls[0][4] as (err: Error | null) => void
    onForward(new Error('administratively prohibited'))

    expect(socket.destroy).toHaveBeenCalled()
  })

  it('drops the local connection when the forwarded stream errors', async () => {
    const { tunnel, client, server } = openReady()
    await tunnel
    const socket = fakeSocket()
    const stream = fakeSocket()

    server.handler(socket)
    ;(client.forwardOut.mock.calls[0][4] as (err: null, s: unknown) => void)(null, stream)
    stream.emit('error', new Error('channel closed'))

    expect(socket.destroy).toHaveBeenCalled()
  })

  it('rejects and ends the SSH session when the local port cannot be bound', async () => {
    netState.listenError = new Error('EADDRINUSE')

    const { tunnel, client } = openReady()

    await expect(tunnel).rejects.toThrow('EADDRINUSE')
    expect(client.end).toHaveBeenCalled()
  })

  it('ignores a server error after the tunnel is open', async () => {
    const { tunnel, server } = openReady()
    await tunnel

    expect(() => server.emit('error', new Error('late'))).not.toThrow()
  })

  it('closes the listener and the SSH session', async () => {
    const { tunnel, client, server } = openReady()
    const connection = await tunnel

    await connection.close()

    expect(server.close).toHaveBeenCalled()
    expect(client.end).toHaveBeenCalled()
  })

  it('finishes closing after three seconds when the listener never reports closed', async () => {
    vi.useFakeTimers()
    netState.closeCallsBack = false
    const { tunnel } = openReady()
    const connection = await tunnel

    const closed = vi.fn()
    void connection.close().then(closed)
    await vi.advanceTimersByTimeAsync(2999)
    expect(closed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(closed).toHaveBeenCalled()
  })
})

describe('openDirectTunnel', () => {
  beforeEach(() => {
    netState.servers.length = 0
    netState.connections.length = 0
    netState.listenError = null
    netState.closeCallsBack = true
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('listens on loopback and pipes each connection to the remote host', async () => {
    const connection = await openDirectTunnel({ remoteHost: '10.0.0.5', remotePort: 6379 })
    const server = last(netState.servers)
    const client = fakeSocket()

    server.handler(client)

    expect(server.listen).toHaveBeenCalledWith(0, '127.0.0.1', expect.any(Function))
    expect(connection.localPort).toBe(45678)
    const [{ port, host, socket: remote }] = netState.connections
    expect([port, host]).toEqual([6379, '10.0.0.5'])
    expect(client.pipe).toHaveBeenCalledWith(remote)
    expect(remote.pipe).toHaveBeenCalledWith(client)
  })

  it('tears down the other side when either end errors or closes', async () => {
    await openDirectTunnel({ remoteHost: 'h', remotePort: 1, localPort: 9000 })
    const server = last(netState.servers)

    const clientA = fakeSocket()
    server.handler(clientA)
    const remoteA = netState.connections[0].socket
    clientA.emit('error', new Error('reset'))
    expect(remoteA.destroy).toHaveBeenCalled()
    remoteA.emit('close')
    expect(clientA.destroy).toHaveBeenCalled()

    const clientB = fakeSocket()
    server.handler(clientB)
    const remoteB = netState.connections[1].socket
    remoteB.emit('error', new Error('refused'))
    expect(clientB.destroy).toHaveBeenCalled()
    clientB.emit('close')
    expect(remoteB.destroy).toHaveBeenCalled()
  })

  it('rejects when the local port cannot be bound', async () => {
    netState.listenError = new Error('EACCES')

    await expect(openDirectTunnel({ remoteHost: 'h', remotePort: 1 })).rejects.toThrow('EACCES')
  })

  it('closes the listener, or gives up waiting after three seconds', async () => {
    const connection = await openDirectTunnel({ remoteHost: 'h', remotePort: 1 })
    await expect(connection.close()).resolves.toBeUndefined()

    vi.useFakeTimers()
    netState.closeCallsBack = false
    const stuck = await openDirectTunnel({ remoteHost: 'h', remotePort: 1 })
    const closed = vi.fn()
    void stuck.close().then(closed)
    await vi.advanceTimersByTimeAsync(3000)
    expect(closed).toHaveBeenCalled()
  })
})
