import type { ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { PassThrough } from 'stream'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

import type { ResolveYamlResult } from '../lib/resolve-yaml'
import type {
  ArtifactUploadInputs,
  CliInputs,
  ContainerPushInputs,
  LocalBuildInputs,
  S3UploadInputs,
  TaskResult,
} from '../lib/tasks'

const mocks = vi.hoisted(() => ({
  graphqlRequest: vi.fn(),
  resolveYaml: vi.fn(),
  executeCliTask: vi.fn(),
  cleanStagingDir: vi.fn(),
  copyToStagingDir: vi.fn(),
  removeStagingDir: vi.fn(),
  runDocker: vi.fn(),
  spawn: vi.fn(),
  printError: vi.fn(),
  printHeading: vi.fn(),
}))

vi.mock('child_process', () => ({ spawn: mocks.spawn }))
vi.mock(import('../lib/client'), async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, graphqlRequest: mocks.graphqlRequest }
})
vi.mock(import('../lib/resolve-yaml'), async (importOriginal) => ({
  ...(await importOriginal()),
  resolveYaml: mocks.resolveYaml,
}))
vi.mock('../lib/tasks', () => ({
  cleanStagingDir: mocks.cleanStagingDir,
  copyToStagingDir: mocks.copyToStagingDir,
  executeCliTask: mocks.executeCliTask,
  getStagingDirPath: (dir: string) => `${dir}/.gantry`,
  removeStagingDir: mocks.removeStagingDir,
}))
vi.mock(import('../lib/exec'), async (importOriginal) => ({
  ...(await importOriginal()),
  runDocker: mocks.runDocker,
}))
vi.mock('../lib/listr', () => ({
  resolveRenderer: () => 'silent',
  shouldUseFallbackRenderer: () => false,
}))
vi.mock(import('../lib/output'), async (importOriginal) => ({
  ...(await importOriginal()),
  printError: mocks.printError,
  printHeading: mocks.printHeading,
}))

const { GantryApiError } = await import('../lib/client')
const { getPhaseDisplay, registerLiftCommand } = await import('./lift')

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

type Handler = (variables: Record<string, unknown>) => unknown

const S3_INPUTS: S3UploadInputs = {
  __typename: 'S3UploadCliInputs',
  stepId: 'step_1',
  sourcePath: 'dist',
  includePatterns: null,
  excludePatterns: null,
}

const S3_RESULT: TaskResult = {
  outputs: { s3Upload: { uploadedFiles: 1, totalSize: 13, success: true } },
  fileResults: [{ path: 'index.html', hash: 'abc', success: true }],
}

const PENDING_STEP = {
  id: 'step_1',
  status: 'AWAITING_CLI',
  cliStatus: 'PENDING',
  executor: 'CLI',
  cliTask: 's3-upload',
  phase: 'UPLOADING',
}

const CLAIMED_STEP = { ...PENDING_STEP, cliInputs: S3_INPUTS }

function deployment(overrides: Record<string, unknown> = {}) {
  return { id: 'dep_1', serviceName: 'web', status: 'RUNNING', steps: [], ...overrides }
}

function resolved(config: Record<string, unknown>): ResolveYamlResult {
  return {
    ok: true,
    config,
    sourceYaml: '',
    resolvedYaml: '',
    variableProvenance: {},
    plan: { services: [], routing: [] },
  }
}

describe('lift command', () => {
  let workingDir: string
  let handlers: Record<string, Handler>
  let byVersion: unknown[][]
  let exitSpy: MockInstance
  let logSpy: MockInstance
  let onSpy: MockInstance
  let stderrSpy: MockInstance

  function sequence(...responses: unknown[][]) {
    byVersion = responses
  }

  function sigintHandler() {
    return onSpy.mock.calls.find(([event]) => event === 'SIGINT')?.[1] as () => void
  }

  function calls(operation: string) {
    return mocks.graphqlRequest.mock.calls.filter(([query]) =>
      (query as string).includes(operation)
    )
  }

  async function lift(args: string[] = []) {
    const program = new Command()
    program.exitOverride()
    registerLiftCommand(program)
    const run = program.parseAsync(['node', 'gantry', 'lift', ...args, '--cwd', workingDir])
    const state = { settled: false }
    const markSettled = () => {
      state.settled = true
    }
    run.then(markSettled, markSettled)
    for (let i = 0; i < 300 && !state.settled; i++) {
      await vi.advanceTimersByTimeAsync(2000)
    }
    await run
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
    workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-lift-'))
    fs.writeFileSync(path.join(workingDir, 'gantry.yml'), 'type: project\nid: proj_1\n')

    for (const mock of Object.values(mocks)) mock.mockReset()
    mocks.executeCliTask.mockResolvedValue(S3_RESULT)
    mocks.runDocker.mockResolvedValue(undefined)
    mocks.spawn.mockImplementation((() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough
        stderr: PassThrough
      }
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      queueMicrotask(() => child.emit('close', 0))
      return child as unknown as ChildProcess
    }) as never)
    mocks.resolveYaml.mockResolvedValue(
      resolved({ type: 'project', environments: { production: {} } })
    )

    sequence(
      [deployment({ steps: [PENDING_STEP] })],
      [deployment({ steps: [PENDING_STEP] })],
      [
        deployment({ status: 'COMPLETE' }),
        { id: 'dep_r', scope: 'project-env', status: 'RUNNING' },
        { id: 'dep_t', deploymentType: 'teardown', status: 'RUNNING' },
      ]
    )
    handlers = {
      CreateVersion: () => ({
        createVersion: {
          success: true,
          versionId: 'ver_1',
          versionNumber: 3,
          projectId: 'p9ue62',
          projectSlug: 'shop',
        },
      }),
      StartLiftDeployment: () => ({
        startDeployment: {
          success: true,
          deployment: { id: 'dep_1', projectName: 'Shop', environmentName: 'production' },
          deploymentIds: ['dep_1'],
          versionId: 'ver_1',
        },
      }),
      DeploymentsByVersion: () => ({
        deploymentsByVersion: byVersion.length > 1 ? byVersion.shift() : byVersion[0],
      }),
      ClaimStep: () => ({ claimStep: { success: true, step: CLAIMED_STEP } }),
      CompleteCliStep: () => ({ completeCliStep: { success: true } }),
      FailCliStep: () => ({ failCliStep: { success: true } }),
      GetLiftDeployment: () => ({ deployment: { id: 'dep_r', status: 'COMPLETE' } }),
      VersionRouteUrls: () => ({
        versionRouteUrls: [{ url: 'https://shop.example.com', path: '/', serviceName: 'web' }],
      }),
      VersionDnsRecords: () => ({
        versionDnsRecords: [
          {
            recordType: 'CNAME',
            name: 'shop.example.com',
            value: 'd1.cloudfront.net',
            managed: false,
          },
        ],
      }),
      CancelLiftDeployment: () => ({ cancelDeployment: { success: true } }),
    }
    mocks.graphqlRequest.mockImplementation((query: string, variables: Record<string, unknown>) => {
      const operation = Object.keys(handlers).find((name) => query.includes(`${name}(`))
      if (!operation) throw new Error(`Unexpected query: ${query}`)
      return Promise.resolve().then(() => handlers[operation](variables))
    })

    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitError(code as number | undefined)
    })
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    onSpy = vi.spyOn(process, 'on')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    process.exitCode = undefined
    fs.rmSync(workingDir, { recursive: true, force: true })
  })

  it('creates a version, runs the CLI step, waits for routing, and prints what went live', async () => {
    await lift(['production', '--force'])

    expect(mocks.cleanStagingDir).toHaveBeenCalledWith(workingDir)
    expect(mocks.copyToStagingDir).toHaveBeenCalledWith(workingDir, true)
    expect(calls('CreateVersion')[0][1]).toEqual({
      config: { type: 'project', environments: { production: {} } },
      environment: 'production',
    })
    expect(calls('StartLiftDeployment')[0][1]).toMatchObject({
      versionId: 'ver_1',
      options: { deleteStale: false, force: true },
    })

    expect(calls('ClaimStep')).toHaveLength(1)
    expect(mocks.executeCliTask).toHaveBeenCalledWith(S3_INPUTS, {
      stagingDir: `${workingDir}/.gantry`,
      cwd: workingDir,
      force: true,
      delete: undefined,
    })
    expect(calls('CompleteCliStep')[0][1]).toEqual({
      stepId: 'step_1',
      outputs: { s3Upload: { uploadedFiles: 1, totalSize: 13, success: true } },
      fileResults: [{ path: 'index.html', hash: 'abc', success: true }],
    })

    expect(calls('GetLiftDeployment')[0][1]).toEqual({ id: 'dep_r' })
    expect(mocks.printHeading).toHaveBeenCalledWith('DNS records')
    expect(mocks.printHeading).toHaveBeenCalledWith('Deployed routes')
    expect(logSpy).toHaveBeenCalledWith('  CNAME  shop.example.com  d1.cloudfront.net')
    expect(logSpy).toHaveBeenCalledWith('\n  Add the records above at your DNS provider.')
    expect(mocks.printError).not.toHaveBeenCalled()
    expect(process.exitCode).toBeUndefined()
    expect(mocks.removeStagingDir).toHaveBeenCalledWith(workingDir)
    expect(process.listeners('SIGINT')).not.toContain(sigintHandler())
  })

  it('runs setup commands, then builds named images in dependency order', async () => {
    mocks.resolveYaml.mockResolvedValue(
      resolved({
        type: 'project',
        environments: { production: {} },
        setup: {
          commands: ['npm ci', 'npm run build'],
          working_dir: 'app',
          use_gitignore: false,
          builds: {
            worker: { dockerfile: 'Dockerfile.worker', depends_on: 'base' },
            base: { dockerfile: 'Dockerfile', docker_target: 'prod', working_dir: 'svc' },
          },
        },
      })
    )

    await lift(['production'])

    expect(mocks.copyToStagingDir).toHaveBeenCalledWith(workingDir, false)
    const commands = mocks.spawn.mock.calls.map((call) => {
      const [command, , options] = call as [string, string[], { cwd: string }]
      return [command, options.cwd]
    })
    expect(commands).toEqual([
      ['npm ci', `${workingDir}/.gantry/app`],
      ['npm run build', `${workingDir}/.gantry/app`],
    ])
    const builds = mocks.runDocker.mock.calls.map(([args, options]) => ({
      tag: (args as string[])[(args as string[]).indexOf('-t') + 1],
      cwd: (options as { cwd: string }).cwd,
    }))
    expect(builds).toEqual([
      { tag: 'p9ue62-shop-base:v3', cwd: `${workingDir}/.gantry/svc` },
      { tag: 'p9ue62-shop-worker:v3', cwd: `${workingDir}/.gantry` },
    ])
  })

  it('stops before building when a setup command fails', async () => {
    mocks.resolveYaml.mockResolvedValue(
      resolved({
        type: 'project',
        environments: { production: {} },
        setup: { commands: 'npm run build', builds: { api: { dockerfile: 'Dockerfile' } } },
      })
    )
    mocks.spawn.mockImplementation((() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough
        stderr: PassThrough
      }
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('missing script: build'))
        child.emit('close', 1)
      })
      return child as unknown as ChildProcess
    }) as never)

    await expect(lift(['production'])).rejects.toThrow(ExitError)

    expect(mocks.printError).toHaveBeenCalledWith(
      expect.stringContaining('Build command failed with exit code 1')
    )
    expect(mocks.runDocker).not.toHaveBeenCalled()
    expect(calls('StartLiftDeployment')).toHaveLength(0)
    expect(mocks.removeStagingDir).toHaveBeenCalledWith(workingDir)
  })

  it('fails the build when a named build depends on one that does not exist', async () => {
    mocks.resolveYaml.mockResolvedValue(
      resolved({
        type: 'project',
        environments: { production: {} },
        setup: { builds: { api: { dockerfile: 'Dockerfile', depends_on: 'ghost' } } },
      })
    )

    await expect(lift(['production'])).rejects.toThrow(ExitError)

    expect(mocks.printError).toHaveBeenCalledWith('Build "api" depends on unknown build "ghost"')
  })

  it('reports a failed CLI task to the API and exits non-zero once the service fails', async () => {
    mocks.executeCliTask.mockRejectedValue(new Error('upload refused'))
    sequence(
      [deployment({ steps: [PENDING_STEP] })],
      [deployment({ steps: [PENDING_STEP] })],
      [deployment({ status: 'FAILED', lastMessage: 'Upload failed' })]
    )

    await lift(['production'])

    expect(calls('FailCliStep')[0][1]).toEqual({ stepId: 'step_1', error: 'upload refused' })
    expect(calls('CompleteCliStep')).toHaveLength(0)
    expect(calls('GetLiftDeployment')).toHaveLength(0)
    expect(mocks.printError).toHaveBeenCalledWith(
      'Deployment failed: 1 of 1 service did not succeed'
    )
    expect(process.exitCode).toBe(1)
  })

  it('leaves a step to the CLI that won the claim and follows the deployment to completion', async () => {
    handlers.ClaimStep = () => ({
      claimStep: { success: false, message: 'Step is already claimed by another CLI instance.' },
    })
    sequence(
      [deployment({ steps: [PENDING_STEP] })],
      [deployment({ steps: [PENDING_STEP] })],
      [deployment({ steps: [{ ...PENDING_STEP, cliStatus: 'CLAIMED' }] })],
      [
        deployment({ status: 'COMPLETE' }),
        { id: 'dep_r', scope: 'project-env', status: 'COMPLETE' },
      ]
    )

    await lift(['production'])

    expect(calls('ClaimStep')).toHaveLength(1)
    expect(mocks.executeCliTask).not.toHaveBeenCalled()
    expect(mocks.printError).not.toHaveBeenCalled()
    expect(process.exitCode).toBeUndefined()
  })

  it.each([['Step not found.'], [null]])(
    'fails the service when a refused step is still unclaimed on the next poll (message: %s)',
    async (message) => {
      handlers.ClaimStep = () => ({ claimStep: { success: false, message } })
      sequence(
        [deployment({ steps: [PENDING_STEP] })],
        [deployment({ steps: [PENDING_STEP] })],
        [deployment({ steps: [PENDING_STEP] })]
      )

      await lift(['production'])

      expect(calls('ClaimStep')).toHaveLength(1)
      expect(mocks.executeCliTask).not.toHaveBeenCalled()
      expect(mocks.printError).toHaveBeenCalledWith(
        'Deployment failed: 1 of 1 service did not succeed'
      )
      expect(process.exitCode).toBe(1)
    }
  )

  it('treats skipped and cancelled services as settled', async () => {
    handlers.StartLiftDeployment = () => ({
      startDeployment: {
        success: true,
        deployment: { id: 'dep_1' },
        deploymentIds: ['dep_1', 'dep_2'],
        versionId: 'ver_1',
      },
    })
    sequence(
      [],
      [
        deployment({ status: 'SKIPPED', lastMessage: 'unchanged' }),
        deployment({ id: 'dep_2', serviceName: '', status: 'CANCELLED' }),
        { id: 'dep_r', scope: 'project-env', status: 'COMPLETE' },
      ]
    )

    await lift(['production'])

    expect(process.exitCode).toBeUndefined()
    expect(calls('GetLiftDeployment')).toHaveLength(1)
  })

  it('gives up after ten consecutive API failures while polling', async () => {
    let call = 0
    handlers.DeploymentsByVersion = () => {
      call++
      if (call === 1) return { deploymentsByVersion: [deployment()] }
      throw new GantryApiError('Bad gateway', undefined, 502)
    }

    await lift(['production'])

    expect(mocks.printError).toHaveBeenCalledWith(
      'Deployment failed: 1 of 1 service did not succeed'
    )
    expect(calls('DeploymentsByVersion').length).toBe(11)
  })

  it('exits with the routing failure', async () => {
    handlers.GetLiftDeployment = () => ({
      deployment: { id: 'dep_r', status: 'FAILED', lastMessage: 'certificate pending' },
    })

    await expect(lift(['production'])).rejects.toThrow(ExitError)

    expect(mocks.printError).toHaveBeenCalledWith('Routing failed - certificate pending')
  })

  it('stops waiting on routing when its deployment disappears', async () => {
    handlers.GetLiftDeployment = () => ({ deployment: null })

    await lift(['production'])

    expect(mocks.printError).not.toHaveBeenCalled()
    expect(calls('VersionRouteUrls')).toHaveLength(0)
  })

  it('waits for cleanup when asked to', async () => {
    sequence(
      [deployment({ steps: [PENDING_STEP] })],
      [deployment({ steps: [PENDING_STEP] })],
      [
        deployment({ status: 'COMPLETE' }),
        { id: 'dep_r', scope: 'project-env', status: 'COMPLETE' },
        { id: 'dep_t', serviceName: 'old-web', deploymentType: 'teardown', status: 'running' },
      ],
      [
        deployment({ status: 'COMPLETE' }),
        { id: 'dep_r', scope: 'project-env', status: 'COMPLETE' },
        { id: 'dep_t', serviceName: 'old-web', deploymentType: 'teardown', status: 'running' },
      ],
      [
        deployment({ status: 'COMPLETE' }),
        { id: 'dep_r', scope: 'project-env', status: 'COMPLETE' },
        { id: 'dep_t', serviceName: 'old-web', deploymentType: 'teardown', status: 'COMPLETE' },
      ]
    )

    await lift(['production', '--wait-for-cleanup'])

    expect(process.exitCode).toBeUndefined()
    expect(mocks.removeStagingDir).toHaveBeenCalled()
  })

  it('exits with the API message when the version cannot be created', async () => {
    handlers.CreateVersion = () => ({
      createVersion: { success: false, message: 'Plan limit reached.' },
    })

    await expect(lift(['production'])).rejects.toThrow(ExitError)

    expect(mocks.printError).toHaveBeenCalledWith('Plan limit reached.')
    expect(calls('StartLiftDeployment')).toHaveLength(0)
    expect(mocks.removeStagingDir).toHaveBeenCalledWith(workingDir)
    expect(process.listeners('SIGINT')).not.toContain(sigintHandler())
  })

  it('exits when the deployment cannot be started', async () => {
    handlers.StartLiftDeployment = () => ({ startDeployment: { success: false } })

    await expect(lift(['production'])).rejects.toThrow(ExitError)

    expect(mocks.printError).toHaveBeenCalledWith('Failed to start deployment')
  })

  it('cancels every deployment on the first Ctrl+C and exits 130 on the second', async () => {
    let sigint: (() => void) | undefined
    handlers.ClaimStep = () => {
      sigint = sigintHandler()
      sigint()
      return { claimStep: { success: false } }
    }

    await lift(['production'])

    expect(calls('CancelLiftDeployment')[0][1]).toEqual({ id: 'dep_1' })
    expect(exitSpy).not.toHaveBeenCalled()

    exitSpy.mockImplementation(() => undefined as never)
    sigint?.()
    await Promise.resolve()
    expect(exitSpy).toHaveBeenCalledWith(130)
  })

  it('prints resolution errors with hints and exits before touching the project', async () => {
    mocks.resolveYaml.mockResolvedValue({
      ok: false,
      errors: [
        { code: 'X', message: 'Unknown variable.', path: 'vars.x', suggestion: 'Declare it.' },
      ],
    })

    await expect(lift(['production'])).rejects.toThrow(ExitError)

    expect(mocks.printError).toHaveBeenCalledWith('Unknown variable. (at vars.x)')
    expect(stderrSpy).toHaveBeenCalledWith('  hint: Declare it.\n')
    expect(mocks.cleanStagingDir).not.toHaveBeenCalled()
  })

  it('suggests the declared spelling of a mis-cased environment', async () => {
    mocks.resolveYaml.mockResolvedValue(
      resolved({ type: 'project', environments: { Production: {} } })
    )

    await expect(lift(['production'])).rejects.toThrow(ExitError)

    expect(mocks.printError).toHaveBeenCalledWith(
      "Environment 'production' not found. Did you mean 'Production'?"
    )
  })

  it('lists the available environments for an unknown one', async () => {
    await expect(lift(['qa'])).rejects.toThrow(ExitError)

    expect(mocks.printError).toHaveBeenCalledWith(
      "Environment 'qa' not found in gantry.yml. Available: production"
    )
  })

  it('exits when there is no gantry.yml', async () => {
    fs.rmSync(path.join(workingDir, 'gantry.yml'))

    await expect(lift(['production'])).rejects.toThrow(ExitError)

    expect(mocks.printError).toHaveBeenCalledWith(
      `No gantry.yml or gantry.yaml found in ${workingDir}`
    )
    expect(mocks.resolveYaml).not.toHaveBeenCalled()
  })

  it('rejects a malformed --var before resolving', async () => {
    await expect(lift(['production', '--var', 'novalue'])).rejects.toThrow(ExitError)

    expect(mocks.printError).toHaveBeenCalledWith('Invalid --var "novalue". Expected key=value.')
    expect(mocks.resolveYaml).not.toHaveBeenCalled()
  })

  it('reads the config from --file', async () => {
    fs.writeFileSync(path.join(workingDir, 'alt.yml'), 'type: project\n')

    await lift(['production', '--file', 'alt.yml', '--var', 'domain=x.com'])

    expect(mocks.resolveYaml).toHaveBeenCalledWith({
      yamlPath: path.join(workingDir, 'alt.yml'),
      environment: 'production',
      cliVariables: { domain: 'x.com' },
    })
  })

  function failingChild(emit: (child: EventEmitter & { stderr: PassThrough }) => void) {
    return (() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough
        stderr: PassThrough
      }
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      queueMicrotask(() => {
        emit(child)
      })
      return child as unknown as ChildProcess
    }) as never
  }

  function withSetup(setup: Record<string, unknown>) {
    mocks.resolveYaml.mockResolvedValue(
      resolved({ type: 'project', environments: { production: {} }, setup })
    )
  }

  function byVersionScript(...responses: (unknown[] | Error | (() => unknown[]))[]) {
    handlers.DeploymentsByVersion = () => {
      const next = responses.length > 1 ? responses.shift() : responses[0]
      if (next instanceof Error) throw next
      return { deploymentsByVersion: typeof next === 'function' ? next() : next }
    }
  }

  const ROUTING_PENDING = { id: 'dep_r', scope: 'project-env', status: 'RUNNING' }

  const LOCAL_BUILD_INPUTS: LocalBuildInputs = {
    __typename: 'LocalBuildCliInputs',
    stepId: 'step_local-build',
    serviceName: 'web',
    versionNumber: 3,
    projectId: 'p9ue62',
    projectSlug: 'shop',
    buildCommands: ['npm run build'],
    dockerfile: null,
    workingDir: null,
    dockerTarget: null,
    namedBuildName: null,
    buildArgs: null,
  }

  const CONTAINER_PUSH_INPUTS: ContainerPushInputs = {
    __typename: 'ContainerPushCliInputs',
    stepId: 'step_container-push',
    imageUri: '123.dkr.ecr.us-east-1.amazonaws.com/web:v3',
    localImageTag: 'p9ue62-shop-web:v3',
    ecrAuthToken: 'dG9rZW4=',
    ecrEndpoint: 'https://123.dkr.ecr.us-east-1.amazonaws.com',
  }

  const ARTIFACT_UPLOAD_INPUTS: ArtifactUploadInputs = {
    __typename: 'ArtifactUploadCliInputs',
    stepId: 'step_artifact-upload',
    bucketName: 'artifacts',
    s3Key: 'web/v3.zip',
    region: 'us-east-1',
    accessKeyId: 'AKIA',
    secretAccessKey: 'secret',
    sessionToken: 'token',
    sourcePath: 'dist',
    excludePatterns: null,
  }

  it.each<[string, CliInputs]>([
    ['local-build', LOCAL_BUILD_INPUTS],
    ['s3-upload', { ...S3_INPUTS, stepId: 'step_s3-upload' }],
    ['container-push', CONTAINER_PUSH_INPUTS],
    ['artifact-upload', ARTIFACT_UPLOAD_INPUTS],
  ])('reports a failed %s step to the API without leaking secrets', async (cliTask, cliInputs) => {
    const step = { ...PENDING_STEP, id: `step_${cliTask}`, cliTask, cliInputs }
    handlers.ClaimStep = () => ({ claimStep: { success: true, step } })
    mocks.executeCliTask.mockRejectedValue(
      new Error(`${cliTask} failed: {"password":"hunter2"} using gpat_live7Qk2ZxYwv9`)
    )
    sequence(
      [],
      [deployment({ steps: [step] })],
      [deployment({ status: 'FAILED', lastMessage: `${cliTask} step failed` })]
    )

    await lift(['production'])

    expect(mocks.executeCliTask.mock.calls[0]?.[0]).toEqual(cliInputs)
    const failure = calls('FailCliStep')[0][1] as { stepId: string; error: string }
    expect(failure.stepId).toBe(`step_${cliTask}`)
    expect(failure.error).toContain(`${cliTask} failed:`)
    expect(failure.error).not.toContain('hunter2')
    expect(failure.error).not.toContain('gpat_live7Qk2ZxYwv9')
    expect(failure.error).toContain('[redacted]')
    expect(calls('CompleteCliStep')).toHaveLength(0)
    expect(mocks.printError).toHaveBeenCalledWith(
      'Deployment failed: 1 of 1 service did not succeed'
    )
    expect(process.exitCode).toBe(1)
  })

  it('fails a claimed step that has no CLI inputs', async () => {
    handlers.ClaimStep = () => ({
      claimStep: { success: true, step: { ...PENDING_STEP, cliInputs: null } },
    })

    await lift(['production'])

    expect(mocks.executeCliTask).not.toHaveBeenCalled()
    expect(calls('CompleteCliStep')).toHaveLength(0)
    expect(calls('FailCliStep')[0][1]).toEqual({
      stepId: 'step_1',
      error: 'Claimed step is missing its CLI inputs',
    })
  })

  it('reports a generic error when a task rejects with a non-Error', async () => {
    mocks.executeCliTask.mockRejectedValue('exit status 2')

    await lift(['production'])

    expect(calls('FailCliStep')[0][1]).toEqual({ stepId: 'step_1', error: 'Unknown error' })
  })

  it('completes a manifest step whose task returns no file results', async () => {
    const step = {
      ...PENDING_STEP,
      status: 'MANIFEST_REQUIRED',
      cliTask: 'container-push',
      cliInputs: CONTAINER_PUSH_INPUTS,
    }
    const containerPushResult: TaskResult = {
      outputs: {
        containerPush: {
          imageUri: CONTAINER_PUSH_INPUTS.imageUri,
          localImageTag: CONTAINER_PUSH_INPUTS.localImageTag,
          success: true,
        },
      },
    }
    handlers.ClaimStep = () => ({ claimStep: { success: true, step } })
    mocks.executeCliTask.mockResolvedValue(containerPushResult)
    sequence(
      [],
      [deployment({ steps: [step] })],
      [deployment({ status: 'COMPLETE' }), ROUTING_PENDING]
    )

    await lift(['production', '--delete'])

    expect(mocks.executeCliTask).toHaveBeenCalledWith(CONTAINER_PUSH_INPUTS, {
      stagingDir: `${workingDir}/.gantry`,
      cwd: workingDir,
      force: undefined,
      delete: true,
    })
    expect(calls('CompleteCliStep')[0][1]).toEqual({
      stepId: 'step_1',
      outputs: containerPushResult.outputs,
      fileResults: null,
    })
    expect(calls('StartLiftDeployment')[0][1]).toMatchObject({
      options: { deleteStale: true, force: false },
    })
  })

  it('does not time out a service after a CLI step that ran longer than five minutes', async () => {
    mocks.executeCliTask.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () => {
              resolve({
                outputs: { s3Upload: { uploadedFiles: 4000, totalSize: 4000, success: true } },
                fileResults: [],
              })
            },
            6 * 60 * 1000
          )
        })
    )
    sequence(
      [],
      [deployment({ steps: [PENDING_STEP] })],
      [deployment({ status: 'RUNNING', lastMessage: 'Uploading' })],
      [deployment({ status: 'COMPLETE' }), ROUTING_PENDING]
    )

    await lift(['production'])

    expect(calls('CompleteCliStep')).toHaveLength(1)
    expect(mocks.printError).not.toHaveBeenCalled()
    expect(process.exitCode).toBeUndefined()
  })

  it('reports a setup command that cannot start', async () => {
    withSetup({ commands: 'npm run build' })
    mocks.spawn.mockImplementation(
      failingChild((child) => child.emit('error', new Error('spawn /bin/sh ENOENT')))
    )

    await expect(lift(['production'])).rejects.toThrow(ExitError)

    expect(mocks.printError).toHaveBeenCalledWith(
      `Build command failed to start: spawn /bin/sh ENOENT\nCommand: npm run build\nDirectory: ${workingDir}/.gantry`
    )
  })

  it('omits the output section when a failing setup command printed nothing', async () => {
    withSetup({ commands: ['make'] })
    mocks.spawn.mockImplementation(failingChild((child) => child.emit('close', 127)))

    await expect(lift(['production'])).rejects.toThrow(ExitError)

    expect(mocks.printError).toHaveBeenCalledWith(
      `Build command failed with exit code 127\nCommand: make\nDirectory: ${workingDir}/.gantry`
    )
  })

  it('tags images with the created version and passes build args through', async () => {
    withSetup({ builds: { api: { dockerfile: 'Dockerfile', args: { NODE_ENV: 'production' } } } })

    await lift(['production'])

    const args = mocks.runDocker.mock.calls[0]?.[0] as string[]
    expect(args[args.indexOf('-t') + 1]).toBe('p9ue62-shop-api:v3')
    expect(args).toContain('NODE_ENV=production')
  })

  it.each([
    { versionNumber: null, projectId: 'p9ue62', projectSlug: 'shop' },
    { versionNumber: 3, projectId: null, projectSlug: 'shop' },
    { versionNumber: 3, projectId: 'p9ue62', projectSlug: null },
  ])(
    'fails without building an image when the version omits project details (%j)',
    async (details) => {
      withSetup({ builds: { api: { dockerfile: 'Dockerfile' } } })
      handlers.CreateVersion = () => ({
        createVersion: { success: true, versionId: 'ver_1', message: null, ...details },
      })

      await expect(lift(['production'])).rejects.toThrow(ExitError)

      expect(mocks.printError).toHaveBeenCalledWith('Failed to create version')
      expect(mocks.runDocker).not.toHaveBeenCalled()
      expect(calls('StartLiftDeployment')).toHaveLength(0)
    }
  )

  it('skips targets, routing and cleanup when the deployment has no version', async () => {
    handlers.StartLiftDeployment = () => ({
      startDeployment: { success: true, deployment: { id: 'dep_1' } },
    })

    await lift(['production'])

    expect(calls('DeploymentsByVersion')).toHaveLength(0)
    expect(calls('GetLiftDeployment')).toHaveLength(0)
    expect(mocks.printError).not.toHaveBeenCalled()
    expect(process.exitCode).toBeUndefined()
  })

  it('shows deployment ids until the first poll when names cannot be loaded', async () => {
    byVersionScript(
      new Error('ECONNRESET'),
      [
        deployment({
          status: 'RUNNING',
          steps: [{ ...PENDING_STEP, status: 'COMPLETE', cliStatus: 'COMPLETE' }],
        }),
      ],
      [
        deployment({
          status: 'RUNNING',
          steps: [{ ...PENDING_STEP, phase: 'SETUP', status: 'QUEUED', executor: 'WORKER' }],
        }),
      ],
      [deployment({ status: 'COMPLETE' }), ROUTING_PENDING]
    )

    await lift(['production'])

    expect(mocks.printError).not.toHaveBeenCalled()
    expect(calls('GetLiftDeployment')).toHaveLength(1)
  })

  it('gives up after ten consecutive network errors without an HTTP status', async () => {
    byVersionScript([], new Error('fetch failed'))

    await lift(['production'])

    expect(calls('DeploymentsByVersion')).toHaveLength(11)
    expect(mocks.printError).toHaveBeenCalledWith(
      'Deployment failed: 1 of 1 service did not succeed'
    )
  })

  it('skips routing and reports every failed service', async () => {
    handlers.StartLiftDeployment = () => ({
      startDeployment: {
        success: true,
        deployment: { id: 'dep_1', projectName: 'Shop' },
        deploymentIds: ['dep_1', 'dep_2'],
        versionId: 'ver_1',
      },
    })
    sequence(
      [
        deployment(),
        deployment({ id: 'dep_2', serviceName: 'worker' }),
        ROUTING_PENDING,
        { id: 'dep_t', serviceName: 'old', deploymentType: 'teardown', status: 'PENDING' },
      ],
      [
        deployment({ status: 'FAILED' }),
        deployment({ id: 'dep_2', serviceName: 'worker', status: 'FAILED', lastMessage: 'OOM' }),
      ]
    )

    await lift(['production'])

    expect(calls('GetLiftDeployment')).toHaveLength(0)
    expect(mocks.printError).toHaveBeenCalledWith(
      'Deployment failed: 2 of 2 services did not succeed'
    )
    expect(process.exitCode).toBe(1)
  })

  it('keeps discovering routing through network errors', async () => {
    byVersionScript([], [deployment({ status: 'COMPLETE' })], new Error('ETIMEDOUT'), [
      deployment({ status: 'COMPLETE' }),
      ROUTING_PENDING,
    ])

    await lift(['production'])

    expect(calls('GetLiftDeployment')).toHaveLength(1)
    expect(mocks.printError).not.toHaveBeenCalled()
  })

  it('finishes without routing when none appears within two minutes', async () => {
    sequence([], [deployment({ status: 'COMPLETE' })])

    await lift(['production'])

    expect(calls('GetLiftDeployment')).toHaveLength(0)
    expect(calls('DeploymentsByVersion').length).toBeGreaterThan(50)
    expect(mocks.printHeading).not.toHaveBeenCalled()
    expect(mocks.printError).not.toHaveBeenCalled()
  })

  it('stops discovering routing after Ctrl+C', async () => {
    let call = 0
    byVersionScript(() => {
      call++
      if (call === 3) sigintHandler()()
      return call === 1 ? [] : [deployment({ status: 'COMPLETE' })]
    })

    await lift(['production'])

    expect(calls('CancelLiftDeployment')[0][1]).toEqual({ id: 'dep_1' })
    expect(calls('GetLiftDeployment')).toHaveLength(0)
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('stops polling routing after Ctrl+C, ignoring cancel errors', async () => {
    handlers.CancelLiftDeployment = () => {
      throw new Error('Deployment already complete')
    }
    handlers.GetLiftDeployment = () => {
      sigintHandler()()
      return { deployment: { id: 'dep_r', status: 'RUNNING' } }
    }

    await lift(['production'])

    expect(calls('CancelLiftDeployment')).toHaveLength(1)
    expect(calls('GetLiftDeployment')).toHaveLength(1)
    expect(calls('VersionRouteUrls')).toHaveLength(0)
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('settles on a cancelled routing deployment without fetching URLs', async () => {
    handlers.GetLiftDeployment = () => ({ deployment: { id: 'dep_r', status: 'CANCELLED' } })

    await lift(['production'])

    expect(calls('VersionRouteUrls')).toHaveLength(0)
    expect(mocks.printError).not.toHaveBeenCalled()
  })

  it('retries routing polls and tolerates failed URL and DNS lookups', async () => {
    let call = 0
    handlers.GetLiftDeployment = () => {
      call++
      if (call === 1) throw new Error('socket hang up')
      return { deployment: { id: 'dep_r', status: 'COMPLETE', lastMessage: 'Routes applied' } }
    }
    handlers.VersionRouteUrls = () => {
      throw new Error('Internal server error')
    }
    handlers.VersionDnsRecords = () => {
      throw new Error('Internal server error')
    }

    await lift(['production'])

    expect(calls('GetLiftDeployment')).toHaveLength(2)
    expect(mocks.printHeading).not.toHaveBeenCalled()
    expect(mocks.printError).not.toHaveBeenCalled()
  })

  it('prints every live route and no DNS action when all records are managed', async () => {
    handlers.VersionRouteUrls = () => ({
      versionRouteUrls: [
        {
          url: 'https://shop.example.com',
          domain: 'shop.example.com',
          path: '/',
          serviceName: 'web',
        },
        {
          url: 'https://api.example.com',
          domain: 'api.example.com',
          path: '/',
          serviceName: 'api',
        },
      ],
    })
    handlers.VersionDnsRecords = () => ({
      versionDnsRecords: [
        { recordType: 'A', name: 'shop.example.com', value: 'd1.cloudfront.net', managed: true },
        { recordType: 'CNAME', name: 'api.example.com', value: 'd2.cloudfront.net', managed: true },
      ],
    })

    await lift(['production'])

    expect(logSpy).toHaveBeenCalledWith('  A      shop.example.com  d1.cloudfront.net')
    expect(logSpy).toHaveBeenCalledWith('  CNAME  api.example.com   d2.cloudfront.net')
    expect(logSpy).not.toHaveBeenCalledWith('\n  Add the records above at your DNS provider.')
    const printed = logSpy.mock.calls.map((call) => String(call[0])).join('\n')
    expect(printed).toContain('https://shop.example.com')
    expect(printed).toContain('https://api.example.com')
  })

  it('prints nothing extra when routing reports no URLs or records', async () => {
    handlers.VersionRouteUrls = () => ({ versionRouteUrls: [] })
    handlers.VersionDnsRecords = () => ({ versionDnsRecords: [] })

    await lift(['production'])

    expect(mocks.printHeading).not.toHaveBeenCalled()
  })

  it('counts several background teardowns and tolerates a failed cleanup lookup', async () => {
    const teardowns = [
      { id: 'dep_t1', deploymentType: 'teardown', status: 'PENDING' },
      { id: 'dep_t2', deploymentType: 'teardown', status: 'PENDING' },
    ]
    sequence([], [deployment({ status: 'COMPLETE' }), ROUTING_PENDING, ...teardowns])

    await lift(['production'])

    const lookups = calls('DeploymentsByVersion').length
    expect(lookups).toBe(4)

    mocks.graphqlRequest.mockClear()
    let dnsDone = false
    handlers.VersionDnsRecords = () => {
      dnsDone = true
      return { versionDnsRecords: [] }
    }
    byVersionScript(() => {
      if (dnsDone) throw new Error('ECONNRESET')
      return [deployment({ status: 'COMPLETE' }), ROUTING_PENDING]
    })

    await lift(['production'])

    expect(mocks.printError).not.toHaveBeenCalled()
  })

  it('reports nothing to clean up when no teardown appears within 30 seconds', async () => {
    byVersionScript(
      [],
      [deployment({ status: 'COMPLETE' }), ROUTING_PENDING],
      [deployment({ status: 'COMPLETE' }), ROUTING_PENDING],
      new Error('ECONNRESET'),
      [deployment({ status: 'COMPLETE' }), ROUTING_PENDING]
    )

    await lift(['production', '--wait-for-cleanup'])

    expect(mocks.printError).not.toHaveBeenCalled()
    expect(process.exitCode).toBeUndefined()
  })

  it('stops discovering cleanup after Ctrl+C', async () => {
    let dnsDone = false
    handlers.VersionDnsRecords = () => {
      dnsDone = true
      sigintHandler()()
      return { versionDnsRecords: [] }
    }
    byVersionScript(() => (dnsDone ? [] : [deployment({ status: 'COMPLETE' }), ROUTING_PENDING]))

    await lift(['production', '--wait-for-cleanup'])

    expect(calls('CancelLiftDeployment')).toHaveLength(1)
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('resolves pending cleanups as cancelled after Ctrl+C', async () => {
    let cleanupPolls = 0
    let dnsDone = false
    handlers.VersionDnsRecords = () => {
      dnsDone = true
      return { versionDnsRecords: [] }
    }
    byVersionScript(() => {
      if (!dnsDone) return [deployment({ status: 'COMPLETE' }), ROUTING_PENDING]
      cleanupPolls++
      if (cleanupPolls === 2) sigintHandler()()
      return [
        { id: 'dep_t', serviceName: 'old-web', deploymentType: 'teardown', status: 'running' },
      ]
    })

    await lift(['production', '--wait-for-cleanup'])

    expect(calls('CancelLiftDeployment')).toHaveLength(1)
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('settles failed and cancelled teardowns and retries cleanup polls', async () => {
    const teardown = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
      id,
      deploymentType: 'teardown',
      status,
      ...extra,
    })
    let dnsDone = false
    handlers.VersionDnsRecords = () => {
      dnsDone = true
      return { versionDnsRecords: [] }
    }
    const cleanupResponses: (unknown[] | Error)[] = [
      [teardown('dep_t1', 'pending'), teardown('dep_t2', 'running', { serviceName: 'old-api' })],
      [
        teardown('dep_t1', 'processing', { lastMessage: 'Deleting stack' }),
        teardown('dep_t2', 'running', { serviceName: 'old-api' }),
      ],
      new Error('ECONNRESET'),
      [
        teardown('dep_t1', 'FAILED', { lastMessage: 'Stack in use' }),
        teardown('dep_t2', 'CANCELLED', { serviceName: 'old-api' }),
      ],
    ]
    byVersionScript(() => {
      if (!dnsDone) return [deployment({ status: 'COMPLETE' }), ROUTING_PENDING]
      const next = cleanupResponses.length > 1 ? cleanupResponses.shift() : cleanupResponses[0]
      if (next instanceof Error) throw next
      return next ?? []
    })

    await lift(['production', '--wait-for-cleanup'])

    expect(mocks.printError).not.toHaveBeenCalled()
    expect(process.exitCode).toBeUndefined()
    expect(mocks.removeStagingDir).toHaveBeenCalledWith(workingDir)
  })

  it('uses a generic message when the version cannot be created and says nothing', async () => {
    handlers.CreateVersion = () => ({ createVersion: { success: true, versionId: null } })

    await expect(lift(['production'])).rejects.toThrow(ExitError)

    expect(mocks.printError).toHaveBeenCalledWith('Failed to create version')
  })

  it('does not reprint errors Listr already rendered', async () => {
    handlers.CreateVersion = () => {
      throw new Error('Listr task list failed')
    }

    await expect(lift(['production'])).rejects.toThrow(ExitError)

    expect(mocks.printError).not.toHaveBeenCalled()
    expect(mocks.removeStagingDir).toHaveBeenCalledWith(workingDir)
  })

  it('exits when --file points at a missing file', async () => {
    await expect(lift(['production', '--file', 'missing.yml'])).rejects.toThrow(ExitError)

    expect(mocks.printError).toHaveBeenCalledWith(
      `No gantry.yml or gantry.yaml found in ${workingDir}`
    )
  })
})

describe('getPhaseDisplay', () => {
  type VersionDeployment = Parameters<typeof getPhaseDisplay>[0]
  type Step = NonNullable<VersionDeployment['steps']>[number]

  const step = (phase: Step['phase'], status: Step['status'] = 'PROCESSING'): Step => ({
    id: 'step_1',
    stepType: 'deploy',
    status,
    phase,
    executor: 'WORKER',
    cliTask: null,
    cliStatus: null,
    sequence: 1,
  })
  const versionDeployment = (
    steps: Step[],
    status: VersionDeployment['status'] = 'RUNNING'
  ): VersionDeployment => ({
    id: 'dep_1',
    status,
    scope: null,
    deploymentType: null,
    lastMessage: null,
    serviceName: 'web',
    steps,
  })

  it.each([
    ['BUILDING', 'Building'],
    ['SETUP', 'Setup'],
    ['UPLOADING', 'Uploading'],
    ['DEPLOYING', 'Deploying'],
    ['GO_LIVE', 'Go Live'],
    ['POST_DEPLOY', 'Cleanup'],
  ] as const)('labels the %s phase as %s', (phase, label) => {
    expect(getPhaseDisplay(versionDeployment([step(phase)]))).toBe(label)
  })

  it.each(['AWAITING_CLI', 'QUEUED', 'MANIFEST_REQUIRED'] as const)(
    'treats a %s step as the active phase',
    (status) => {
      expect(getPhaseDisplay(versionDeployment([step('GO_LIVE', status)]))).toBe('Go Live')
    }
  )

  it('falls back to the deployment status when no step is active', () => {
    expect(getPhaseDisplay(versionDeployment([step('GO_LIVE', 'COMPLETE')], 'COMPLETE'))).toBe(
      'COMPLETE'
    )
  })
})
