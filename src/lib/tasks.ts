import { spawn } from 'child_process'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { ZipArchive } from 'archiver'
import ignore from 'ignore'
import { minimatch } from 'minimatch'

import type {
  ArtifactUploadCliOutputsInput,
  ClaimStepMutation,
  CliTaskOutputsInput,
  ContainerPushCliOutputsInput,
  FileManifestItem,
  GetStepForUploadQuery,
  GetStepForUploadQueryVariables,
  LocalBuildCliOutputsInput,
  S3UploadCliOutputsInput,
  SubmitManifestMutation,
  SubmitManifestMutationVariables,
} from '../generated/graphql'

import { graphqlRequest } from './client'
import {
  assertValidImageReference,
  assertValidRegistryEndpoint,
  buildDockerBuildArgs,
  runDocker,
} from './exec'

export type CliInputs = NonNullable<
  NonNullable<ClaimStepMutation['claimStep']['step']>['cliInputs']
>

type InputsOf<T extends CliInputs['__typename']> = Extract<CliInputs, { __typename: T }>

export type LocalBuildInputs = InputsOf<'LocalBuildCliInputs'>
export type S3UploadInputs = InputsOf<'S3UploadCliInputs'>
export type ContainerPushInputs = InputsOf<'ContainerPushCliInputs'>
export type ArtifactUploadInputs = InputsOf<'ArtifactUploadCliInputs'>

type PresignedUpload = NonNullable<
  Extract<
    NonNullable<NonNullable<GetStepForUploadQuery['deploymentStep']>['cliInputs']>,
    { __typename: 'S3UploadCliInputs' }
  >['uploadUrls']
>['store'][number]

export interface TaskContext {
  stagingDir: string
  cwd: string
  force?: boolean
  delete?: boolean
}

export interface TaskResult {
  outputs: CliTaskOutputsInput
  fileResults?: FileUploadResult[]
}

export async function executeCliTask(inputs: CliInputs, context: TaskContext): Promise<TaskResult> {
  switch (inputs.__typename) {
    case 'LocalBuildCliInputs':
      return { outputs: { localBuild: await executeLocalBuild(inputs, context.stagingDir) } }
    case 'S3UploadCliInputs': {
      const { fileResults, outputs } = await executeS3Upload(inputs, context)
      return { outputs: { s3Upload: outputs }, fileResults }
    }
    case 'ContainerPushCliInputs':
      return { outputs: { containerPush: await executeContainerPush(inputs, context.cwd) } }
    case 'ArtifactUploadCliInputs':
      return {
        outputs: { artifactUpload: await executeArtifactUpload(inputs, context.stagingDir) },
      }
    default: {
      const unhandled: never = inputs
      throw new Error(`Unknown CLI task: ${String(unhandled)}`)
    }
  }
}

function runBuildCommand(dir: string, command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const stderrChunks: Buffer[] = []
    const child = spawn(command, [], { cwd: dir, stdio: 'pipe', shell: true })

    child.stdout.on('data', () => {
      // intentionally empty: drain stdout to prevent backpressure
    })
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))

    child.on('error', (error) => {
      reject(
        new Error(
          `Build command failed to start: ${error.message}\nCommand: ${command}\nDirectory: ${dir}`
        )
      )
    })

    child.on('close', (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString().trim()
        const details = [
          `Build command failed with exit code ${String(code)}`,
          `Command: ${command}`,
          `Directory: ${dir}`,
        ]
        if (stderr) details.push(`Output:\n${stderr}`)
        reject(new Error(details.join('\n')))
        return
      }
      resolve()
    })
  })
}

/** Runs the step's build commands, then the Docker build when the step names a Dockerfile. */
async function executeLocalBuild(
  inputs: LocalBuildInputs,
  stagingDir: string
): Promise<LocalBuildCliOutputsInput> {
  const {
    serviceName,
    buildCommands,
    dockerfile,
    workingDir,
    dockerTarget,
    namedBuildName,
    versionNumber,
    projectId,
    projectSlug,
  } = inputs

  const outputs: LocalBuildCliOutputsInput = { serviceName, success: true }

  const buildDir = workingDir ? path.join(stagingDir, workingDir) : stagingDir

  if (buildCommands && buildCommands.length > 0) {
    for (const cmd of buildCommands) {
      await runBuildCommand(buildDir, cmd)
    }
    outputs.buildCommands = buildCommands.join(' && ')
  }

  if (dockerfile) {
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty build name is invalid and should fall back to the service name
    const tagName = namedBuildName || serviceName
    const localTag = `${projectId}-${projectSlug}-${tagName}:v${String(versionNumber)}`
    const dockerArgs = buildDockerBuildArgs({
      tag: localTag,
      dockerfile,
      target: dockerTarget ?? undefined,
      buildArgs: inputs.buildArgs
        ? Object.fromEntries(inputs.buildArgs.map(({ name, value }) => [name, value]))
        : undefined,
    })

    await runDocker(dockerArgs, { cwd: buildDir })
    outputs.localImageTag = localTag
  }

  return outputs
}

interface FileUploadResult {
  path: string
  hash: string
  success: boolean
}

/**
 * Upload URLs arrive asynchronously after the manifest is submitted, so this polls
 * the step until it reaches `AWAITING_CLI` with `uploadUrls` set.
 */
async function executeS3Upload(
  inputs: S3UploadInputs,
  context: TaskContext
): Promise<{ outputs: S3UploadCliOutputsInput; fileResults: FileUploadResult[] }> {
  const { stepId, includePatterns, excludePatterns } = inputs
  const sourcePath = inputs.sourcePath || '.'
  const force = context.force ?? false
  const deleteStale = context.delete ?? false

  if (!stepId) {
    throw new Error('stepId is required for s3-upload task')
  }

  const { rootReal, sourceDir: absoluteSourcePath } = resolveSourceDir(
    context.stagingDir,
    sourcePath
  )

  let manifest = scanFilesWithHashes(absoluteSourcePath, rootReal)

  if (includePatterns && includePatterns.length > 0) {
    manifest = manifest.filter((file) =>
      includePatterns.some((pattern) => minimatch(file.path, pattern))
    )
  }
  if (excludePatterns && excludePatterns.length > 0) {
    manifest = manifest.filter((file) => !isPathExcluded(file.path, excludePatterns))
  }

  if (manifest.length === 0) {
    return { outputs: { uploadedFiles: 0, totalSize: 0, success: true }, fileResults: [] }
  }

  const submitResponse = await submitManifest(stepId, manifest, force, deleteStale)

  if (!submitResponse.submitManifest.success) {
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty API message should fall back to the default text
    throw new Error(submitResponse.submitManifest.message || 'Failed to submit manifest')
  }

  const uploadUrls = await pollForUploadUrls(stepId)

  const hashByPath = new Map<string, string>()
  for (const file of manifest) {
    hashByPath.set(file.path, file.hash)
  }

  const fileResults: FileUploadResult[] = []
  let uploadedCount = 0
  let uploadedSize = 0
  if (uploadUrls.length > 0) {
    const uploadResults = await uploadFilesInParallelWithResults(
      absoluteSourcePath,
      rootReal,
      uploadUrls,
      hashByPath
    )
    uploadedCount = uploadResults.count
    uploadedSize = uploadResults.size
    fileResults.push(...uploadResults.fileResults)
  }

  return {
    outputs: { uploadedFiles: uploadedCount, totalSize: uploadedSize, success: true },
    fileResults,
  }
}

/** No ignore filtering here: the staging copy already applied `.gitignore`. */
function scanFilesWithHashes(sourcePath: string, rootReal: string): FileManifestItem[] {
  const files = getAllFiles(sourcePath, rootReal)
  const manifest: FileManifestItem[] = []

  for (const filePath of files) {
    const relativePath = path.relative(sourcePath, filePath).replace(/\\/g, '/')
    const hash = computeFileMd5(filePath)
    manifest.push({ path: relativePath, hash })
  }

  return manifest
}

function computeFileMd5(filePath: string): string {
  const content = fs.readFileSync(filePath)
  return crypto.createHash('md5').update(content).digest('hex')
}

async function submitManifest(
  stepId: string,
  files: FileManifestItem[],
  force = false,
  deleteStale = false
): Promise<SubmitManifestMutation> {
  const query = /* GraphQL */ `
    mutation SubmitManifest($input: SubmitManifestInput!) {
      submitManifest(input: $input) {
        success
        message
      }
    }
  `

  return graphqlRequest<SubmitManifestMutation, SubmitManifestMutationVariables>(query, {
    input: {
      stepId,
      files,
      force,
      delete: deleteStale,
    },
  })
}

async function pollForUploadUrls(
  stepId: string,
  maxAttempts = 60,
  intervalMs = 2000
): Promise<PresignedUpload[]> {
  const query = /* GraphQL */ `
    query GetStepForUpload($stepId: String!) {
      deploymentStep(id: $stepId) {
        id
        status
        cliInputs {
          __typename
          ... on S3UploadCliInputs {
            uploadUrls {
              store {
                path
                s3Key
                url
                contentType
              }
            }
          }
        }
      }
    }
  `

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await graphqlRequest<GetStepForUploadQuery, GetStepForUploadQueryVariables>(
      query,
      { stepId }
    )

    const step = response.deploymentStep

    if (!step) {
      throw new Error('Step not found')
    }

    if (step.cliInputs && step.cliInputs.__typename !== 'S3UploadCliInputs') {
      throw new Error('Step is not an S3 upload')
    }

    if (step.status === 'AWAITING_CLI' && step.cliInputs?.uploadUrls) {
      return step.cliInputs.uploadUrls.store
    }

    if (step.status === 'FAILED') {
      throw new Error('Step failed while generating upload URLs')
    }

    if (attempt < maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }

  throw new Error('Timed out waiting for upload URLs')
}

async function uploadFilesInParallelWithResults(
  sourcePath: string,
  rootReal: string,
  uploads: PresignedUpload[],
  hashByPath: Map<string, string>,
  concurrency = 10
): Promise<{ count: number; size: number; fileResults: FileUploadResult[] }> {
  let count = 0
  let size = 0
  const fileResults: FileUploadResult[] = []
  const errors: string[] = []

  const validated = uploads.map((upload) =>
    validateUpload(upload, sourcePath, rootReal, hashByPath)
  )

  for (let i = 0; i < validated.length; i += concurrency) {
    const batch = validated.slice(i, i + concurrency)
    const results = await Promise.allSettled(
      batch.map(async ({ upload, realPath }) => {
        const content = readRegularFile(realPath, upload.path)

        const response = await fetch(upload.url, {
          method: 'PUT',
          body: content,
          headers: {
            'Content-Type': upload.contentType,
          },
        })

        if (!response.ok) {
          throw new Error(`${upload.path}: ${String(response.status)} ${response.statusText}`)
        }

        return { path: upload.path, size: content.length }
      })
    )

    for (let j = 0; j < results.length; j++) {
      const result = results[j]
      const { upload, hash } = batch[j]

      if (result.status === 'fulfilled') {
        count++
        size += result.value.size
        fileResults.push({ path: upload.path, hash, success: true })
      } else {
        const reason: unknown = result.reason
        errors.push(reason instanceof Error ? reason.message : String(reason))
        fileResults.push({ path: upload.path, hash, success: false })
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Failed to upload ${String(errors.length)} files:\n${errors.join('\n')}`)
  }

  return { count, size, fileResults }
}

/** Retags the image the local-build step produced (e.g. `p9ue62-my-api-api-docker:v3`) and pushes it to ECR. */
async function executeContainerPush(
  inputs: ContainerPushInputs,
  cwd: string
): Promise<ContainerPushCliOutputsInput> {
  const { imageUri, localImageTag, ecrAuthToken, ecrEndpoint } = inputs

  if (!imageUri) {
    throw new Error('imageUri is required for container-push task')
  }

  if (!localImageTag) {
    throw new Error('localImageTag is required for container-push task')
  }

  assertValidImageReference(localImageTag, 'local image tag')
  assertValidImageReference(imageUri, 'image URI')

  if (!ecrAuthToken || !ecrEndpoint) {
    throw new Error('ECR credentials are required for container-push task')
  }

  // ECR GetAuthorizationToken returns base64 of "AWS:{password}".
  const decoded = Buffer.from(ecrAuthToken, 'base64').toString('utf-8')
  const separator = decoded.indexOf(':')
  const password = separator === -1 ? '' : decoded.slice(separator + 1)

  if (!password) {
    throw new Error('Failed to decode ECR authorization token')
  }

  assertValidRegistryEndpoint(ecrEndpoint)

  await runDocker(['login', '--username', 'AWS', '--password-stdin', ecrEndpoint], {
    cwd,
    input: password,
  })

  await runDocker(['tag', localImageTag, imageUri], { cwd })
  await runDocker(['push', imageUri], { cwd })

  return {
    imageUri,
    localImageTag,
    success: true,
  }
}

// Lambda's direct-upload limit. Zips go through S3, which allows more, so this is a
// ceiling that catches zips bundling node_modules or build inputs, not a hard quota.
export const LAMBDA_ZIP_MAX_BYTES = 50 * 1024 * 1024

export function assertLambdaZipFits(zipSize: number, sourcePath: string): void {
  if (zipSize <= LAMBDA_ZIP_MAX_BYTES) return

  const actualMb = (zipSize / 1024 / 1024).toFixed(1)
  const limitMb = (LAMBDA_ZIP_MAX_BYTES / 1024 / 1024).toFixed(0)
  throw new Error(
    `Lambda zip is ${actualMb} MB, which exceeds the ${limitMb} MB limit. ` +
      `Source: ${sourcePath}. Set source_dir in gantry.yml to the build output ` +
      `directory (e.g. "dist") so the zip excludes node_modules and other build inputs.`
  )
}

async function executeArtifactUpload(
  inputs: ArtifactUploadInputs,
  stagingDir: string
): Promise<ArtifactUploadCliOutputsInput> {
  const { bucketName, s3Key, region, accessKeyId, secretAccessKey, sessionToken } = inputs
  const sourcePath = inputs.sourcePath || '.'

  if (!bucketName || !s3Key || !region) {
    throw new Error('bucketName, s3Key, and region are required for artifact-upload task')
  }

  if (!accessKeyId || !secretAccessKey || !sessionToken) {
    throw new Error(
      'AWS credentials (accessKeyId, secretAccessKey, sessionToken) are required for artifact-upload task'
    )
  }

  const { sourceDir: absoluteSourcePath } = resolveSourceDir(stagingDir, sourcePath)

  const zipBuffer = await createZipArchive(absoluteSourcePath, inputs.excludePatterns)

  assertLambdaZipFits(zipBuffer.length, absoluteSourcePath)

  const s3Client = new S3Client({
    region,
    credentials: {
      accessKeyId,
      secretAccessKey,
      sessionToken,
    },
  })

  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: s3Key,
      Body: zipBuffer,
      ContentType: 'application/zip',
    })
  )

  return {
    bucketName,
    s3Key,
    zipSize: zipBuffer.length,
    success: true,
  }
}

/**
 * The Lambda zip and the static S3 upload both filter through this, so a pattern like
 * `wp-content/uploads/**` matches the same files in each. Globs match the full
 * relative path, never a basename.
 */
export function isPathExcluded(relativePath: string, excludePatterns?: string[] | null): boolean {
  if (!excludePatterns || excludePatterns.length === 0) {
    return false
  }
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.?\//, '')
  return excludePatterns.some((pattern) => minimatch(normalized, pattern))
}

function createZipArchive(sourcePath: string, excludePatterns: string[] | null): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []

    const archive = new ZipArchive({ zlib: { level: 9 } })

    archive.on('data', (chunk: Buffer) => chunks.push(chunk))
    archive.on('end', () => {
      resolve(Buffer.concat(chunks))
    })
    archive.on('error', (err: Error) => {
      reject(err)
    })

    archive.directory(sourcePath, false, (entry) => {
      if (isPathExcluded(entry.name, excludePatterns)) {
        return false
      }
      return entry
    })
    void archive.finalize()
  })
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  )
}

function resolveSourceDir(
  baseDir: string,
  sourcePath: string
): { rootReal: string; sourceDir: string } {
  const sourceDir = path.resolve(baseDir, sourcePath)

  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Source path not found: ${sourceDir}`)
  }

  const rootReal = fs.realpathSync(baseDir)
  if (!isWithin(fs.realpathSync(sourceDir), rootReal)) {
    throw new Error(`source_dir "${sourcePath}" resolves outside the project directory`)
  }

  return { rootReal, sourceDir }
}

function realPathWithinRoot(filePath: string, rootReal: string, displayPath: string): string {
  let realPath: string
  try {
    realPath = fs.realpathSync(filePath)
  } catch {
    throw new Error(`Cannot resolve "${displayPath}": it is missing or a broken symlink`)
  }
  if (!isWithin(realPath, rootReal)) {
    throw new Error(`"${displayPath}" is a symlink that points outside the project directory`)
  }
  return realPath
}

function validateUpload(
  upload: PresignedUpload,
  sourcePath: string,
  rootReal: string,
  hashByPath: Map<string, string>
): { upload: PresignedUpload; realPath: string; hash: string } {
  const segments = upload.path.split(/[\\/]/)
  if (
    !upload.path ||
    path.isAbsolute(upload.path) ||
    path.posix.isAbsolute(upload.path) ||
    segments.includes('..')
  ) {
    throw new Error(`Refusing to upload "${upload.path}": path must be relative to source_dir`)
  }

  const hash = hashByPath.get(upload.path)
  if (hash === undefined) {
    throw new Error(`Refusing to upload "${upload.path}": it is not in the submitted manifest`)
  }

  let protocol: string
  try {
    protocol = new URL(upload.url).protocol
  } catch {
    throw new Error(`Refusing to upload "${upload.path}": the upload URL is invalid`)
  }
  if (protocol !== 'https:') {
    throw new Error(`Refusing to upload "${upload.path}": the upload URL must use https`)
  }

  const realPath = realPathWithinRoot(path.join(sourcePath, upload.path), rootReal, upload.path)
  return { upload, realPath, hash }
}

// O_NOFOLLOW plus fstat narrows the window for swapping the path to a link or special file after validation.
function readRegularFile(realPath: string, displayPath: string): Buffer {
  const fd = fs.openSync(realPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    if (!fs.fstatSync(fd).isFile()) {
      throw new Error(`Refusing to upload "${displayPath}": it is not a regular file`)
    }
    return fs.readFileSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

/** Follows a symlink only while its target stays inside `rootReal`; an escaping link throws. */
function getAllFiles(sourceDir: string, rootReal: string): string[] {
  const files: string[] = []

  const walk = (dirPath: string, ancestors: ReadonlySet<string>): void => {
    const realDir = fs.realpathSync(dirPath)
    if (ancestors.has(realDir)) {
      return
    }
    const lineage = new Set(ancestors).add(realDir)

    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const fullPath = path.join(dirPath, entry.name)
      const stat = entry.isSymbolicLink()
        ? fs.statSync(realPathWithinRoot(fullPath, rootReal, path.relative(sourceDir, fullPath)))
        : entry

      if (stat.isDirectory()) {
        walk(fullPath, lineage)
      } else if (stat.isFile()) {
        files.push(fullPath)
      }
    }
  }

  walk(sourceDir, new Set())
  return files
}

const STAGING_DIR_NAME = '.gantry'

function getStagingPath(projectDir: string): string {
  return path.join(projectDir, STAGING_DIR_NAME)
}

export function cleanStagingDir(projectDir: string): void {
  const stagingPath = getStagingPath(projectDir)
  fs.rmSync(stagingPath, { recursive: true, force: true })
  fs.mkdirSync(stagingPath, { recursive: true })
}

interface GitignoreScope {
  base: string
  ig: ReturnType<typeof ignore>
}

/**
 * Honours every `.gitignore` in the tree the way git does: rules are relative to
 * their own directory, and deeper files (including `!` negations) win. With
 * `useGitignore` false, everything on disk is copied and services trim it with
 * `exclude:`. WordPress needs this because projects often gitignore core files,
 * including `index.php`.
 */
export function copyToStagingDir(projectDir: string, useGitignore = true): void {
  const stagingPath = getStagingPath(projectDir)

  // `.gitignore` never lists `.git`, and a static service would publish it to a
  // public bucket. In submodules and worktrees `.git` is a file, not a directory.
  const alwaysIgnored = ignore().add(['.git', STAGING_DIR_NAME])

  copyDirRecursive(projectDir, stagingPath, projectDir, alwaysIgnored, useGitignore ? [] : null)
}

function loadGitignoreScope(dir: string, rootDir: string): GitignoreScope | null {
  const gitignorePath = path.join(dir, '.gitignore')
  if (!fs.statSync(gitignorePath, { throwIfNoEntry: false })?.isFile()) {
    return null
  }
  return {
    base: path.relative(rootDir, dir).replace(/\\/g, '/'),
    ig: ignore().add(fs.readFileSync(gitignorePath, 'utf-8')),
  }
}

function isGitignored(relativePath: string, isDir: boolean, scopes: GitignoreScope[]): boolean {
  let ignored = false
  for (const { base, ig } of scopes) {
    const scoped = base ? relativePath.slice(base.length + 1) : relativePath
    const result = ig.test(isDir ? `${scoped}/` : scoped)
    if (result.ignored) {
      ignored = true
    } else if (result.unignored) {
      ignored = false
    }
  }
  return ignored
}

/** `parentScopes` is null when `.gitignore` files are not honoured. */
function copyDirRecursive(
  srcDir: string,
  destDir: string,
  rootDir: string,
  alwaysIgnored: ReturnType<typeof ignore>,
  parentScopes: GitignoreScope[] | null
): void {
  const ownScope = parentScopes ? loadGitignoreScope(srcDir, rootDir) : null
  const scopes = parentScopes && ownScope ? [...parentScopes, ownScope] : parentScopes

  const isIgnored = (relativePath: string, isDir: boolean): boolean =>
    alwaysIgnored.ignores(isDir ? `${relativePath}/` : relativePath) ||
    (scopes !== null && isGitignored(relativePath, isDir, scopes))

  const entries = fs.readdirSync(srcDir, { withFileTypes: true })

  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name)
    const destPath = path.join(destDir, entry.name)

    const relativePath = path.relative(rootDir, srcPath).replace(/\\/g, '/')

    // Recreate symlinks rather than copying their targets. `node_modules/.bin/*`
    // scripts resolve imports relative to the link's location, so a flattened copy
    // breaks only when the binary runs. A Dirent comes from lstat, so
    // `isDirectory()` is false even for a link to a directory.
    if (entry.isSymbolicLink()) {
      if (isIgnored(relativePath, false) || isIgnored(relativePath, true)) {
        continue
      }

      fs.symlinkSync(fs.readlinkSync(srcPath), destPath)
      continue
    }

    if (entry.isDirectory()) {
      if (isIgnored(relativePath, true)) {
        continue
      }

      fs.mkdirSync(destPath, { recursive: true })
      copyDirRecursive(srcPath, destPath, rootDir, alwaysIgnored, scopes)
    } else {
      if (isIgnored(relativePath, false)) {
        continue
      }

      fs.copyFileSync(srcPath, destPath)
    }
  }
}

export function removeStagingDir(projectDir: string): void {
  fs.rmSync(getStagingPath(projectDir), { recursive: true, force: true })
}

export function getStagingDirPath(projectDir: string): string {
  return getStagingPath(projectDir)
}
