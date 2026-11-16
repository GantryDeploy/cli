import type { Ora } from 'ora'

import type { GetTunnelBastionQuery, GetTunnelBastionQueryVariables } from '../generated/graphql'

import { fetchBastionCredentials } from './bastion-prompts'
import { privateBastionTransport } from './bastion-transports'
import { graphqlRequest } from './client'
import { bastionHostId } from './known-hosts'
import type { BastionEndpoint, TunnelConnection } from './ssh-tunnel'
import { openSshTunnel } from './ssh-tunnel'

const TUNNEL_BASTION_QUERY = /* GraphQL */ `
  query GetTunnelBastion($slug: String!) {
    bastion(slug: $slug) {
      id
      provider
      publicAccess
      publicIp
    }
  }
`

export interface BastionTunnelRequest {
  slug: string
  remoteHost: string
  remotePort: number
  localPort?: number
  trustHostKey?: boolean
  spinner: Ora
}

/** Forwards a local port to a host the bastion can reach: over SSH to a public bastion, or through a session to a private one. */
export async function openBastionTunnel(request: BastionTunnelRequest): Promise<TunnelConnection> {
  const { slug, spinner } = request
  const credentials = await fetchBastionCredentials(slug)
  const { bastion } = await graphqlRequest<GetTunnelBastionQuery, GetTunnelBastionQueryVariables>(
    TUNNEL_BASTION_QUERY,
    { slug }
  )
  if (!bastion) throw new Error(`Bastion host not found: ${slug}`)

  let endpoint: BastionEndpoint
  let publicIp: string | null = null
  if (bastion.publicAccess) {
    if (!bastion.publicIp) throw new Error('Bastion host does not have a public IP address yet.')
    publicIp = bastion.publicIp
    endpoint = { host: publicIp }
  } else {
    const stream = await privateBastionTransport(bastion.provider).open(slug)
    endpoint = { sock: stream.sock, release: stream.close }
  }

  return openSshTunnel({
    endpoint,
    bastionUsername: credentials.sshUser,
    hostKey: {
      hostId: bastionHostId({ id: bastion.id, publicIp }),
      label: slug,
      expectedFingerprint: credentials.hostKeyFingerprint,
      trustHostKey: request.trustHostKey,
      pauseOutput: () => spinner.stop(),
      resumeOutput: () => spinner.start(),
    },
    privateKey: credentials.privateKey,
    remoteHost: request.remoteHost,
    remotePort: request.remotePort,
    localPort: request.localPort,
  })
}
