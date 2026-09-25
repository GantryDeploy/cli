import { spawn } from 'child_process'

export interface RunDockerOptions {
  cwd: string
  input?: string
}

export interface DockerBuildArgsOptions {
  tag: string
  dockerfile: string
  target?: string
  buildArgs?: Record<string, string>
  context?: string
}

const STDERR_TAIL_CHARS = 4000
const REDACTED = '***'
// Short values such as "1" or "true" would shred unrelated output if masked.
const MIN_MASKED_VALUE_LENGTH = 4

const BUILD_ARG_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

// Docker reference grammar (github.com/distribution/reference), minus IPv6 hosts.
const DOMAIN_COMPONENT = '(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])'
const DOMAIN = `${DOMAIN_COMPONENT}(?:\\.${DOMAIN_COMPONENT})*(?::[0-9]+)?`
const PATH_COMPONENT = '[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*'
const NAME = `(?:${DOMAIN}/)?${PATH_COMPONENT}(?:/${PATH_COMPONENT})*`
const TAG = '[\\w][\\w.-]{0,127}'
const DIGEST = '[A-Za-z][A-Za-z0-9]*(?:[-_+.][A-Za-z][A-Za-z0-9]*)*:[0-9a-fA-F]{32,}'
const IMAGE_REFERENCE = new RegExp(`^(${NAME})(?::${TAG})?(?:@${DIGEST})?$`)
const MAX_NAME_LENGTH = 255

const BUILD_TARGET = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

export function isValidImageReference(reference: string): boolean {
  const match = IMAGE_REFERENCE.exec(reference)
  return match !== null && match[1].length <= MAX_NAME_LENGTH
}

export function assertValidImageReference(reference: string, label: string): void {
  if (!isValidImageReference(reference)) {
    throw new Error(`Invalid ${label} "${reference}": not a valid Docker image reference`)
  }
}

export function assertValidBuildArgKey(key: string): void {
  if (!BUILD_ARG_KEY.test(key)) {
    throw new Error(`Invalid Docker build arg name "${key}": must match ${BUILD_ARG_KEY.source}`)
  }
}

export function assertValidRegistryEndpoint(endpoint: string): void {
  let host: string
  try {
    host = new URL(endpoint.includes('://') ? endpoint : `https://${endpoint}`).host
  } catch {
    throw new Error('Invalid container registry endpoint')
  }
  if (!host || endpoint.startsWith('-') || /\s/.test(endpoint)) {
    throw new Error('Invalid container registry endpoint')
  }
}

export function buildDockerBuildArgs({
  tag,
  dockerfile,
  target,
  buildArgs,
  context = '.',
}: DockerBuildArgsOptions): string[] {
  assertValidImageReference(tag, 'image tag')
  if (!dockerfile) {
    throw new Error('A Dockerfile path is required for a Docker build')
  }

  const args = ['build', '-t', tag, '-f', dockerfile]

  if (target) {
    if (!BUILD_TARGET.test(target)) {
      throw new Error(`Invalid Docker build target "${target}"`)
    }
    args.push('--target', target)
  }

  for (const [key, value] of Object.entries(buildArgs ?? {})) {
    assertValidBuildArgKey(key)
    args.push('--build-arg', `${key}=${value}`)
  }

  args.push(context)
  return args
}

export function redactDockerArgs(args: string[]): string[] {
  return args.map((arg, i) => {
    if (i > 0 && args[i - 1] === '--build-arg') {
      const eq = arg.indexOf('=')
      return eq === -1 ? arg : `${arg.slice(0, eq + 1)}${REDACTED}`
    }
    return arg
  })
}

function buildArgValues(args: string[]): string[] {
  return args.flatMap((arg, i) => {
    if (i === 0 || args[i - 1] !== '--build-arg') return []
    const eq = arg.indexOf('=')
    return eq === -1 ? [] : [arg.slice(eq + 1)]
  })
}

function sanitizeStderr(stderr: string, args: string[]): string {
  let sanitized = stderr
  for (const value of buildArgValues(args)) {
    if (value.length >= MIN_MASKED_VALUE_LENGTH) {
      sanitized = sanitized.split(value).join(REDACTED)
    }
  }
  return sanitized.length > STDERR_TAIL_CHARS ? sanitized.slice(-STDERR_TAIL_CHARS) : sanitized
}

/**
 * Run the docker CLI without a shell. Errors never carry `input` (it is how
 * secrets such as registry passwords are passed) and mask build-arg values.
 */
export function runDocker(args: string[], { cwd, input }: RunDockerOptions): Promise<void> {
  const command = ['docker', ...redactDockerArgs(args)].join(' ')

  return new Promise((resolve, reject) => {
    const stderrChunks: Buffer[] = []
    const child = spawn('docker', args, { cwd, stdio: 'pipe', shell: false })

    child.stdout.on('data', () => {
      // intentionally empty: drain stdout to prevent backpressure
    })
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))

    child.on('error', (error: NodeJS.ErrnoException) => {
      const reason = error.code === 'ENOENT' ? 'docker was not found on PATH' : 'failed to start'
      reject(new Error(`Docker command failed: ${reason}\nCommand: ${command}\nDirectory: ${cwd}`))
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      const details = [
        `Docker command failed with exit code ${String(code)}`,
        `Command: ${command}`,
        `Directory: ${cwd}`,
      ]
      // With stdin in play the output could echo the secret back, so it is dropped.
      if (input === undefined) {
        const stderr = sanitizeStderr(Buffer.concat(stderrChunks).toString().trim(), args)
        if (stderr) details.push(`Output:\n${stderr}`)
      }
      reject(new Error(details.join('\n')))
    })

    child.stdin.on('error', () => {
      // EPIPE when docker exits before reading stdin; the close handler reports it
    })
    child.stdin.end(input)
  })
}
