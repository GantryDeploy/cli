/** Internal type. DO NOT USE DIRECTLY. */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
/** Internal type. DO NOT USE DIRECTLY. */
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
export type ActivationInput = {
  /** Environment slug (e.g. "production") */
  environment: string;
  /** Project ID */
  projectId: string;
  /** Target version (rollback/promote) or canary version (canary) */
  versionId?: string | null | undefined;
  /** Canary weight, 0–100 */
  weight?: number | null | undefined;
};

export type ArtifactUploadCliOutputsInput = {
  bucketName: string;
  s3Key: string;
  success: boolean;
  /** Size of the uploaded zip in bytes */
  zipSize: number;
};

/** Status of a bastion host */
export type BastionStatusEnum =
  | 'ACTIVE'
  | 'DELETED'
  | 'DELETE_FAILED'
  | 'DELETING'
  | 'FAILED'
  | 'PENDING'
  | 'PROVISIONING';

/** Cache engine type */
export type CacheEngineEnum =
  | 'MEMCACHED'
  | 'REDIS'
  | 'VALKEY';

/** Status of a cache */
export type CacheStatusEnum =
  | 'ACTIVE'
  | 'FAILED'
  | 'PENDING';

/** Certificate status values */
export type CertificateStatusEnum =
  | 'ACTIVE'
  | 'DELETED'
  | 'DELETING'
  | 'EXPIRED'
  | 'FAILED'
  | 'PARTIAL'
  | 'PENDING'
  | 'VALIDATING';

/** The status of CLI execution for a step */
export type CliStatus =
  | 'CLAIMED'
  | 'COMPLETE'
  | 'FAILED'
  | 'PENDING';

/** Results of a CLI task. Set exactly one field, matching the step's cliTask. */
export type CliTaskOutputsInput = {
  artifactUpload?: ArtifactUploadCliOutputsInput | null | undefined;
  containerPush?: ContainerPushCliOutputsInput | null | undefined;
  localBuild?: LocalBuildCliOutputsInput | null | undefined;
  s3Upload?: S3UploadCliOutputsInput | null | undefined;
};

/** Supported cloud providers */
export type CloudProviderEnum =
  | 'AWS'
  | 'AZURE'
  | 'CLOUDFLARE'
  | 'DIGITALOCEAN'
  | 'GCP'
  | 'VULTR';

/** Status of a cluster */
export type ClusterStatusEnum =
  | 'ACTIVE'
  | 'FAILED'
  | 'PENDING';

/** Type of cluster */
export type ClusterTypeEnum =
  | 'ECS';

export type ContainerPushCliOutputsInput = {
  imageUri: string;
  localImageTag: string;
  success: boolean;
};

export type CreateBastionInput = {
  /** Cloud account ID */
  cloudAccountId: string;
  /** User-friendly name */
  name: string;
  /** Network ID - must have public subnets */
  networkId: string;
  /** URL-friendly identifier for CLI and API references */
  slug: string;
};

export type CreateCacheInput = {
  /** Cloud account ID */
  cloudAccountId: string;
  /** Cache engine */
  engine: CacheEngineEnum;
  /** User-friendly name */
  name: string;
  /** Network ID - required for all caches */
  networkId: string;
  /** Provider-specific configuration including region and deployment mode */
  providerData?: Record<string, unknown> | null | undefined;
  /** URL-friendly identifier for CLI and API references */
  slug: string;
};

export type CreateCertificateInput = {
  additionalDomains?: Array<string> | null | undefined;
  cloudAccountId: string;
  domainId?: string | null | undefined;
  primaryDomain: string;
  regions: Array<string>;
};

export type CreateClusterInput = {
  /** Cloud account ID */
  cloudAccountId: string;
  /** User-friendly name */
  name: string;
  /** Network ID - required for managed instances */
  networkId?: string | null | undefined;
  /** Provider-specific configuration including capacity providers */
  providerData?: Record<string, unknown> | null | undefined;
  /** AWS region for the cluster */
  region: string;
  /** URL-friendly identifier for CLI and API references */
  slug: string;
  /** Cluster type */
  type: ClusterTypeEnum;
};

export type CreateDatabaseInput = {
  /** Cloud account ID */
  cloudAccountId: string;
  /** Database engine */
  engine: DatabaseEngineEnum;
  /** User-friendly name */
  name: string;
  /** Network ID - required for all databases */
  networkId: string;
  /** Provider-specific configuration including region and deployment mode */
  providerData?: Record<string, unknown> | null | undefined;
  /** URL-friendly identifier for CLI and API references */
  slug: string;
};

export type CreateDomainInput = {
  /** Root domain FQDN (e.g., example.com) */
  name: string;
};

export type CreateEnvironmentInput = {
  cloudAccountId: string;
  color?: string | null | undefined;
  isProduction?: boolean;
  name: string;
  networkId?: string | null | undefined;
  projectId: string;
  region: string;
  slug: string;
};

export type CreateFilesystemInput = {
  /** Cloud account ID */
  cloudAccountId: string;
  /** User-friendly name */
  name: string;
  /** Network ID - required for all filesystems */
  networkId: string;
  /** Provider-specific configuration including region */
  providerData?: Record<string, unknown> | null | undefined;
  /** URL-friendly identifier for CLI and API references */
  slug: string;
  /** Filesystem type (efs, filestore) */
  type: FilesystemTypeEnum;
};

export type CreateLoadBalancerInput = {
  /** Cloud account ID */
  cloudAccountId: string;
  /** User-friendly name */
  name: string;
  /** Network ID - required for AWS ALB */
  networkId?: string | null | undefined;
  /** Provider-specific configuration including region */
  providerData?: Record<string, unknown> | null | undefined;
  /** URL-friendly identifier for CLI and API references */
  slug: string;
  /** Load balancer type */
  type: LoadBalancerTypeEnum;
};

export type CreateNetworkInput = {
  cloudAccountId: string;
  name: string;
  providerConfig?: Record<string, unknown> | null | undefined;
  region: string;
  slug: string;
  subnets?: Record<string, unknown> | null | undefined;
};

export type CreateProjectInput = {
  /** Cloud provider: aws, gcp, or cloudflare */
  cloudProvider: string;
  name: string;
  tag?: string | null | undefined;
};

export type CreateSecretInput = {
  cloudAccountId: string;
  description?: string | null | undefined;
  keyValuePairs: Array<SecretKeyValueInput>;
  name: string;
};

/** Database engine type */
export type DatabaseEngineEnum =
  | 'AURORA_MYSQL'
  | 'AURORA_POSTGRESQL'
  | 'MARIADB'
  | 'MYSQL'
  | 'POSTGRESQL';

/** Status of a database */
export type DatabaseStatusEnum =
  | 'ACTIVE'
  | 'FAILED'
  | 'PENDING';

export type DeploymentOptionsInput = {
  /** Delete stale files after upload */
  deleteStale?: boolean | null | undefined;
  /** Force re-upload all files */
  force?: boolean | null | undefined;
};

/** The phase of a deployment step */
export type DeploymentPhase =
  | 'BUILDING'
  | 'DEPLOYING'
  | 'GO_LIVE'
  | 'POST_DEPLOY'
  | 'SETUP'
  | 'UPLOADING';

/** The status of a deployment */
export type DeploymentStatus =
  | 'BLOCKED'
  | 'CANCELLED'
  | 'CANCELLING'
  | 'COMPLETE'
  | 'FAILED'
  | 'INITIALIZING'
  | 'PENDING'
  | 'PLANNING'
  | 'RUNNING'
  | 'SKIPPED';

/** The status of a deployment step */
export type DeploymentStepStatus =
  | 'AWAITING_CLI'
  | 'CANCELLED'
  | 'COMPLETE'
  | 'FAILED'
  | 'MANIFEST_REQUIRED'
  | 'PENDING'
  | 'PROCESSING'
  | 'QUEUED';

export type FileManifestItem = {
  /** MD5 hash of the file content */
  hash: string;
  /** Relative file path (e.g., "css/app.css") */
  path: string;
};

export type FileUploadResultInput = {
  /** MD5 hash of the file content */
  hash: string;
  /** Relative file path */
  path: string;
  /** Whether the file was successfully uploaded */
  success: boolean;
};

/** Status of a filesystem */
export type FilesystemStatusEnum =
  | 'ACTIVE'
  | 'FAILED'
  | 'PENDING';

/** Filesystem provider type */
export type FilesystemTypeEnum =
  | 'EFS'
  | 'FILESTORE';

/** Status of a load balancer */
export type LoadBalancerStatusEnum =
  | 'ACTIVE'
  | 'FAILED'
  | 'PENDING';

/** Type of load balancer */
export type LoadBalancerTypeEnum =
  | 'APPLICATION'
  | 'GATEWAY_HTTP'
  | 'GLOBAL';

export type LocalBuildCliOutputsInput = {
  buildCommands?: string | null | undefined;
  localImageTag?: string | null | undefined;
  serviceName: string;
  success: boolean;
};

export type PromoteVersionInput = {
  /** Source version ID to promote from */
  sourceVersionId: string;
  /** Target environment ID to promote to */
  targetEnvironmentId: string;
};

export type ResolveProjectInput = {
  environment?: string | null | undefined;
  projectId: string;
  variables?: Array<VariableOverrideInput> | null | undefined;
  yaml: string;
};

export type S3UploadCliOutputsInput = {
  success: boolean;
  /** Total bytes uploaded */
  totalSize: number;
  uploadedFiles: number;
};

export type SecretKeyValueInput = {
  key: string;
  value: string;
};

export type StartTeardownInput = {
  /** Confirmation phrase typed by user */
  confirmationPhrase: string;
  /** Environment slug (the key name from environments section in gantry.yml) */
  environmentSlug: string;
  /** Project ID from gantry.yml */
  projectId: string;
  /** JWT token issued by teardownPreview */
  teardownToken: string;
};

/** Who executes the step - Gantry (cloud) or the CLI (local) */
export type StepExecutor =
  | 'CLI'
  | 'WORKER';

export type SubmitManifestInput = {
  /** Delete stale files after upload */
  delete?: boolean | null | undefined;
  /** List of files to upload */
  files: Array<FileManifestItem>;
  /** Force re-upload, skip deduplication */
  force?: boolean | null | undefined;
  /** Step ID that needs the manifest */
  stepId: string;
};

export type UpdateSecretInput = {
  description?: string | null | undefined;
  id: string;
  keyValuePairs?: Array<SecretKeyValueInput> | null | undefined;
  name?: string | null | undefined;
};

export type VariableOverrideInput = {
  name: string;
  value: string;
};

export type GetActivationDeploymentQueryVariables = Exact<{
  id: string;
}>;


export type GetActivationDeploymentQuery = { deployment: { id: string, status: DeploymentStatus, lastMessage: string | null } | null };

export type AbortCanaryMutationVariables = Exact<{
  input: ActivationInput;
}>;


export type AbortCanaryMutation = { abortCanary: { success: boolean, message: string | null, deploymentId: string | null } };

export type PromoteBlueGreenMutationVariables = Exact<{
  input: ActivationInput;
}>;


export type PromoteBlueGreenMutation = { promoteBlueGreen: { success: boolean, message: string | null, deploymentId: string | null } };

export type PromoteCanaryMutationVariables = Exact<{
  input: ActivationInput;
}>;


export type PromoteCanaryMutation = { promoteCanary: { success: boolean, message: string | null, deploymentId: string | null } };

export type RollbackDeploymentMutationVariables = Exact<{
  input: ActivationInput;
}>;


export type RollbackDeploymentMutation = { rollbackDeployment: { success: boolean, message: string | null, deploymentId: string | null } };

export type SetCanaryMutationVariables = Exact<{
  input: ActivationInput;
}>;


export type SetCanaryMutation = { setCanary: { success: boolean, message: string | null, deploymentId: string | null } };

export type GetCachesQueryVariables = Exact<{ [key: string]: never; }>;


export type GetCachesQuery = { caches: Array<{ id: string, name: string, slug: string, engine: CacheEngineEnum, status: CacheStatusEnum, cloudAccountId: string, networkId: string, endpoint: string | null, port: number | null, createdAt: string }> };

export type GetCacheTypesQueryVariables = Exact<{
  provider?: string | null | undefined;
}>;


export type GetCacheTypesQuery = { cacheTypes: Array<{ type: CacheEngineEnum, displayName: string, provider: string, description: string, guidance: string, supportsServerless: boolean, supportsClusterMode: boolean, requiresNetwork: boolean }> };

export type GetCacheEngineVersionsQueryVariables = Exact<{
  engine?: string | null | undefined;
  region?: string | null | undefined;
}>;


export type GetCacheEngineVersionsQuery = { cacheEngineVersions: Array<{ engine: string, version: string, family: string, supportedModes: Array<string> }> };

export type GetCacheNodeTypesQueryVariables = Exact<{
  engine?: string | null | undefined;
  region?: string | null | undefined;
}>;


export type GetCacheNodeTypesQuery = { cacheNodeTypes: Array<{ nodeType: string, family: string, size: string, memoryGiB: number, vcpu: number }> };

export type CreateCacheMutationVariables = Exact<{
  input: CreateCacheInput;
}>;


export type CreateCacheMutation = { createCache: { success: boolean, message: string | null, deploymentId: string | null, cache: { id: string, name: string, slug: string, engine: CacheEngineEnum, status: CacheStatusEnum } | null } };

export type GetCacheTunnelBastionQueryVariables = Exact<{
  slug: string;
}>;


export type GetCacheTunnelBastionQuery = { bastion: { id: string, instanceId: string | null, publicIp: string | null } | null };

export type GetCloudsQueryVariables = Exact<{ [key: string]: never; }>;


export type GetCloudsQuery = { clouds: Array<{ id: string, name: string, provider: CloudProviderEnum, createdAt: string }> };

export type GetClustersQueryVariables = Exact<{ [key: string]: never; }>;


export type GetClustersQuery = { clusters: Array<{ id: string, name: string, slug: string, type: ClusterTypeEnum, status: ClusterStatusEnum, region: string, cloudAccountId: string, createdAt: string }> };

export type GetClusterTypesQueryVariables = Exact<{
  provider?: string | null | undefined;
}>;


export type GetClusterTypesQuery = { clusterTypes: Array<{ type: ClusterTypeEnum, displayName: string, provider: string, description: string, guidance: string | null }> };

export type CreateClusterMutationVariables = Exact<{
  input: CreateClusterInput;
}>;


export type CreateClusterMutation = { createCluster: { success: boolean, message: string | null, deploymentId: string | null, cluster: { id: string, name: string, slug: string, type: ClusterTypeEnum, status: ClusterStatusEnum, region: string } | null } };

export type RunConsoleCommandMutationVariables = Exact<{
  projectId: string;
  environmentSlug: string;
  service: string;
  command: Array<string> | string;
  variant?: string | null | undefined;
}>;


export type RunConsoleCommandMutation = { runConsoleCommand: { success: boolean, exitCode: number, output: string, message: string | null } };

export type GetDatabasesQueryVariables = Exact<{ [key: string]: never; }>;


export type GetDatabasesQuery = { databases: Array<{ id: string, name: string, slug: string, engine: DatabaseEngineEnum, status: DatabaseStatusEnum, cloudAccountId: string, networkId: string, endpoint: string | null, port: number | null, publiclyAccessible: boolean | null, createdAt: string }> };

export type GetDatabaseCredentialsQueryVariables = Exact<{
  id: string;
}>;


export type GetDatabaseCredentialsQuery = { databaseCredentials: { success: boolean, message: string | null, username: string | null, password: string | null } };

export type GetDatabaseTypesQueryVariables = Exact<{
  provider?: string | null | undefined;
}>;


export type GetDatabaseTypesQuery = { databaseTypes: Array<{ type: DatabaseEngineEnum, displayName: string, provider: string, description: string, guidance: string, supportsServerless: boolean, requiresNetwork: boolean }> };

export type GetDatabaseEngineVersionsQueryVariables = Exact<{
  engine?: string | null | undefined;
  deploymentMode?: string | null | undefined;
  region?: string | null | undefined;
}>;


export type GetDatabaseEngineVersionsQuery = { databaseEngineVersions: Array<{ engine: string, version: string, family: string, description: string, supportedModes: Array<string> }> };

export type GetDatabaseInstanceClassesQueryVariables = Exact<{
  engine?: string | null | undefined;
  region?: string | null | undefined;
}>;


export type GetDatabaseInstanceClassesQuery = { databaseInstanceClasses: Array<{ instanceClass: string, family: string, size: string, vcpu: number, memoryMb: number }> };

export type CreateDatabaseMutationVariables = Exact<{
  input: CreateDatabaseInput;
}>;


export type CreateDatabaseMutation = { createDatabase: { success: boolean, message: string | null, deploymentId: string | null, database: { id: string, name: string, slug: string, engine: DatabaseEngineEnum, status: DatabaseStatusEnum } | null } };

export type GetDatabaseTunnelBastionQueryVariables = Exact<{
  slug: string;
}>;


export type GetDatabaseTunnelBastionQuery = { bastion: { id: string, instanceId: string | null, publicIp: string | null } | null };

export type GetDeploymentQueryVariables = Exact<{
  id: string;
}>;


export type GetDeploymentQuery = { deployment: { id: string, status: DeploymentStatus, lastMessage: string | null, environmentId: string | null, environmentName: string | null, projectName: string | null, deploymentType: string | null, startedAt: string, completedAt: string | null } | null };

export type GetDeploymentsByVersionQueryVariables = Exact<{
  versionId: string;
}>;


export type GetDeploymentsByVersionQuery = { deploymentsByVersion: Array<{ id: string, status: DeploymentStatus, lastMessage: string | null, environmentName: string | null, deploymentType: string | null, startedAt: string, completedAt: string | null }> };

export type GetDeploymentVersionsQueryVariables = Exact<{
  projectId: string;
  environmentId: string;
}>;


export type GetDeploymentVersionsQuery = { versionsByProject: Array<{ id: string, number: number, gitRef: string | null, createdAt: string }> };

export type CancelDeploymentMutationVariables = Exact<{
  id: string;
}>;


export type CancelDeploymentMutation = { cancelDeployment: { success: boolean, message: string | null } };

export type GetDomainsQueryVariables = Exact<{ [key: string]: never; }>;


export type GetDomainsQuery = { domains: Array<{ id: string, name: string, createdAt: string, updatedAt: string }> };

export type CreateDomainMutationVariables = Exact<{
  input: CreateDomainInput;
}>;


export type CreateDomainMutation = { createDomain: { success: boolean, message: string | null, domain: { id: string, name: string, createdAt: string } | null } };

export type CreateCertificateMutationVariables = Exact<{
  input: CreateCertificateInput;
}>;


export type CreateCertificateMutation = { createCertificate: { success: boolean, message: string | null, certificate: { id: string, primaryDomain: string, status: CertificateStatusEnum, createdAt: string } | null } };

export type GetEnvironmentsQueryVariables = Exact<{
  projectId?: string | null | undefined;
}>;


export type GetEnvironmentsQuery = { environments: Array<{ id: string, projectId: string, name: string, color: string | null, isProduction: boolean, createdAt: string }> };

export type GetEnvironmentProjectsQueryVariables = Exact<{ [key: string]: never; }>;


export type GetEnvironmentProjectsQuery = { projects: Array<{ id: string, name: string }> };

export type CreateEnvironmentMutationVariables = Exact<{
  input: CreateEnvironmentInput;
}>;


export type CreateEnvironmentMutation = { createEnvironment: { success: boolean, message: string | null, environment: { id: string, name: string, createdAt: string } | null } };

export type GetFilesystemsQueryVariables = Exact<{ [key: string]: never; }>;


export type GetFilesystemsQuery = { filesystems: Array<{ id: string, name: string, slug: string, type: FilesystemTypeEnum, status: FilesystemStatusEnum, cloudAccountId: string, networkId: string, createdAt: string }> };

export type GetFilesystemNetworksQueryVariables = Exact<{ [key: string]: never; }>;


export type GetFilesystemNetworksQuery = { networks: Array<{ id: string, name: string, region: string, cloudAccountId: string }> };

export type CreateFilesystemMutationVariables = Exact<{
  input: CreateFilesystemInput;
}>;


export type CreateFilesystemMutation = { createFilesystem: { success: boolean, message: string | null, filesystem: { id: string, name: string, slug: string, type: FilesystemTypeEnum, status: FilesystemStatusEnum } | null } };

export type CreateVersionMutationVariables = Exact<{
  config: Record<string, unknown>;
  environment?: string | null | undefined;
  gitRef?: string | null | undefined;
}>;


export type CreateVersionMutation = { createVersion: { success: boolean, message: string | null, versionId: string | null, versionNumber: number | null, projectId: string | null, projectSlug: string | null } };

export type StartLiftDeploymentMutationVariables = Exact<{
  environment: string;
  config: Record<string, unknown>;
  versionId?: string | null | undefined;
  options?: DeploymentOptionsInput | null | undefined;
}>;


export type StartLiftDeploymentMutation = { startDeployment: { success: boolean, message: string | null, deploymentIds: Array<string> | null, versionId: string | null, deployment: { id: string, teamId: string, environmentId: string | null, status: DeploymentStatus, lastMessage: string | null, startedAt: string, updatedAt: string, completedAt: string | null, projectName: string | null, projectId: string | null, serviceName: string | null, environmentName: string | null } | null } };

export type GetLiftDeploymentQueryVariables = Exact<{
  id: string;
}>;


export type GetLiftDeploymentQuery = { deployment: { id: string, teamId: string, environmentId: string | null, status: DeploymentStatus, lastMessage: string | null, startedAt: string, updatedAt: string, completedAt: string | null, projectName: string | null, projectId: string | null, serviceName: string | null, environmentName: string | null, steps: Array<{ id: string, stepType: string, status: DeploymentStepStatus, phase: DeploymentPhase, executor: StepExecutor, cliTask: string | null, cliStatus: CliStatus | null, sequence: number }> | null } | null };

export type CancelLiftDeploymentMutationVariables = Exact<{
  id: string;
}>;


export type CancelLiftDeploymentMutation = { cancelDeployment: { success: boolean, message: string | null, deployment: { id: string, status: DeploymentStatus, lastMessage: string | null, updatedAt: string } | null } };

export type ClaimStepMutationVariables = Exact<{
  stepId: string;
}>;


export type ClaimStepMutation = { claimStep: { success: boolean, message: string | null, step: { id: string, stepType: string, cliTask: string | null, cliInputs:
        | { __typename: 'ArtifactUploadCliInputs', stepId: string, bucketName: string, s3Key: string, region: string, accessKeyId: string | null, secretAccessKey: string | null, sessionToken: string | null, sourcePath: string, excludePatterns: Array<string> | null }
        | { __typename: 'ContainerPushCliInputs', stepId: string, imageUri: string, localImageTag: string, ecrAuthToken: string | null, ecrEndpoint: string }
        | { __typename: 'LocalBuildCliInputs', stepId: string, serviceName: string, versionNumber: number, projectId: string, projectSlug: string, buildCommands: Array<string> | null, dockerfile: string | null, workingDir: string | null, dockerTarget: string | null, namedBuildName: string | null, buildArgs: Array<{ name: string, value: string }> | null }
        | { __typename: 'S3UploadCliInputs', stepId: string, sourcePath: string, includePatterns: Array<string> | null, excludePatterns: Array<string> | null }
       | null } | null } };

export type CompleteCliStepMutationVariables = Exact<{
  stepId: string;
  outputs: CliTaskOutputsInput;
  fileResults?: Array<FileUploadResultInput> | FileUploadResultInput | null | undefined;
}>;


export type CompleteCliStepMutation = { completeCliStep: { success: boolean, message: string | null } };

export type FailCliStepMutationVariables = Exact<{
  stepId: string;
  error: string;
}>;


export type FailCliStepMutation = { failCliStep: { success: boolean, message: string | null } };

export type DeploymentsByVersionQueryVariables = Exact<{
  versionId: string;
}>;


export type DeploymentsByVersionQuery = { deploymentsByVersion: Array<{ id: string, status: DeploymentStatus, scope: string | null, deploymentType: string | null, lastMessage: string | null, serviceName: string | null, steps: Array<{ id: string, stepType: string, status: DeploymentStepStatus, phase: DeploymentPhase, executor: StepExecutor, cliTask: string | null, cliStatus: CliStatus | null, sequence: number }> | null }> };

export type VersionRouteUrlsQueryVariables = Exact<{
  versionId: string;
}>;


export type VersionRouteUrlsQuery = { versionRouteUrls: Array<{ url: string, domain: string | null, path: string, serviceName: string, cache: string | null }> };

export type VersionDnsRecordsQueryVariables = Exact<{
  versionId: string;
}>;


export type VersionDnsRecordsQuery = { versionDnsRecords: Array<{ hostname: string, recordType: string, name: string, value: string, managed: boolean, syncStatus: string }> };

export type GetLoadBalancersQueryVariables = Exact<{ [key: string]: never; }>;


export type GetLoadBalancersQuery = { loadBalancers: Array<{ id: string, name: string, slug: string, type: LoadBalancerTypeEnum, status: LoadBalancerStatusEnum, cloudAccountId: string, createdAt: string }> };

export type GetLoadBalancerTypesQueryVariables = Exact<{
  provider?: string | null | undefined;
}>;


export type GetLoadBalancerTypesQuery = { loadBalancerTypes: Array<{ type: LoadBalancerTypeEnum, displayName: string, provider: string, description: string, guidance: string, requiresNetwork: boolean, requiresRegion: boolean }> };

export type CreateLoadBalancerMutationVariables = Exact<{
  input: CreateLoadBalancerInput;
}>;


export type CreateLoadBalancerMutation = { createLoadBalancer: { success: boolean, message: string | null, deploymentId: string | null, loadBalancer: { id: string, name: string, slug: string, type: LoadBalancerTypeEnum, status: LoadBalancerStatusEnum } | null } };

export type VerifyLoginQueryVariables = Exact<{ [key: string]: never; }>;


export type VerifyLoginQuery = { whoami: { teamIds: Array<string>, kind: string, tokenName: string, authenticated: boolean } };

export type GetNetworksQueryVariables = Exact<{ [key: string]: never; }>;


export type GetNetworksQuery = { networks: Array<{ id: string, name: string, slug: string, region: string, cloudAccountId: string, stackStatus: string | null, createdAt: string }> };

export type CreateNetworkMutationVariables = Exact<{
  input: CreateNetworkInput;
}>;


export type CreateNetworkMutation = { createNetwork: { success: boolean, message: string | null, deploymentId: string | null, network: { id: string, name: string, slug: string, region: string } | null } };

export type GetProjectsQueryVariables = Exact<{ [key: string]: never; }>;


export type GetProjectsQuery = { projects: Array<{ id: string, name: string, slug: string, tag: string | null, cloudProvider: string | null, createdAt: string }> };

export type GetProjectQueryVariables = Exact<{
  id?: string | null | undefined;
  slug?: string | null | undefined;
}>;


export type GetProjectQuery = { project: { id: string, name: string, slug: string, tag: string | null, cloudProvider: string | null, createdAt: string } | null };

export type GetProjectEnvironmentsQueryVariables = Exact<{
  projectId?: string | null | undefined;
}>;


export type GetProjectEnvironmentsQuery = { environments: Array<{ id: string, name: string, isProduction: boolean, createdAt: string }> };

export type CreateProjectMutationVariables = Exact<{
  input: CreateProjectInput;
}>;


export type CreateProjectMutation = { createProject: { success: boolean, message: string | null, project: { id: string, name: string, slug: string, tag: string | null, cloudProvider: string | null, createdAt: string } | null } };

export type PromoteVersionMutationVariables = Exact<{
  input: PromoteVersionInput;
}>;


export type PromoteVersionMutation = { promoteVersion: { success: boolean, message: string | null, promotionId: string | null, newVersionId: string | null, newVersionNumber: number | null, yamlSnapshot: string | null } };

export type StartPromotedDeploymentMutationVariables = Exact<{
  environment: string;
  config: Record<string, unknown>;
  versionId?: string | null | undefined;
  options?: DeploymentOptionsInput | null | undefined;
}>;


export type StartPromotedDeploymentMutation = { startDeployment: { success: boolean, message: string | null, deploymentIds: Array<string> | null, versionId: string | null, deployment: { id: string, status: DeploymentStatus, lastMessage: string | null, startedAt: string, projectName: string | null, serviceName: string | null, environmentName: string | null } | null } };

export type GetPromotedDeploymentQueryVariables = Exact<{
  id: string;
}>;


export type GetPromotedDeploymentQuery = { deployment: { id: string, status: DeploymentStatus, lastMessage: string | null, startedAt: string, updatedAt: string, completedAt: string | null, projectName: string | null, serviceName: string | null, environmentName: string | null } | null };

export type GetPromoteTargetEnvironmentsQueryVariables = Exact<{
  projectId: string;
}>;


export type GetPromoteTargetEnvironmentsQuery = { environments: Array<{ id: string, name: string, slug: string }> };

export type GetCloudRegionsQueryVariables = Exact<{
  provider?: string | null | undefined;
}>;


export type GetCloudRegionsQuery = { cloudRegions: Array<{ code: string, name: string }> };

export type TriggerRerouteMutationVariables = Exact<{
  config: Record<string, unknown>;
  environment: string;
}>;


export type TriggerRerouteMutation = { triggerReroute: { success: boolean, message: string | null, deploymentId: string | null, versionId: string | null, versionNumber: number | null } };

export type GetRerouteDeploymentQueryVariables = Exact<{
  id: string;
}>;


export type GetRerouteDeploymentQuery = { deployment: { id: string, teamId: string, environmentId: string | null, status: DeploymentStatus, lastMessage: string | null, startedAt: string, updatedAt: string, completedAt: string | null, projectName: string | null, projectId: string | null, environmentName: string | null, serviceName: string | null } | null };

export type GetSecretsQueryVariables = Exact<{
  cloudAccountId?: string | null | undefined;
}>;


export type GetSecretsQuery = { secrets: Array<{ id: string, name: string, description: string | null, cloudAccountId: string, createdAt: string }> };

export type GetSecretQueryVariables = Exact<{
  id: string;
}>;


export type GetSecretQuery = { secret: { id: string, name: string, description: string | null, cloudAccountId: string, createdAt: string } | null };

export type CreateSecretMutationVariables = Exact<{
  input: CreateSecretInput;
}>;


export type CreateSecretMutation = { createSecret: { success: boolean, message: string | null, secret: { id: string, name: string, description: string | null, cloudAccountId: string, createdAt: string } | null } };

export type GetSecretKeysQueryVariables = Exact<{
  id: string;
}>;


export type GetSecretKeysQuery = { secret: { id: string, keys: Array<string> } | null };

export type UpdateSecretMutationVariables = Exact<{
  input: UpdateSecretInput;
}>;


export type UpdateSecretMutation = { updateSecret: { success: boolean, message: string | null } };

export type DeleteSecretMutationVariables = Exact<{
  id: string;
}>;


export type DeleteSecretMutation = { deleteSecret: { success: boolean, message: string | null } };

export type TeardownPreviewQueryVariables = Exact<{
  projectId: string;
  environmentSlug: string;
}>;


export type TeardownPreviewQuery = { teardownPreview: { environmentId: string, environmentName: string, totalResources: number, teardownToken: string, expiresAt: string, resources: Array<{ id: string, resourceType: string, resourceId: string | null, status: string }> } };

export type StartTeardownMutationVariables = Exact<{
  input: StartTeardownInput;
}>;


export type StartTeardownMutation = { startTeardown: { success: boolean, message: string | null, teardownId: string | null } };

export type GetVersionsQueryVariables = Exact<{
  projectId: string;
  environmentId: string;
}>;


export type GetVersionsQuery = { versionsByProject: Array<{ id: string, number: number, gitRef: string | null, createdAt: string }> };

export type WhoAmIQueryVariables = Exact<{ [key: string]: never; }>;


export type WhoAmIQuery = { whoami: { teamId: string | null, teamIds: Array<string>, kind: string, tokenName: string, authenticated: boolean, isAdmin: boolean, access: Array<{ resource: string, level: string }> } };

export type GetBastionsQueryVariables = Exact<{
  networkId?: string | null | undefined;
}>;


export type GetBastionsQuery = { bastions: Array<{ slug: string, name: string, status: BastionStatusEnum, networkId: string, cloudAccountId: string, instanceId: string | null, publicIp: string | null, createdAt: string }> };

export type GetBastionQueryVariables = Exact<{
  slug: string;
}>;


export type GetBastionQuery = { bastion: { slug: string, name: string, status: BastionStatusEnum, networkId: string, cloudAccountId: string, instanceId: string | null, publicIp: string | null, createdAt: string } | null };

export type GetBastionPrivateKeyQueryVariables = Exact<{
  slug: string;
}>;


export type GetBastionPrivateKeyQuery = { bastionPrivateKey: { success: boolean, message: string | null, privateKey: string | null } };

export type CreateBastionMutationVariables = Exact<{
  input: CreateBastionInput;
}>;


export type CreateBastionMutation = { createBastion: { success: boolean, message: string | null, deploymentId: string | null, bastion: { slug: string, name: string, status: BastionStatusEnum, networkId: string, cloudAccountId: string, instanceId: string | null, publicIp: string | null } | null } };

export type DestroyBastionMutationVariables = Exact<{
  slug: string;
}>;


export type DestroyBastionMutation = { destroyBastion: { success: boolean, message: string | null, deploymentId: string | null } };

export type GetBastionCloudsQueryVariables = Exact<{ [key: string]: never; }>;


export type GetBastionCloudsQuery = { clouds: Array<{ id: string, name: string, provider: CloudProviderEnum }> };

export type GetBastionNetworksQueryVariables = Exact<{ [key: string]: never; }>;


export type GetBastionNetworksQuery = { networks: Array<{ id: string, name: string, slug: string, region: string, cloudAccountId: string, stackStatus: string | null }> };

export type GetCloudChoicesQueryVariables = Exact<{ [key: string]: never; }>;


export type GetCloudChoicesQuery = { clouds: Array<{ id: string, name: string, provider: CloudProviderEnum }> };

export type GetNetworkChoicesQueryVariables = Exact<{ [key: string]: never; }>;


export type GetNetworkChoicesQuery = { networks: Array<{ id: string, name: string, slug: string, region: string, cloudAccountId: string, stackStatus: string | null }> };

export type GetProjectChoicesQueryVariables = Exact<{ [key: string]: never; }>;


export type GetProjectChoicesQuery = { projects: Array<{ id: string, name: string, slug: string }> };

export type GetEnvironmentChoicesQueryVariables = Exact<{
  projectId?: string | null | undefined;
}>;


export type GetEnvironmentChoicesQuery = { environments: Array<{ id: string, name: string, projectId: string, isProduction: boolean }> };

export type GetSecretChoicesQueryVariables = Exact<{
  cloudAccountId?: string | null | undefined;
}>;


export type GetSecretChoicesQuery = { secrets: Array<{ id: string, name: string, description: string | null, cloudAccountId: string }> };

export type GetDomainChoicesQueryVariables = Exact<{ [key: string]: never; }>;


export type GetDomainChoicesQuery = { domains: Array<{ id: string, name: string }> };

export type GetCloudRegionChoicesQueryVariables = Exact<{
  provider?: string | null | undefined;
}>;


export type GetCloudRegionChoicesQuery = { cloudRegions: Array<{ code: string, name: string }> };

export type ResolveProjectQueryVariables = Exact<{
  input: ResolveProjectInput;
}>;


export type ResolveProjectQuery = { resolveProject: { ok: boolean, blueprintReference: string | null, errors: Array<{ code: string, message: string, path: string, suggestion: string | null }>, environments: Array<{ environment: string, config: Record<string, unknown>, resolvedYaml: string, provenance: Array<{ name: string, type: string, value: string, source: string }>, plan: { services: Array<{ name: string, type: string, deploymentType: string, source: string, cluster: string | null }>, routing: Array<{ domain: string, entryType: string, loadBalancer: string | null, paths: Array<{ path: string, service: string, deploymentType: string, routeHops: Array<string> }> }> } }> } };

export type SubmitManifestMutationVariables = Exact<{
  input: SubmitManifestInput;
}>;


export type SubmitManifestMutation = { submitManifest: { success: boolean, message: string | null } };

export type GetStepForUploadQueryVariables = Exact<{
  stepId: string;
}>;


export type GetStepForUploadQuery = { deploymentStep: { id: string, status: DeploymentStepStatus, cliInputs:
      | { __typename: 'ArtifactUploadCliInputs' }
      | { __typename: 'ContainerPushCliInputs' }
      | { __typename: 'LocalBuildCliInputs' }
      | { __typename: 'S3UploadCliInputs', uploadUrls: { store: Array<{ path: string, s3Key: string, url: string, contentType: string }> } | null }
     | null } | null };
