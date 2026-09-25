import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  assertValidBuildArgKey,
  assertValidRegistryEndpoint,
  buildDockerBuildArgs,
  isValidImageReference,
  redactDockerArgs,
  runDocker,
} from './exec'

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}))

const mockSpawn = vi.mocked(spawn)

interface FakeChild extends EventEmitter {
  stdout: PassThrough
  stderr: PassThrough
  stdin: PassThrough
  stdinData: () => string
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  const chunks: Buffer[] = []
  child.stdin.on('data', (chunk: Buffer) => chunks.push(chunk))
  child.stdinData = () => Buffer.concat(chunks).toString()
  return child
}

function spawnReturning(onSpawn: (child: FakeChild) => void): FakeChild {
  const child = fakeChild()
  mockSpawn.mockImplementationOnce(() => {
    setImmediate(() => {
      onSpawn(child)
    })
    return child as unknown as ChildProcess
  })
  return child
}

const exitWith =
  (code: number, stderr = '') =>
  (child: FakeChild) => {
    if (stderr) child.stderr.write(stderr)
    setImmediate(() => child.emit('close', code))
  }

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('expected promise to reject')
}

beforeEach(() => {
  mockSpawn.mockReset()
})

describe('isValidImageReference', () => {
  it.each([
    'nginx',
    'my-app:v1',
    '42-my-project-api_docker:v3',
    'library/nginx:1.25-alpine',
    'localhost:5000/team/app:latest',
    '123456789.dkr.ecr.us-east-1.amazonaws.com/my-repo:v1',
    `app@sha256:${'a'.repeat(64)}`,
  ])('accepts %s', (reference) => {
    expect(isValidImageReference(reference)).toBe(true)
  })

  it.each([
    '',
    '--help',
    'app:v1; touch x',
    'app:$(touch x)',
    'app:`id`',
    'app name:v1',
    'App:v1',
    'app:',
    `app:${'a'.repeat(129)}`,
    `${'a'.repeat(256)}:v1`,
  ])('rejects %j', (reference) => {
    expect(isValidImageReference(reference)).toBe(false)
  })
})

describe('assertValidBuildArgKey', () => {
  it('accepts shell-style variable names', () => {
    expect(() => {
      assertValidBuildArgKey('NODE_ENV')
    }).not.toThrow()
    expect(() => {
      assertValidBuildArgKey('_private1')
    }).not.toThrow()
  })

  it.each(['1ABC', 'A-B', 'A B', 'A=B', '$(id)', ''])('rejects %j', (key) => {
    expect(() => {
      assertValidBuildArgKey(key)
    }).toThrow(/Invalid Docker build arg name/)
  })
})

describe('assertValidRegistryEndpoint', () => {
  it('accepts a URL or bare host', () => {
    expect(() => {
      assertValidRegistryEndpoint('https://123.dkr.ecr.us-east-1.amazonaws.com')
    }).not.toThrow()
    expect(() => {
      assertValidRegistryEndpoint('123.dkr.ecr.us-east-1.amazonaws.com')
    }).not.toThrow()
  })

  it.each(['--password=x', 'host name', 'https://', '://'])('rejects %j', (endpoint) => {
    expect(() => {
      assertValidRegistryEndpoint(endpoint)
    }).toThrow('Invalid container registry endpoint')
  })
})

describe('buildDockerBuildArgs', () => {
  it('builds an argv array with target, build args and context', () => {
    expect(
      buildDockerBuildArgs({
        tag: 'p9ue62-shop-api:v2',
        dockerfile: 'docker/Dockerfile',
        target: 'runtime',
        buildArgs: { NODE_ENV: 'production' },
      })
    ).toEqual([
      'build',
      '-t',
      'p9ue62-shop-api:v2',
      '-f',
      'docker/Dockerfile',
      '--target',
      'runtime',
      '--build-arg',
      'NODE_ENV=production',
      '.',
    ])
  })

  it('omits the optional flags when not provided', () => {
    expect(
      buildDockerBuildArgs({ tag: 'app:v1', dockerfile: 'Dockerfile', context: 'ctx' })
    ).toEqual(['build', '-t', 'app:v1', '-f', 'Dockerfile', 'ctx'])
  })

  it.each(['$(touch x)', '`touch x`', 'a; rm -rf /', 'has spaces in it', 'quo\'te"s'])(
    'keeps build arg value %j as a single literal argv element',
    (value) => {
      const args = buildDockerBuildArgs({
        tag: 'app:v1',
        dockerfile: 'Dockerfile',
        buildArgs: { VALUE: value },
      })
      expect(args).toContain(`VALUE=${value}`)
      expect(args[args.indexOf('--build-arg') + 1]).toBe(`VALUE=${value}`)
    }
  )

  it('keeps a Dockerfile path with spaces as one element', () => {
    const args = buildDockerBuildArgs({ tag: 'app:v1', dockerfile: 'my dir/Dockerfile' })
    expect(args[args.indexOf('-f') + 1]).toBe('my dir/Dockerfile')
  })

  it('rejects an invalid build arg key', () => {
    expect(() =>
      buildDockerBuildArgs({ tag: 'app:v1', dockerfile: 'Dockerfile', buildArgs: { 'A;B': 'x' } })
    ).toThrow(/Invalid Docker build arg name "A;B"/)
  })

  it('rejects an invalid tag', () => {
    expect(() => buildDockerBuildArgs({ tag: 'app:v1 && id', dockerfile: 'Dockerfile' })).toThrow(
      /not a valid Docker image reference/
    )
  })

  it('rejects an invalid target', () => {
    expect(() =>
      buildDockerBuildArgs({ tag: 'app:v1', dockerfile: 'Dockerfile', target: '--output=/' })
    ).toThrow(/Invalid Docker build target/)
  })

  it('requires a Dockerfile', () => {
    expect(() => buildDockerBuildArgs({ tag: 'app:v1', dockerfile: '' })).toThrow(
      /Dockerfile path is required/
    )
  })
})

describe('redactDockerArgs', () => {
  it('masks build arg values only', () => {
    expect(
      redactDockerArgs([
        'build',
        '-t',
        'a:v1',
        '--build-arg',
        'TOKEN=s3cret',
        '--build-arg',
        'BARE',
        '.',
      ])
    ).toEqual(['build', '-t', 'a:v1', '--build-arg', 'TOKEN=***', '--build-arg', 'BARE', '.'])
  })
})

describe('runDocker', () => {
  it('spawns docker with an argv array and no shell', async () => {
    const child = spawnReturning(exitWith(0))

    await runDocker(['tag', 'a:v1', 'b:v1'], { cwd: '/work' })

    expect(mockSpawn).toHaveBeenCalledWith(
      'docker',
      ['tag', 'a:v1', 'b:v1'],
      expect.objectContaining({ cwd: '/work', shell: false })
    )
    expect(child.stdinData()).toBe('')
  })

  it('writes input to stdin', async () => {
    const child = spawnReturning(exitWith(0))

    await runDocker(['login'], { cwd: '/work', input: 'pa55word' })

    expect(child.stdinData()).toBe('pa55word')
  })

  it('reports a failure with redacted argv and sanitized stderr', async () => {
    spawnReturning(exitWith(1, 'ERROR: failed to use s3cretvalue here\n'))

    const error = await rejection(
      runDocker(['build', '--build-arg', 'TOKEN=s3cretvalue', '.'], { cwd: '/work' })
    )

    expect(error.message).toContain('Docker command failed with exit code 1')
    expect(error.message).toContain('Command: docker build --build-arg TOKEN=*** .')
    expect(error.message).toContain('Directory: /work')
    expect(error.message).toContain('Output:\nERROR: failed to use *** here')
    expect(error.message).not.toContain('s3cretvalue')
  })

  it('does not mask short build arg values in stderr', async () => {
    spawnReturning(exitWith(1, 'step 1 of 2'))

    const error = await rejection(runDocker(['build', '--build-arg', 'N=1', '.'], { cwd: '/w' }))

    expect(error.message).toContain('step 1 of 2')
  })

  it('keeps only the tail of long stderr', async () => {
    spawnReturning(exitWith(1, `${'x'.repeat(5000)}END`))

    const error = await rejection(runDocker(['push', 'a:v1'], { cwd: '/w' }))

    expect(error.message).toMatch(/END$/)
    expect(error.message.length).toBeLessThan(4200)
  })

  it('omits stderr when a secret was passed on stdin', async () => {
    spawnReturning(exitWith(1, 'Error: bad credentials pa55word'))

    const error = await rejection(runDocker(['login'], { cwd: '/w', input: 'pa55word' }))

    expect(error.message).toContain('Docker command failed with exit code 1')
    expect(error.message).not.toContain('pa55word')
    expect(error.message).not.toContain('Output')
  })

  it('reports a missing docker binary', async () => {
    spawnReturning((child) => {
      child.emit('error', Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }))
    })

    const error = await rejection(runDocker(['push', 'a:v1'], { cwd: '/w' }))

    expect(error.message).toContain('docker was not found on PATH')
  })

  it('reports any other start failure generically', async () => {
    spawnReturning((child) => {
      child.emit('error', Object.assign(new Error('EACCES'), { code: 'EACCES' }))
    })

    const error = await rejection(runDocker(['push', 'a:v1'], { cwd: '/w' }))

    expect(error.message).toContain('Docker command failed: failed to start')
  })

  it('ignores stdin errors after the process exits', async () => {
    spawnReturning((child) => {
      child.stdin.emit('error', new Error('EPIPE'))
      exitWith(0)(child)
    })

    await expect(runDocker(['login'], { cwd: '/w', input: 'x' })).resolves.toBeUndefined()
  })
})
