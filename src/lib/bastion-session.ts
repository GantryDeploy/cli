import { spawn } from 'child_process'
import { Duplex } from 'stream'

import type {
  StartBastionSessionMutation,
  StartBastionSessionMutationVariables,
} from '../generated/graphql'

import { graphqlRequest } from './client'
import type { AwsSession } from './session-plugin'
import {
  PLUGIN_MISSING_MESSAGE,
  SESSION_PLUGIN,
  sessionPluginArgs,
  sessionPluginInstalled,
} from './session-plugin'

const START_BASTION_SESSION = /* GraphQL */ `
  mutation StartBastionSession($slug: String!) {
    startBastionSession(slug: $slug) {
      success
      message
      aws {
        region
        sessionId
        streamUrl
        tokenValue
        target
      }
    }
  }
`

const SESSION_ERROR_MESSAGE = 'There was an error while opening the session.'

/** A session to a private bastion's SSH port. Checks for the plugin first, so no session opens that nothing can attach to. */
export async function startBastionSession(slug: string): Promise<AwsSession> {
  if (!sessionPluginInstalled()) throw new Error(PLUGIN_MISSING_MESSAGE)

  const data = await graphqlRequest<
    StartBastionSessionMutation,
    StartBastionSessionMutationVariables
  >(
    START_BASTION_SESSION,
    { slug },
    // The response holds a session token, which the API must not store for replay.
    { idempotent: false }
  )
  const started = data.startBastionSession
  if (!started.success || !started.aws) {
    throw new Error(started.message ?? SESSION_ERROR_MESSAGE)
  }
  return started.aws
}

export interface SessionStream {
  /** The bastion's SSH port, as a byte stream for an SSH client to run over. */
  sock: Duplex
  close: () => void
}

/** Runs the plugin with piped stdio, the way `ssh` runs a ProxyCommand. */
export function openSessionStream(session: AwsSession): SessionStream {
  const plugin = spawn(SESSION_PLUGIN, sessionPluginArgs(session), {
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  const sock = Duplex.from({ readable: plugin.stdout, writable: plugin.stdin })
  plugin.on('error', (error: NodeJS.ErrnoException) => {
    sock.destroy(error.code === 'ENOENT' ? new Error(PLUGIN_MISSING_MESSAGE) : error)
  })
  plugin.on('exit', () => {
    sock.destroy()
  })
  return {
    sock,
    close: () => {
      sock.destroy()
      if (plugin.exitCode === null) plugin.kill()
    },
  }
}

/** For `ssh -o ProxyCommand`: hands this process's stdin and stdout to the plugin. Resolves with its exit code. */
export function proxySession(session: AwsSession): Promise<number> {
  return new Promise((resolve, reject) => {
    const plugin = spawn(SESSION_PLUGIN, sessionPluginArgs(session), { stdio: 'inherit' })
    plugin.on('error', (error: NodeJS.ErrnoException) => {
      reject(error.code === 'ENOENT' ? new Error(PLUGIN_MISSING_MESSAGE) : error)
    })
    plugin.on('exit', (code) => {
      resolve(code ?? 1)
    })
  })
}
