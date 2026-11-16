import { existsSync } from 'fs'
import * as path from 'path'

export const SESSION_PLUGIN = 'session-manager-plugin'
export const PLUGIN_INSTALL_URL =
  'https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html'
export const PLUGIN_MISSING_MESSAGE = `${SESSION_PLUGIN} was not found. Install it from ${PLUGIN_INSTALL_URL}`

/** A session the API opened, in the shape the plugin attaches to. */
export interface AwsSession {
  region: string
  sessionId: string
  streamUrl: string
  tokenValue: string
  target: string
}

export function sessionPluginInstalled(
  searchPath = process.env.PATH,
  platform = process.platform
): boolean {
  const extensions = platform === 'win32' ? ['.exe', ''] : ['']
  return (searchPath ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .some((dir) => extensions.some((ext) => existsSync(path.join(dir, SESSION_PLUGIN + ext))))
}

/** The arguments the AWS CLI passes the plugin for a session it has already started. */
export function sessionPluginArgs(session: AwsSession): string[] {
  return [
    JSON.stringify({
      sessionId: session.sessionId,
      streamUrl: session.streamUrl,
      tokenValue: session.tokenValue,
    }),
    session.region,
    'StartSession',
    '',
    JSON.stringify({ Target: session.target }),
    `https://ssm.${session.region}.${session.region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com'}`,
  ]
}
