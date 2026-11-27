import type { SessionStream } from './bastion-session'
import { openSessionStream, proxySession, startBastionSession } from './bastion-session'
import { PLUGIN_MISSING_MESSAGE, sessionPluginInstalled } from './session-plugin'

/** How the CLI reaches a private bastion's SSH port on one cloud. */
export interface BastionTransport {
  /** Throws when this machine can't attach to a session, before one is opened. */
  assertReady: () => void
  open: (slug: string) => Promise<SessionStream>
  /** Connects this process's stdin and stdout to the port. Resolves with an exit code. */
  proxy: (slug: string) => Promise<number>
}

const BASTION_TRANSPORTS: Partial<Record<string, BastionTransport>> = {
  aws: {
    assertReady: () => {
      if (!sessionPluginInstalled()) throw new Error(PLUGIN_MISSING_MESSAGE)
    },
    open: async (slug) => openSessionStream(await startBastionSession(slug)),
    proxy: async (slug) => proxySession(await startBastionSession(slug)),
  },
}

export function privateBastionTransport(provider: string): BastionTransport {
  const transport = BASTION_TRANSPORTS[provider]
  if (!transport) throw new Error('The bastion configuration is not valid.')
  return transport
}
