import * as net from 'net'

import { Client } from 'ssh2'

import type { HostKeyPolicy } from './known-hosts'
import { HostKeyError, verifyHostKey } from './known-hosts'

export interface SshTunnelConfig {
  bastionHost: string
  bastionPort?: number
  bastionUsername?: string
  hostKey: HostKeyPolicy
  privateKey: string
  remoteHost: string
  remotePort: number
  localPort?: number
}

export interface DirectTunnelConfig {
  remoteHost: string
  remotePort: number
  localPort?: number
}

export interface TunnelConnection {
  localPort: number
  close: () => Promise<void>
}

const TUNNEL_TIMEOUT_MS = 30_000

function tcpPort(server: net.Server): number | null {
  const address = server.address()
  return address !== null && typeof address !== 'string' ? address.port : null
}

export function openSshTunnel(config: SshTunnelConfig): Promise<TunnelConnection> {
  return new Promise((resolve, reject) => {
    const sshClient = new Client()
    let server: net.Server | null = null
    let resolved = false
    let hostKeyError: HostKeyError | null = null

    const startTimeout = () =>
      setTimeout(() => {
        if (!resolved) {
          resolved = true
          sshClient.end()
          server?.close()
          reject(new Error('SSH tunnel timed out'))
        }
      }, TUNNEL_TIMEOUT_MS)
    let timeout = startTimeout()

    const hostVerifier = (key: Buffer, verify: (valid: boolean) => void) => {
      clearTimeout(timeout)
      verifyHostKey(key, config.hostKey).then(
        () => {
          timeout = startTimeout()
          verify(true)
        },
        (err: unknown) => {
          hostKeyError =
            err instanceof HostKeyError
              ? err
              : new HostKeyError('The bastion host key could not be verified.')
          verify(false)
        }
      )
    }

    sshClient.on('ready', () => {
      const tunnelServer = net.createServer((socket) => {
        socket.on('error', () => {
          // intentionally empty: ignore client socket errors
        })

        sshClient.forwardOut(
          '127.0.0.1',
          0,
          config.remoteHost,
          config.remotePort,
          (err, stream) => {
            if (err) {
              socket.destroy()
              return
            }

            stream.on('error', () => socket.destroy())
            stream.on('close', () => socket.destroy())
            socket.on('close', () => stream.destroy())

            socket.pipe(stream).pipe(socket)
          }
        )
      })

      server = tunnelServer

      tunnelServer.on('error', (err) => {
        if (!resolved) {
          clearTimeout(timeout)
          resolved = true
          sshClient.end()
          reject(err)
        }
      })

      tunnelServer.listen(config.localPort ?? 0, '127.0.0.1', () => {
        const localPort = tcpPort(tunnelServer)
        clearTimeout(timeout)
        resolved = true
        if (localPort === null) {
          tunnelServer.close()
          sshClient.end()
          reject(new Error('Tunnel server is not listening on a TCP port'))
          return
        }

        resolve({
          localPort,
          close: () =>
            new Promise<void>((res) => {
              let closed = false
              const finish = () => {
                if (!closed) {
                  closed = true
                  res()
                }
              }
              server?.close(() => {
                sshClient.end()
                finish()
              })
              sshClient.end()
              setTimeout(finish, 3000)
            }),
        })
      })
    })

    sshClient.on('error', (err) => {
      if (!resolved) {
        clearTimeout(timeout)
        resolved = true
        server?.close()
        reject(hostKeyError ?? new Error(`SSH connection failed: ${err.message}`))
      }
    })

    // ssh2 emits only 'close' when the socket drops while hostVerifier is pending, and no timer is armed then.
    sshClient.on('close', () => {
      if (!resolved) {
        clearTimeout(timeout)
        resolved = true
        server?.close()
        reject(hostKeyError ?? new Error('SSH connection closed before the tunnel opened'))
      }
    })

    sshClient.connect({
      host: config.bastionHost,
      port: config.bastionPort ?? 22,
      username: config.bastionUsername ?? 'ec2-user',
      privateKey: config.privateKey,
      hostVerifier,
      // Our own timer covers the handshake so it can pause while the user answers the trust prompt.
      readyTimeout: 0,
      keepaliveInterval: 10_000,
      keepaliveCountMax: 3,
    })
  })
}

export function openDirectTunnel(config: DirectTunnelConfig): Promise<TunnelConnection> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((clientSocket) => {
      const remoteSocket = net.connect(config.remotePort, config.remoteHost)

      clientSocket.on('error', () => remoteSocket.destroy())
      remoteSocket.on('error', () => clientSocket.destroy())
      clientSocket.on('close', () => remoteSocket.destroy())
      remoteSocket.on('close', () => clientSocket.destroy())

      clientSocket.pipe(remoteSocket).pipe(clientSocket)
    })

    server.on('error', (err) => {
      reject(err)
    })

    server.listen(config.localPort ?? 0, '127.0.0.1', () => {
      const localPort = tcpPort(server)
      if (localPort === null) {
        server.close()
        reject(new Error('Tunnel server is not listening on a TCP port'))
        return
      }
      resolve({
        localPort,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => {
              res()
            })
            setTimeout(() => {
              res()
            }, 3000)
          }),
      })
    })
  })
}
