import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import * as crypto from 'crypto'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { PassThrough } from 'stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { graphqlRequest } from './client'
import {
  LAMBDA_ZIP_MAX_BYTES,
  assertLambdaZipFits,
  cleanStagingDir,
  copyToStagingDir,
  executeCliTask,
  getStagingDirPath,
  isPathExcluded,
  removeStagingDir,
} from './tasks'
import type {
  ArtifactUploadInputs,
  ContainerPushInputs,
  LocalBuildInputs,
  S3UploadInputs,
  TaskContext,
} from './tasks'

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}))

vi.mock('./client', () => ({
  graphqlRequest: vi.fn(),
}))

const s3 = vi.hoisted(() => ({
  clientConfigs: [] as unknown[],
  send: vi.fn(),
}))

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = s3.send
    constructor(config: unknown) {
      s3.clientConfigs.push(config)
    }
  },
  PutObjectCommand: class {
    constructor(
      readonly input: { Bucket: string; Key: string; Body: Buffer; ContentType: string }
    ) {}
  },
}))

const mockSpawn = vi.mocked(spawn)
const mockGraphqlRequest = vi.mocked(graphqlRequest)

interface SpawnCall {
  command: string
  args: string[]
  shell: unknown
  stdin: string
}

let spawnCalls: SpawnCall[] = []
let exitCodeFor: (args: string[]) => number = () => 0

beforeEach(() => {
  spawnCalls = []
  exitCodeFor = () => 0
  mockSpawn.mockReset()
  mockSpawn.mockImplementation(((command: string, args: string[], options: { shell?: unknown }) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      stdin: PassThrough
    }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new PassThrough()
    const call: SpawnCall = { command, args, shell: options.shell, stdin: '' }
    spawnCalls.push(call)
    child.stdin.on('data', (chunk: Buffer) => {
      call.stdin += chunk.toString()
    })
    setImmediate(() => child.emit('close', exitCodeFor(args)))
    return child as unknown as ChildProcess
  }) as unknown as typeof spawn)
})

describe('isPathExcluded', () => {
  it('returns false when no patterns are provided', () => {
    expect(isPathExcluded('wp-content/uploads/a.jpg')).toBe(false)
    expect(isPathExcluded('wp-content/uploads/a.jpg', [])).toBe(false)
  })

  it('matches a nested-path glob against the full relative path', () => {
    expect(isPathExcluded('wp-content/uploads/2026/06/a.jpg', ['wp-content/uploads/**'])).toBe(true)
    expect(isPathExcluded('wp-content/themes/x/style.css', ['wp-content/uploads/**'])).toBe(false)
  })

  it('matches extension globs at any depth', () => {
    expect(isPathExcluded('a/b/c.log', ['**/*.log'])).toBe(true)
    expect(isPathExcluded('top.log', ['**/*.log'])).toBe(true)
    expect(isPathExcluded('a/b/c.txt', ['**/*.log'])).toBe(false)
  })

  it('matches a top-level directory glob', () => {
    expect(isPathExcluded('vendor/aws/sdk.php', ['vendor/**'])).toBe(true)
    expect(isPathExcluded('app/vendor/x.php', ['vendor/**'])).toBe(false)
  })

  it('normalizes leading ./ and backslashes so matching is path-format agnostic', () => {
    expect(isPathExcluded('./wp-content/uploads/a.jpg', ['wp-content/uploads/**'])).toBe(true)
    expect(isPathExcluded('wp-content\\uploads\\a.jpg', ['wp-content/uploads/**'])).toBe(true)
  })

  it('returns true if any pattern matches', () => {
    expect(isPathExcluded('readme.md', ['**/*.php', '**/*.md'])).toBe(true)
    expect(isPathExcluded('index.php', ['**/*.php', '**/*.md'])).toBe(true)
    expect(isPathExcluded('index.html', ['**/*.php', '**/*.md'])).toBe(false)
  })
})

const context = (overrides: Partial<TaskContext> = {}): TaskContext => ({
  stagingDir: '/stage',
  cwd: '/cwd',
  ...overrides,
})

const localBuild = (overrides: Partial<LocalBuildInputs> = {}): LocalBuildInputs => ({
  __typename: 'LocalBuildCliInputs',
  stepId: 'step-1',
  serviceName: 'api',
  versionNumber: 3,
  projectId: 'p9ue62',
  projectSlug: 'shop',
  buildCommands: null,
  dockerfile: null,
  workingDir: null,
  dockerTarget: null,
  namedBuildName: null,
  buildArgs: null,
  ...overrides,
})

const s3Upload = (overrides: Partial<S3UploadInputs> = {}): S3UploadInputs => ({
  __typename: 'S3UploadCliInputs',
  stepId: 'step-1',
  sourcePath: 'dist',
  includePatterns: null,
  excludePatterns: null,
  ...overrides,
})

const containerPush = (overrides: Partial<ContainerPushInputs> = {}): ContainerPushInputs => ({
  __typename: 'ContainerPushCliInputs',
  stepId: 'step-1',
  imageUri: '123456789.dkr.ecr.us-east-1.amazonaws.com/my-repo:v1',
  localImageTag: 'p9ue62-my-api-api-docker:v3',
  ecrAuthToken: Buffer.from('AWS:test-password').toString('base64'),
  ecrEndpoint: 'https://123456789.dkr.ecr.us-east-1.amazonaws.com',
  ...overrides,
})

const artifactUpload = (overrides: Partial<ArtifactUploadInputs> = {}): ArtifactUploadInputs => ({
  __typename: 'ArtifactUploadCliInputs',
  stepId: 'step-1',
  bucketName: 'artifacts',
  s3Key: 'svc/v3.zip',
  region: 'us-east-1',
  accessKeyId: 'AKIA',
  secretAccessKey: 'secret',
  sessionToken: 'token',
  sourcePath: '.',
  excludePatterns: null,
  ...overrides,
})

describe('executeCliTask', () => {
  describe('container-push', () => {
    const imageUri = '123456789.dkr.ecr.us-east-1.amazonaws.com/my-repo:v1'
    const localImageTag = 'p9ue62-my-api-api-docker:v3'
    const ecrEndpoint = 'https://123456789.dkr.ecr.us-east-1.amazonaws.com'
    const password = 'pa$$word;$(touch pwned)`id`'
    const ecrAuthToken = Buffer.from(`AWS:${password}`).toString('base64')

    it('throws when imageUri is missing', async () => {
      await expect(executeCliTask(containerPush({ imageUri: '' }), context())).rejects.toThrow(
        'imageUri is required for container-push task'
      )
    })

    it('throws when localImageTag is missing', async () => {
      await expect(executeCliTask(containerPush({ localImageTag: '' }), context())).rejects.toThrow(
        'localImageTag is required for container-push task'
      )
    })

    it.each([
      { ecrAuthToken: null, ecrEndpoint },
      { ecrAuthToken, ecrEndpoint: '' },
      { ecrAuthToken: '', ecrEndpoint: '' },
    ])('refuses to push without ECR credentials (%j)', async (credentials) => {
      await expect(executeCliTask(containerPush(credentials), context())).rejects.toThrow(
        'ECR credentials are required for container-push task'
      )
      expect(spawnCalls).toEqual([])
    })

    it('runs docker in the working directory', async () => {
      await executeCliTask(containerPush(), context())

      expect(mockSpawn).toHaveBeenCalledWith(
        'docker',
        expect.any(Array),
        expect.objectContaining({ cwd: '/cwd' })
      )
    })

    it('passes the ECR password on stdin and never in argv', async () => {
      await executeCliTask(containerPush({ ecrAuthToken, ecrEndpoint }), context())

      const [login, tag, push] = spawnCalls
      expect(login.args).toEqual(['login', '--username', 'AWS', '--password-stdin', ecrEndpoint])
      expect(login.shell).toBe(false)
      expect(login.stdin).toBe(password)
      for (const call of spawnCalls) {
        expect(call.args.join(' ')).not.toContain(password)
      }
      expect(tag.args).toEqual(['tag', localImageTag, imageUri])
      expect(push.args).toEqual(['push', imageUri])
    })

    it('keeps a colon inside the ECR password', async () => {
      const colonPassword = 'part-one:part-two'
      await executeCliTask(
        containerPush({
          ecrAuthToken: Buffer.from(`AWS:${colonPassword}`).toString('base64'),
          ecrEndpoint,
        }),
        context()
      )

      expect(spawnCalls[0].stdin).toBe(colonPassword)
    })

    it('keeps the password out of the error when docker login fails', async () => {
      exitCodeFor = (args) => (args[0] === 'login' ? 1 : 0)

      const error = await executeCliTask(
        containerPush({ ecrAuthToken, ecrEndpoint }),
        context()
      ).catch((e: unknown) => e as Error)

      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain('Docker command failed with exit code 1')
      expect((error as Error).message).not.toContain(password)
      expect(spawnCalls).toHaveLength(1)
    })

    it('rejects an undecodable auth token', async () => {
      await expect(
        executeCliTask(
          containerPush({
            ecrAuthToken: Buffer.from('nocolon').toString('base64'),
            ecrEndpoint,
          }),
          context()
        )
      ).rejects.toThrow('Failed to decode ECR authorization token')
    })

    it.each([
      [containerPush({ imageUri: 'repo:v1; touch x' }), /Invalid image URI/],
      [containerPush({ localImageTag: '$(touch x)' }), /Invalid local image tag/],
      [
        containerPush({ ecrAuthToken, ecrEndpoint: '--help' }),
        /Invalid container registry endpoint/,
      ],
    ])('rejects invalid references before running docker (%#)', async (inputs, message) => {
      await expect(executeCliTask(inputs, context())).rejects.toThrow(message)
      expect(spawnCalls).toHaveLength(0)
    })

    it('returns success with imageUri and localImageTag', async () => {
      const result = await executeCliTask(
        containerPush({ imageUri: 'my-repo:v1', localImageTag: 'gantry-build:api-worker-v1' }),
        context()
      )

      expect(result).toEqual({
        outputs: {
          containerPush: {
            imageUri: 'my-repo:v1',
            localImageTag: 'gantry-build:api-worker-v1',
            success: true,
          },
        },
      })
    })
  })

  describe('local-build', () => {
    const dockerBuild = (overrides: Partial<LocalBuildInputs> = {}) =>
      localBuild({ dockerfile: 'Dockerfile', ...overrides })

    it('passes hostile build arg values through as single literal argv elements', async () => {
      const buildArgs = [
        { name: 'SUBST', value: '$(touch x)' },
        { name: 'TICKS', value: '`touch x`' },
        { name: 'SEMI', value: 'a; rm -rf /' },
        { name: 'SPACES', value: 'hello world' },
      ]

      const result = await executeCliTask(
        dockerBuild({ dockerTarget: 'runtime', buildArgs }),
        context()
      )

      expect(spawnCalls).toHaveLength(1)
      expect(spawnCalls[0]).toEqual({
        command: 'docker',
        args: [
          'build',
          '-t',
          'p9ue62-shop-api:v3',
          '-f',
          'Dockerfile',
          '--target',
          'runtime',
          '--build-arg',
          'SUBST=$(touch x)',
          '--build-arg',
          'TICKS=`touch x`',
          '--build-arg',
          'SEMI=a; rm -rf /',
          '--build-arg',
          'SPACES=hello world',
          '.',
        ],
        shell: false,
        stdin: '',
      })
      expect(mockSpawn).toHaveBeenCalledWith(
        'docker',
        expect.any(Array),
        expect.objectContaining({ cwd: '/stage' })
      )
      expect(result.outputs.localBuild?.localImageTag).toBe('p9ue62-shop-api:v3')
    })

    it('masks build arg values when the docker build fails', async () => {
      exitCodeFor = () => 1

      const error = await executeCliTask(
        dockerBuild({ buildArgs: [{ name: 'TOKEN', value: 'sup3rs3cret' }] }),
        context()
      ).catch((e: unknown) => e as Error)

      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain('--build-arg TOKEN=***')
      expect((error as Error).message).not.toContain('sup3rs3cret')
    })

    it('rejects an invalid build arg key before running docker', async () => {
      await expect(
        executeCliTask(dockerBuild({ buildArgs: [{ name: 'X;id', value: 'v' }] }), context())
      ).rejects.toThrow(/Invalid Docker build arg name/)
      expect(spawnCalls).toHaveLength(0)
    })

    it('rejects an invalid image tag before running docker', async () => {
      await expect(
        executeCliTask(dockerBuild({ namedBuildName: 'API Server' }), context())
      ).rejects.toThrow(/not a valid Docker image reference/)
      expect(spawnCalls).toHaveLength(0)
    })

    it('still runs user build commands through a shell', async () => {
      await executeCliTask(localBuild({ buildCommands: ['npm ci && npm run build'] }), context())

      expect(mockSpawn).toHaveBeenCalledWith(
        'npm ci && npm run build',
        [],
        expect.objectContaining({ shell: true })
      )
    })
  })

  describe('s3-upload', () => {
    let root: string
    let outside: string
    let fetchMock: ReturnType<
      typeof vi.fn<(url: string, init: { body: Buffer }) => Promise<unknown>>
    >
    let uploadsFor: (manifest: { path: string; hash: string }[]) => unknown[]
    let beforeUpload: () => void

    const write = (base: string, rel: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true })
      fs.writeFileSync(path.join(base, rel), content)
    }

    const presigned = (p: string) => ({
      path: p,
      s3Key: `site/${p}`,
      url: `https://bucket.s3.amazonaws.com/site/${p}?sig=1`,
      contentType: 'text/plain',
    })

    const upload = (sourcePath = 'dist') =>
      executeCliTask(s3Upload({ sourcePath }), context({ stagingDir: root }))

    const uploadedBodies = () =>
      Object.fromEntries(
        fetchMock.mock.calls.map(([url, init]) => [
          new URL(url).pathname.replace('/site/', ''),
          init.body.toString(),
        ])
      )

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-upload-root-'))
      outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-upload-outside-'))
      write(outside, 'secret.txt', 'outside secret')
      write(root, 'dist/index.html', '<html></html>')

      uploadsFor = (manifest) => manifest.map((f) => presigned(f.path))
      beforeUpload = () => undefined
      let submitted: { path: string; hash: string }[] = []
      mockGraphqlRequest.mockReset()
      mockGraphqlRequest.mockImplementation(
        (query: string, variables?: Record<string, unknown>) => {
          if (query.includes('SubmitManifest')) {
            submitted = (variables as { input: { files: typeof submitted } }).input.files
            return Promise.resolve({ submitManifest: { success: true } })
          }
          beforeUpload()
          return Promise.resolve({
            deploymentStep: {
              id: 'step-1',
              status: 'AWAITING_CLI',
              cliInputs: {
                __typename: 'S3UploadCliInputs',
                uploadUrls: { store: uploadsFor(submitted) },
              },
            },
          })
        }
      )

      fetchMock = vi.fn((_url: string, _init: { body: Buffer }) =>
        Promise.resolve<unknown>({ ok: true, status: 200, statusText: 'OK' })
      )
      vi.stubGlobal('fetch', fetchMock)
    })

    afterEach(() => {
      vi.unstubAllGlobals()
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    })

    it('uploads through in-root file and directory symlinks', async () => {
      write(root, 'shared/logo.svg', '<svg/>')
      write(root, 'assets/app.js', 'js')
      fs.symlinkSync('../shared/logo.svg', path.join(root, 'dist', 'logo.svg'))
      fs.symlinkSync('../assets', path.join(root, 'dist', 'assets'))

      const result = await upload()

      expect(result.outputs.s3Upload?.uploadedFiles).toBe(3)
      expect(uploadedBodies()).toEqual({
        'index.html': '<html></html>',
        'logo.svg': '<svg/>',
        'assets/app.js': 'js',
      })
    })

    it('does not loop on a directory symlink cycle', async () => {
      fs.symlinkSync('..', path.join(root, 'dist', 'loop'))

      const result = await upload('.')

      expect(Object.keys(uploadedBodies())).toEqual(['dist/index.html'])
      expect(result.outputs.s3Upload?.uploadedFiles).toBe(1)
    })

    it('rejects a file symlink that escapes the project', async () => {
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'dist', 'leak.txt'))

      await expect(upload()).rejects.toThrow(
        '"leak.txt" is a symlink that points outside the project directory'
      )
      expect(mockGraphqlRequest).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('rejects a directory symlink that escapes the project', async () => {
      fs.symlinkSync(outside, path.join(root, 'dist', 'ext'))

      await expect(upload()).rejects.toThrow(/"ext" is a symlink that points outside/)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('rejects a broken symlink', async () => {
      fs.symlinkSync('missing.txt', path.join(root, 'dist', 'broken.txt'))

      await expect(upload()).rejects.toThrow(/"broken.txt": it is missing or a broken symlink/)
    })

    it('rejects a source_dir outside the project', async () => {
      await expect(upload(path.relative(root, outside))).rejects.toThrow(
        /resolves outside the project directory/
      )
    })

    it('accepts an in-project source_dir whose name starts with two dots', async () => {
      write(root, '..data/index.html', '<html></html>')

      await upload('..data')

      expect(uploadedBodies()).toEqual({ 'index.html': '<html></html>' })
    })

    it('rejects a source_dir that is a symlink out of the project', async () => {
      fs.symlinkSync(outside, path.join(root, 'public'))

      await expect(upload('public')).rejects.toThrow(/resolves outside the project directory/)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('rejects an API-supplied ../ path without uploading the valid entries', async () => {
      uploadsFor = () => [presigned('index.html'), presigned('../outside.txt')]

      await expect(upload('dist')).rejects.toThrow(/"\.\.\/outside\.txt": path must be relative/)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it.each([
      [
        'a path not in the manifest',
        () => [presigned('other.html')],
        /not in the submitted manifest/,
      ],
      ['an absolute path', () => [presigned('/etc/passwd')], /path must be relative/],
      ['a traversal segment', () => [presigned('sub/../../x')], /path must be relative/],
      [
        'a non-https URL',
        () => [{ ...presigned('index.html'), url: 'http://bucket/index.html' }],
        /must use https/,
      ],
      [
        'an invalid URL',
        () => [{ ...presigned('index.html'), url: 'not a url' }],
        /upload URL is invalid/,
      ],
    ])('rejects %s before uploading anything', async (_label, uploads, message) => {
      uploadsFor = uploads

      await expect(upload()).rejects.toThrow(message)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('rejects a manifest file swapped for an escaping symlink after the scan', async () => {
      beforeUpload = () => {
        fs.rmSync(path.join(root, 'dist', 'index.html'))
        fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'dist', 'index.html'))
      }

      await expect(upload()).rejects.toThrow(/points outside the project directory/)
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  describe('artifact-upload', () => {
    it('rejects a source_dir outside the project before zipping', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-artifact-'))
      try {
        await expect(
          executeCliTask(artifactUpload({ sourcePath: '..' }), context({ stagingDir: root }))
        ).rejects.toThrow('source_dir ".." resolves outside the project directory')
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  })

  describe('assertLambdaZipFits', () => {
    it('accepts a zip at or below the limit', () => {
      expect(() => {
        assertLambdaZipFits(0, '/work/dist')
      }).not.toThrow()
      expect(() => {
        assertLambdaZipFits(LAMBDA_ZIP_MAX_BYTES, '/work/dist')
      }).not.toThrow()
    })

    it('reports size, limit, and source path when the zip exceeds the limit', () => {
      const oversize = LAMBDA_ZIP_MAX_BYTES + 1
      expect(() => {
        assertLambdaZipFits(oversize, '/work/dist')
      }).toThrow(/Lambda zip is .* MB, which exceeds the 50 MB limit\..*\/work\/dist.*source_dir/s)
    })
  })
})

describe('copyToStagingDir', () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-staging-'))
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  const staged = (...segments: string[]) => path.join(getStagingDirPath(projectDir), ...segments)

  /** `lift` always cleans before it copies; `copyToStagingDir` assumes that. */
  const stage = (useGitignore: boolean) => {
    cleanStagingDir(projectDir)
    copyToStagingDir(projectDir, useGitignore)
  }

  it('recreates a symlink to a file instead of copying its target', () => {
    // The `node_modules/.bin/*` shape: a link whose target resolves imports
    // relative to its own directory, so a flattened copy breaks at runtime.
    fs.mkdirSync(path.join(projectDir, 'pkg', 'bin'), { recursive: true })
    fs.mkdirSync(path.join(projectDir, '.bin'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'pkg', 'bin', 'cli.js'), "import '../dist/cli.js'\n")
    fs.symlinkSync('../pkg/bin/cli.js', path.join(projectDir, '.bin', 'tool'))

    stage(false)

    const link = staged('.bin', 'tool')
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(link)).toBe('../pkg/bin/cli.js')
    // Resolves through the link to the copied target, so the binary still runs.
    expect(fs.readFileSync(link, 'utf-8')).toBe("import '../dist/cli.js'\n")
  })

  it('recreates a symlink to a directory rather than throwing EISDIR', () => {
    fs.mkdirSync(path.join(projectDir, 'real'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'real', 'a.txt'), 'a')
    fs.symlinkSync('real', path.join(projectDir, 'aliased'))

    expect(() => {
      stage(false)
    }).not.toThrow()

    expect(fs.lstatSync(staged('aliased')).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(staged('aliased', 'a.txt'), 'utf-8')).toBe('a')
  })

  it('skips a gitignored symlink', () => {
    fs.writeFileSync(path.join(projectDir, '.gitignore'), 'node_modules/\n')
    fs.mkdirSync(path.join(projectDir, 'node_modules'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'target.js'), 'x')
    fs.symlinkSync('../target.js', path.join(projectDir, 'node_modules', 'link.js'))

    stage(true)

    expect(fs.existsSync(staged('node_modules'))).toBe(false)
  })

  it('copies regular files and skips the staging directory itself', () => {
    fs.writeFileSync(path.join(projectDir, 'index.html'), '<html></html>')
    fs.mkdirSync(path.join(projectDir, '.gantry'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, '.gantry', 'stale.txt'), 'old')

    stage(false)

    expect(fs.readFileSync(staged('index.html'), 'utf-8')).toBe('<html></html>')
    expect(fs.existsSync(staged('.gantry'))).toBe(false)
  })

  it('applies a nested .gitignore relative to its own directory', () => {
    fs.writeFileSync(path.join(projectDir, '.gitignore'), 'node_modules/\n')
    fs.mkdirSync(path.join(projectDir, 'nested', 'deeper'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'nested', '.gitignore'), '.env\n/local.txt\n')
    fs.writeFileSync(path.join(projectDir, 'nested', '.env'), 'SECRET=1')
    fs.writeFileSync(path.join(projectDir, 'nested', 'local.txt'), 'x')
    fs.writeFileSync(path.join(projectDir, 'nested', 'deeper', '.env'), 'SECRET=2')
    fs.writeFileSync(path.join(projectDir, 'nested', 'deeper', 'local.txt'), 'kept')
    fs.writeFileSync(path.join(projectDir, '.env'), 'ROOT=1')

    stage(true)

    expect(fs.existsSync(staged('nested', '.env'))).toBe(false)
    expect(fs.existsSync(staged('nested', 'deeper', '.env'))).toBe(false)
    expect(fs.existsSync(staged('nested', 'local.txt'))).toBe(false)
    expect(fs.readFileSync(staged('nested', 'deeper', 'local.txt'), 'utf-8')).toBe('kept')
    expect(fs.existsSync(staged('nested', '.gitignore'))).toBe(true)
    // Sibling rules do not leak upward.
    expect(fs.readFileSync(staged('.env'), 'utf-8')).toBe('ROOT=1')
  })

  it('lets a child .gitignore negation override its parent', () => {
    fs.writeFileSync(path.join(projectDir, '.gitignore'), '*.log\n')
    fs.mkdirSync(path.join(projectDir, 'logs'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'logs', '.gitignore'), '!keep.log\n')
    fs.writeFileSync(path.join(projectDir, 'logs', 'keep.log'), 'kept')
    fs.writeFileSync(path.join(projectDir, 'logs', 'drop.log'), 'x')
    fs.writeFileSync(path.join(projectDir, 'top.log'), 'x')

    stage(true)

    expect(fs.readFileSync(staged('logs', 'keep.log'), 'utf-8')).toBe('kept')
    expect(fs.existsSync(staged('logs', 'drop.log'))).toBe(false)
    expect(fs.existsSync(staged('top.log'))).toBe(false)
  })

  it('keeps directories but drops contents for the Laravel "*" / "!.gitignore" pattern', () => {
    fs.mkdirSync(path.join(projectDir, 'storage', 'cache', 'data'), { recursive: true })
    fs.writeFileSync(
      path.join(projectDir, 'storage', 'cache', '.gitignore'),
      '*\n!data/\n!.gitignore\n'
    )
    fs.writeFileSync(
      path.join(projectDir, 'storage', 'cache', 'data', '.gitignore'),
      '*\n!.gitignore\n'
    )
    fs.writeFileSync(path.join(projectDir, 'storage', 'cache', 'data', 'abc'), 'cached')
    fs.writeFileSync(path.join(projectDir, 'storage', 'cache', 'stale'), 'cached')

    stage(true)

    expect(fs.existsSync(staged('storage', 'cache', '.gitignore'))).toBe(true)
    expect(fs.existsSync(staged('storage', 'cache', 'data', '.gitignore'))).toBe(true)
    expect(fs.existsSync(staged('storage', 'cache', 'data', 'abc'))).toBe(false)
    expect(fs.existsSync(staged('storage', 'cache', 'stale'))).toBe(false)
  })

  it('keeps legitimate public dotfiles', () => {
    fs.writeFileSync(path.join(projectDir, '.gitignore'), '.env\n')
    fs.mkdirSync(path.join(projectDir, 'public', '.well-known'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'public', '.well-known', 'security.txt'), 'x')
    fs.writeFileSync(path.join(projectDir, 'public', '.htaccess'), 'RewriteEngine On')
    fs.writeFileSync(path.join(projectDir, 'public', '.nojekyll'), '')

    stage(true)

    expect(fs.existsSync(staged('public', '.well-known', 'security.txt'))).toBe(true)
    expect(fs.existsSync(staged('public', '.htaccess'))).toBe(true)
    expect(fs.existsSync(staged('public', '.nojekyll'))).toBe(true)
  })

  it('ignores every .gitignore when use_gitignore is false', () => {
    fs.writeFileSync(path.join(projectDir, '.gitignore'), '*.php\n')
    fs.mkdirSync(path.join(projectDir, 'nested'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'nested', '.gitignore'), '.env\n')
    fs.writeFileSync(path.join(projectDir, 'index.php'), '<?php')
    fs.writeFileSync(path.join(projectDir, 'nested', '.env'), 'X=1')

    stage(false)

    expect(fs.existsSync(staged('index.php'))).toBe(true)
    expect(fs.existsSync(staged('nested', '.env'))).toBe(true)
  })

  it('always excludes .git even when a .gitignore negates it', () => {
    fs.writeFileSync(path.join(projectDir, '.gitignore'), '!.git/\n')
    fs.mkdirSync(path.join(projectDir, '.git'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, '.git', 'HEAD'), 'ref')

    stage(true)

    expect(fs.existsSync(staged('.git'))).toBe(false)
  })

  it('excludes a .git file, as used by submodules and worktrees', () => {
    fs.mkdirSync(path.join(projectDir, 'vendor', 'lib'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, '.git'), 'gitdir: /home/dev/repo/.git/worktrees/x\n')
    fs.writeFileSync(
      path.join(projectDir, 'vendor', 'lib', '.git'),
      'gitdir: ../../.git/modules/lib\n'
    )

    stage(true)

    expect(fs.existsSync(staged('.git'))).toBe(false)
    expect(fs.existsSync(staged('vendor/lib/.git'))).toBe(false)
  })
})

function spawnFailingWith(outcome: { code?: number; stderr?: string; error?: Error }) {
  mockSpawn.mockImplementationOnce(() => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    setImmediate(() => {
      if (outcome.error) {
        child.emit('error', outcome.error)
        return
      }
      if (outcome.stderr) child.stderr.emit('data', Buffer.from(outcome.stderr))
      child.emit('close', outcome.code ?? 1)
    })
    return child as unknown as ChildProcess
  })
}

describe('local-build commands', () => {
  it('runs every command in order through a shell and records them', async () => {
    const result = await executeCliTask(
      localBuild({ buildCommands: ['npm ci', 'npm run build'] }),
      context()
    )

    expect(spawnCalls.map((call) => [call.command, call.shell])).toEqual([
      ['npm ci', true],
      ['npm run build', true],
    ])
    expect(result).toEqual({
      outputs: {
        localBuild: { serviceName: 'api', success: true, buildCommands: 'npm ci && npm run build' },
      },
    })
  })

  it('stops at the first failing command and reports its exit code and output', async () => {
    spawnFailingWith({ code: 2, stderr: 'Type error in app.ts\n' })

    await expect(
      executeCliTask(localBuild({ buildCommands: ['tsc', 'vite build'] }), context())
    ).rejects.toThrow(
      'Build command failed with exit code 2\nCommand: tsc\nDirectory: /stage\nOutput:\nType error in app.ts'
    )
    expect(mockSpawn).toHaveBeenCalledOnce()
  })

  it('omits the output section when the failing command wrote nothing to stderr', async () => {
    spawnFailingWith({ code: 1 })

    await expect(
      executeCliTask(localBuild({ buildCommands: ['false'] }), context())
    ).rejects.toThrow('Build command failed with exit code 1\nCommand: false\nDirectory: /stage')
  })

  it('reports a command that cannot start', async () => {
    spawnFailingWith({ error: new Error('spawn sh ENOENT') })

    await expect(
      executeCliTask(localBuild({ buildCommands: ['make'] }), context())
    ).rejects.toThrow('Build command failed to start: spawn sh ENOENT')
  })
})

describe('local-build without docker', () => {
  it('runs build commands in the working directory under staging and skips docker', async () => {
    const result = await executeCliTask(
      localBuild({ serviceName: 'web', buildCommands: ['npm run build'], workingDir: 'apps/web' }),
      context()
    )

    expect(mockSpawn).toHaveBeenCalledOnce()
    expect(mockSpawn).toHaveBeenCalledWith(
      'npm run build',
      [],
      expect.objectContaining({ cwd: path.join('/stage', 'apps/web'), shell: true })
    )
    expect(result).toEqual({
      outputs: {
        localBuild: { serviceName: 'web', success: true, buildCommands: 'npm run build' },
      },
    })
  })

  it.each([
    ['the named build name', 'api-docker', 'p9ue62-shop-api-docker:v3'],
    ['the service name when the named build name is empty', '', 'p9ue62-shop-web:v3'],
  ])('tags the image with the project prefix and %s', async (_label, namedBuildName, tag) => {
    const result = await executeCliTask(
      localBuild({ serviceName: 'web', dockerfile: 'Dockerfile', namedBuildName }),
      context()
    )

    expect(result.outputs.localBuild?.localImageTag).toBe(tag)
    expect(spawnCalls[0].args).toContain(tag)
  })
})

describe('s3-upload task flow', () => {
  let root: string
  let fetchMock: ReturnType<typeof vi.fn<(url: string) => Promise<unknown>>>

  const write = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), content)
  }

  const presigned = (p: string) => ({
    path: p,
    s3Key: `site/${p}`,
    url: `https://bucket.s3.amazonaws.com/site/${p}`,
    contentType: 'text/plain',
  })

  const awaitingCli = (store: ReturnType<typeof presigned>[]) => ({
    id: 'step-1',
    status: 'AWAITING_CLI',
    cliInputs: { __typename: 'S3UploadCliInputs', uploadUrls: { store } },
  })

  const upload = (inputs: Partial<S3UploadInputs> = {}, overrides: Partial<TaskContext> = {}) =>
    executeCliTask(s3Upload(inputs), context({ stagingDir: root, ...overrides }))

  function stepResponses(...steps: unknown[]) {
    mockGraphqlRequest.mockImplementation((query: string) => {
      if (query.includes('SubmitManifest')) {
        return Promise.resolve({ submitManifest: { success: true } })
      }
      return Promise.resolve({ deploymentStep: steps.length > 1 ? steps.shift() : steps[0] })
    })
  }

  function submittedManifest() {
    const call = mockGraphqlRequest.mock.calls.find(([query]) => query.includes('SubmitManifest'))
    return (call?.[1] as { input: { files: { path: string }[]; force: boolean; delete: boolean } })
      .input
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-s3-flow-'))
    write('dist/index.html', '<html></html>')
    write('dist/app.js', 'js')
    write('dist/app.js.map', 'map')
    mockGraphqlRequest.mockReset()
    fetchMock = vi.fn((_url: string) =>
      Promise.resolve<unknown>({ ok: true, status: 200, statusText: 'OK' })
    )
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('requires a step id', async () => {
    await expect(upload({ stepId: '' })).rejects.toThrow('stepId is required for s3-upload task')
  })

  it('filters the manifest by include and exclude globs and forwards force/delete', async () => {
    stepResponses(awaitingCli([presigned('app.js')]))

    const result = await upload(
      { includePatterns: ['*.js', '*.map'], excludePatterns: ['**/*.map'] },
      { force: true, delete: true }
    )

    const input = submittedManifest()
    expect(input.files.map((file) => file.path)).toEqual(['app.js'])
    expect(input.force).toBe(true)
    expect(input.delete).toBe(true)
    expect(result).toEqual({
      outputs: { s3Upload: { uploadedFiles: 1, totalSize: 2, success: true } },
      fileResults: [
        {
          path: 'app.js',
          hash: crypto.createHash('md5').update('js').digest('hex'),
          success: true,
        },
      ],
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://bucket.s3.amazonaws.com/site/app.js',
      expect.objectContaining({ method: 'PUT', headers: { 'Content-Type': 'text/plain' } })
    )
  })

  it('returns without calling the API when every file is filtered out', async () => {
    const result = await upload({ excludePatterns: ['**'] })

    expect(result).toEqual({
      outputs: { s3Upload: { uploadedFiles: 0, totalSize: 0, success: true } },
      fileResults: [],
    })
    expect(mockGraphqlRequest).not.toHaveBeenCalled()
  })

  it('uploads nothing when every file is reported unchanged', async () => {
    stepResponses(awaitingCli([]))

    const result = await upload()

    expect(result).toMatchObject({ outputs: { s3Upload: { uploadedFiles: 0 } }, fileResults: [] })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a step that is not an S3 upload', async () => {
    stepResponses({
      id: 'step-1',
      status: 'AWAITING_CLI',
      cliInputs: { __typename: 'ContainerPushCliInputs' },
    })

    await expect(upload()).rejects.toThrow('Step is not an S3 upload')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fails with the server message when the manifest is refused', async () => {
    mockGraphqlRequest.mockResolvedValueOnce({
      submitManifest: { success: false, message: 'Step is not awaiting upload.' },
    })

    await expect(upload()).rejects.toThrow('Step is not awaiting upload.')
  })

  it('falls back to a generic message when a refusal carries none', async () => {
    mockGraphqlRequest.mockResolvedValueOnce({ submitManifest: { success: false, message: '' } })

    await expect(upload()).rejects.toThrow('Failed to submit manifest')
  })

  it('fails when the step disappears while polling', async () => {
    stepResponses(null)

    await expect(upload()).rejects.toThrow('Step not found')
  })

  it('fails when the step fails while generating URLs', async () => {
    stepResponses({ id: 'step-1', status: 'FAILED', cliInputs: null })

    await expect(upload()).rejects.toThrow('Step failed while generating upload URLs')
  })

  it('keeps polling until the URLs are ready', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    stepResponses(
      { id: 'step-1', status: 'RUNNING', cliInputs: null },
      awaitingCli([presigned('index.html')])
    )

    const result = upload()
    await vi.advanceTimersByTimeAsync(2000)

    await expect(result).resolves.toMatchObject({ outputs: { s3Upload: { uploadedFiles: 1 } } })
  })

  it('gives up after the polling budget is spent', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    stepResponses({ id: 'step-1', status: 'RUNNING', cliInputs: null })

    const result = upload()
    const settled = expect(result).rejects.toThrow('Timed out waiting for upload URLs')
    await vi.advanceTimersByTimeAsync(60 * 2000)

    await settled
    expect(mockGraphqlRequest).toHaveBeenCalledTimes(61)
  })

  it('reports every failed upload together, after attempting them all', async () => {
    stepResponses(awaitingCli([presigned('index.html'), presigned('app.js')]))
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('index.html')
          ? { ok: false, status: 403, statusText: 'Forbidden' }
          : { ok: true, status: 200, statusText: 'OK' }
      )
    )

    await expect(upload()).rejects.toThrow('Failed to upload 1 files:\nindex.html: 403 Forbidden')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('reports a network error from an upload', async () => {
    stepResponses(awaitingCli([presigned('index.html')]))
    fetchMock.mockRejectedValue('socket hang up')

    await expect(upload()).rejects.toThrow('Failed to upload 1 files:\nsocket hang up')
  })
})

describe('artifact-upload task flow', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-artifact-flow-'))
    fs.mkdirSync(path.join(root, 'build', 'static'), { recursive: true })
    fs.writeFileSync(path.join(root, 'build', 'handler.js'), 'exports.handler = () => 1')
    fs.writeFileSync(path.join(root, 'build', 'static', 'huge-image.png'), 'png')
    s3.clientConfigs.length = 0
    s3.send.mockReset().mockResolvedValue({})
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('zips the source directory without excluded files and puts it with the session credentials', async () => {
    const result = await executeCliTask(
      artifactUpload({ sourcePath: 'build', excludePatterns: ['static/**'] }),
      context({ stagingDir: root })
    )

    expect(s3.clientConfigs).toEqual([
      {
        region: 'us-east-1',
        credentials: { accessKeyId: 'AKIA', secretAccessKey: 'secret', sessionToken: 'token' },
      },
    ])
    const command = s3.send.mock.calls[0][0] as {
      input: { Bucket: string; Key: string; Body: Buffer; ContentType: string }
    }
    expect(command.input).toMatchObject({
      Bucket: 'artifacts',
      Key: 'svc/v3.zip',
      ContentType: 'application/zip',
    })
    const zip = command.input.Body
    expect(zip.subarray(0, 2).toString()).toBe('PK')
    expect(zip.includes('handler.js')).toBe(true)
    expect(zip.includes('huge-image.png')).toBe(false)
    expect(result).toEqual({
      outputs: {
        artifactUpload: {
          bucketName: 'artifacts',
          s3Key: 'svc/v3.zip',
          zipSize: zip.length,
          success: true,
        },
      },
    })
  })

  it('zips the whole staging directory when the source path is empty', async () => {
    await executeCliTask(
      artifactUpload({ sourcePath: '' }),
      context({ stagingDir: path.join(root, 'build') })
    )

    const zip = (s3.send.mock.calls[0][0] as { input: { Body: Buffer } }).input.Body
    expect(zip.includes('static/huge-image.png')).toBe(true)
  })

  it('requires the bucket, key, and region', async () => {
    await expect(
      executeCliTask(artifactUpload({ region: '' }), context({ stagingDir: root }))
    ).rejects.toThrow('bucketName, s3Key, and region are required for artifact-upload task')
  })

  it('requires the full set of session credentials', async () => {
    await expect(
      executeCliTask(artifactUpload({ sessionToken: '' }), context({ stagingDir: root }))
    ).rejects.toThrow('AWS credentials (accessKeyId, secretAccessKey, sessionToken) are required')
    expect(s3.send).not.toHaveBeenCalled()
  })
})

describe('removeStagingDir', () => {
  it('removes the staging directory and tolerates it being absent', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-remove-staging-'))
    try {
      cleanStagingDir(projectDir)
      fs.writeFileSync(path.join(getStagingDirPath(projectDir), 'file'), 'x')

      removeStagingDir(projectDir)
      expect(fs.existsSync(getStagingDirPath(projectDir))).toBe(false)

      expect(() => {
        removeStagingDir(projectDir)
      }).not.toThrow()
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true })
    }
  })
})
