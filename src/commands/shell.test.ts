import { EventEmitter } from 'events'
import * as path from 'path'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  graphqlRequest: vi.fn(),
  loadProjectIdentity: vi.fn(),
  printError: vi.fn(),
  resolveEnvironmentSlug: vi.fn(),
  spawn: vi.fn(),
  spinner: { fail: vi.fn(), stop: vi.fn() },
}))

vi.mock('child_process', () => ({ spawn: mocks.spawn }))
vi.mock('fs', () => ({ existsSync: mocks.existsSync }))
vi.mock('ora', () => ({
  default: () => ({ start: () => mocks.spinner }),
}))
vi.mock('../lib/client', () => ({
  formatApiError: (error: unknown) => (error instanceof Error ? error.message : 'API error'),
  graphqlRequest: mocks.graphqlRequest,
}))
vi.mock('../lib/output', () => ({ printError: mocks.printError }))
vi.mock('../lib/project-identity', () => ({
  loadProjectIdentity: mocks.loadProjectIdentity,
  resolveEnvironmentSlug: mocks.resolveEnvironmentSlug,
}))

const { joinCommand, registerShellCommand, sessionPluginArgs, sessionPluginInstalled } =
  await import('./shell')

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

const INSTANCE_ID = '8f3a1c9e04b24d6e9a7b5c3d2e1f0a9b'
const SESSION = {
  region: 'us-east-2',
  sessionId: 'ecs-execute-command-0a1b2c3d4e',
  streamUrl:
    'wss://ssmmessages.us-east-2.amazonaws.com/v1/data-channel/ecs-execute-command-0a1b2c3d4e',
  tokenValue: 'AAEAAf3k',
  target: `ecs:main_${INSTANCE_ID}_${INSTANCE_ID}-2531612879`,
}

describe('sessionPluginArgs', () => {
  it('passes the session, region and target the way the AWS CLI does', () => {
    expect(sessionPluginArgs(SESSION)).toEqual([
      JSON.stringify({
        sessionId: SESSION.sessionId,
        streamUrl: SESSION.streamUrl,
        tokenValue: SESSION.tokenValue,
      }),
      'us-east-2',
      'StartSession',
      '',
      JSON.stringify({ Target: SESSION.target }),
      'https://ssm.us-east-2.amazonaws.com',
    ])
  })
})

describe('sessionPluginArgs in China regions', () => {
  it('uses the China partition endpoint', () => {
    expect(sessionPluginArgs({ ...SESSION, region: 'cn-north-1' }).at(-1)).toBe(
      'https://ssm.cn-north-1.amazonaws.com.cn'
    )
  })
})

describe('joinCommand', () => {
  it.each([
    [['bash', '-l'], 'bash -l'],
    [['sh', '-c', 'echo a b'], "sh -c 'echo a b'"],
    [['php', '-r', "echo 'hi';"], "php -r 'echo '\\''hi'\\'';'"],
    [['ls', '/var/www/html'], 'ls /var/www/html'],
  ])('joins %j as %s', (args, expected) => {
    expect(joinCommand(args)).toBe(expected)
  })
})

describe('sessionPluginInstalled', () => {
  const searchPath = ['/opt/homebrew/bin', '/usr/local/bin'].join(path.delimiter)

  it('finds the plugin in a PATH directory', () => {
    mocks.existsSync.mockImplementation(
      (file: string) => file === path.join('/usr/local/bin', 'session-manager-plugin')
    )

    expect(sessionPluginInstalled(searchPath, 'darwin')).toBe(true)
  })

  it('finds the Windows executable by its extension', () => {
    mocks.existsSync.mockImplementation((file: string) =>
      file.endsWith('session-manager-plugin.exe')
    )

    expect(sessionPluginInstalled(searchPath, 'win32')).toBe(true)
  })

  it('reports the plugin missing when no directory has it', () => {
    mocks.existsSync.mockReturnValue(false)

    expect(sessionPluginInstalled(searchPath, 'linux')).toBe(false)
    expect(sessionPluginInstalled(undefined, 'linux')).toBe(false)
  })
})

describe('shell command', () => {
  let plugin: EventEmitter

  async function shell(...args: string[]): Promise<ExitError> {
    const program = new Command().enablePositionalOptions()
    program.exitOverride()
    registerShellCommand(program)
    const error: unknown = await program.parseAsync(['node', 'gantry', 'shell', ...args]).then(
      () => undefined,
      (caught: unknown) => caught
    )
    if (!(error instanceof ExitError)) throw new Error('expected the command to exit')
    return error
  }

  function opens() {
    mocks.graphqlRequest.mockResolvedValueOnce({
      startShellSession: { success: true, message: null, instanceId: INSTANCE_ID, aws: SESSION },
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.graphqlRequest.mockReset()
    mocks.existsSync.mockReturnValue(true)
    mocks.loadProjectIdentity.mockReturnValue({ id: 'p9ue62', environments: ['dev', 'production'] })
    mocks.resolveEnvironmentSlug.mockImplementation((_identity: unknown, requested: string) =>
      requested.toLowerCase()
    )
    plugin = new EventEmitter()
    mocks.spawn.mockImplementation(() => {
      setImmediate(() => plugin.emit('exit', 0))
      return plugin
    })
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitError(typeof code === 'number' ? code : undefined)
    })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('opens /bin/sh by default and hands the terminal to the plugin', async () => {
    opens()

    expect((await shell('--env', 'production', 'web')).code).toBe(0)

    const [, variables, options] = mocks.graphqlRequest.mock.calls[0] as unknown[]
    expect(variables).toEqual({
      projectId: 'p9ue62',
      environmentSlug: 'production',
      service: 'web',
      instance: undefined,
      command: undefined,
    })
    expect(options).toEqual({ idempotent: false })
    expect(mocks.spawn).toHaveBeenCalledWith('session-manager-plugin', sessionPluginArgs(SESSION), {
      stdio: 'inherit',
    })
  })

  it('passes a chosen instance and command, keeping their flags out of the CLI', async () => {
    opens()

    await shell('--instance', INSTANCE_ID, 'web', '--', 'bash', '-l')

    const [, variables] = mocks.graphqlRequest.mock.calls[0] as [unknown, Record<string, unknown>]
    expect(variables).toMatchObject({ instance: INSTANCE_ID, command: 'bash -l' })
  })

  it("exits with the plugin's exit code", async () => {
    opens()
    mocks.spawn.mockImplementation(() => {
      setImmediate(() => plugin.emit('exit', 130))
      return plugin
    })

    expect((await shell('web')).code).toBe(130)
  })

  it('leaves Ctrl-C to the remote shell while the session runs', async () => {
    opens()
    let listenersDuringSession = 0
    mocks.spawn.mockImplementation(() => {
      listenersDuringSession = process.listenerCount('SIGINT')
      setImmediate(() => plugin.emit('exit', 0))
      return plugin
    })
    const before = process.listenerCount('SIGINT')

    await shell('web')

    expect(listenersDuringSession).toBe(before + 1)
    expect(process.listenerCount('SIGINT')).toBe(before)
  })

  it('stops before opening a session when the plugin is missing', async () => {
    mocks.existsSync.mockReturnValue(false)

    expect((await shell('web')).code).toBe(1)
    expect(mocks.graphqlRequest).not.toHaveBeenCalled()
    expect(mocks.printError).toHaveBeenCalledWith(
      expect.stringContaining('session-manager-plugin was not found. Install it from https://')
    )
  })

  it('prints the API refusal and exits 1', async () => {
    const message =
      "Interactive sessions are off for this service's running instances. Set enable_execute_command: true and redeploy."
    mocks.graphqlRequest.mockResolvedValueOnce({
      startShellSession: { success: false, message, instanceId: null, aws: null },
    })

    expect((await shell('web')).code).toBe(1)
    expect(mocks.printError).toHaveBeenCalledWith(message)
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('reports a failed request with the safe API error', async () => {
    mocks.graphqlRequest.mockRejectedValueOnce(new Error('Environment not found'))

    expect((await shell('web')).code).toBe(1)
    expect(mocks.spinner.fail).toHaveBeenCalledWith('Failed to open the session')
    expect(mocks.printError).toHaveBeenCalledWith('Environment not found')
  })
})
