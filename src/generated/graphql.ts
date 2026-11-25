/** Internal type. DO NOT USE DIRECTLY. */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
/** Internal type. DO NOT USE DIRECTLY. */
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
export type ArtifactUploadCliOutputsInput = {
  bucketName: string;
  objectKey: string;
  success: boolean;
  /** Size of the uploaded zip in bytes */
  zipSize: number;
};

/** Fixed response an application load balancer sends when no route matches. */
export type AwsAlbDefaultActionInput = {
  /** e.g. text/html or application/json */
  contentType: string;
  /** Response body, up to 1024 characters */
  messageBody: string;
  /** HTTP status code, e.g. 200 or 503 */
  statusCode: string;
};

/** Burstable performance setting for T-series instances */
export type AwsBurstablePerformanceEnum =
  /** Burstable instance types are never launched. */
  | 'EXCLUDED'
  /** Burstable instance types may be launched. */
  | 'INCLUDED'
  /** Only burstable instance types are launched. */
  | 'REQUIRED';

/** Catalog filters that only apply to AWS */
export type AwsCacheCatalogFilterInput = {
  /** Only versions available in this deployment mode */
  deploymentMode?: AwsCacheDeploymentModeEnum | null | undefined;
};

/** Cache deployment mode */
export type AwsCacheDeploymentModeEnum =
  /** A cluster of nodes of a fixed size */
  | 'NODE_BASED'
  /** ElastiCache Serverless, which scales capacity on demand */
  | 'SERVERLESS';

/** Cache settings only AWS has */
export type AwsCacheSettingsInput = {
  /** Valkey and Redis only */
  clusterMode?: boolean | null | undefined;
  /** Daily backup time, HH:MM in UTC */
  dailySnapshotTime?: string | null | undefined;
  /** Required on create */
  deploymentMode?: AwsCacheDeploymentModeEnum | null | undefined;
  /** KMS key ARN for encryption at rest */
  kmsKeyId?: string | null | undefined;
  /** Serverless only, 1 to 5000 */
  maxDataStorageGb?: number | null | undefined;
  /** Serverless only, 1000 to 15000000 */
  maxEcpuPerSecond?: number | null | undefined;
  /** Node-based only */
  numCacheNodes?: number | null | undefined;
  /** Shards, cluster mode only */
  numNodeGroups?: number | null | undefined;
  /** Replicas per shard, cluster mode only */
  replicasPerNodeGroup?: number | null | undefined;
};

/** A capacity provider the ECS cluster runs tasks on. */
export type AwsCapacityProviderInput = {
  /** Managed instances only */
  instanceRequirements?: AwsInstanceRequirementsInput | null | undefined;
  /** Kind of capacity provider */
  type: AwsCapacityProviderTypeEnum;
};

/** Type of capacity provider */
export type AwsCapacityProviderTypeEnum =
  /** Serverless Fargate tasks at the on-demand price. */
  | 'FARGATE'
  /** Fargate tasks on spare capacity, cheaper but stopped when AWS reclaims it. */
  | 'FARGATE_SPOT'
  /** EC2 instances that ECS launches and manages. Needs a network. */
  | 'MANAGED_INSTANCES';

/** Certificate settings only AWS has */
export type AwsCertificateSettingsInput = {
  /** Regions to issue the certificate in. AWS issues one certificate per region. */
  regions: Array<string>;
};

/** Container orchestrator a cluster runs */
export type AwsClusterOrchestratorEnum =
  /** Amazon ECS. */
  | 'ECS';

/** Cluster settings for an AWS cloud account */
export type AwsClusterSettingsInput = {
  /** Where the cluster runs tasks */
  capacityProviders: Array<AwsCapacityProviderInput>;
  /** Container orchestrator to run */
  orchestrator: AwsClusterOrchestratorEnum;
};

/** Catalog filters that only apply to AWS */
export type AwsDatabaseCatalogFilterInput = {
  /** Only entries available in this deployment mode */
  deploymentMode?: AwsDatabaseDeploymentModeEnum | null | undefined;
  /** rds or aurora. Required when filtering by engine. */
  flavor?: string | null | undefined;
};

/** Database deployment mode */
export type AwsDatabaseDeploymentModeEnum =
  /** A server of a fixed instance class */
  | 'PROVISIONED'
  /** Aurora Serverless v2, which scales capacity between a minimum and a maximum */
  | 'SERVERLESS';

/** Settings only AWS servers have. Service, deployment mode, database name, encryption and master username are fixed at creation. */
export type AwsDatabaseSettingsInput = {
  /** Database RDS creates with the server */
  dbName?: string | null | undefined;
  /** Serverless is Aurora only. Required at creation. */
  deploymentMode?: AwsDatabaseDeploymentModeEnum | null | undefined;
  /** rds or aurora. Required at creation. */
  flavor?: string | null | undefined;
  /** Required for io1 and io2 storage */
  iops?: number | null | undefined;
  /** KMS key ARN for storage encryption */
  kmsKeyId?: string | null | undefined;
  /** Defaults to on. Changing this either way sets a new master password. */
  masterPasswordRotation?: boolean | null | undefined;
  /** Storage autoscaling ceiling in GB, RDS only */
  maxAllocatedStorage?: number | null | undefined;
  /** Serverless only, in steps of 0.5 */
  maxCapacity?: number | null | undefined;
  /** Serverless only, in steps of 0.5 */
  minCapacity?: number | null | undefined;
  /** Turn on Performance Insights for the server */
  performanceInsightsEnabled?: boolean | null | undefined;
  /** Serverless with a minimum capacity of 0 only, 300 to 86400 */
  secondsUntilAutoPause?: number | null | undefined;
  /** Encrypt storage at rest */
  storageEncrypted?: boolean | null | undefined;
  /** gp3, io1 or io2, RDS only */
  storageType?: string | null | undefined;
  /** Master username. Defaults to the slug. */
  username?: string | null | undefined;
};

/** EFS performance mode */
export type AwsEfsPerformanceModeEnum =
  /** Lowest latency per operation. The right choice for most workloads. */
  | 'GENERAL_PURPOSE'
  /** Higher total throughput for many clients, with more latency per operation */
  | 'MAX_IO';

/** EFS throughput mode */
export type AwsEfsThroughputModeEnum =
  /** Throughput grows with the amount of data stored, with burst credits */
  | 'BURSTING'
  /** Throughput scales with the workload, billed by use */
  | 'ELASTIC'
  /** A fixed throughput set by provisionedThroughputMibps */
  | 'PROVISIONED';

/** Settings only EFS filesystems have */
export type AwsFilesystemSettingsInput = {
  /** Default: true */
  encrypted?: boolean | null | undefined;
  /** KMS key ARN for encryption */
  kmsKeyId?: string | null | undefined;
  /** Default: generalPurpose */
  performanceMode?: AwsEfsPerformanceModeEnum | null | undefined;
  /** MiB/s, provisioned throughput only */
  provisionedThroughputMibps?: number | null | undefined;
  /** Default: elastic */
  throughputMode?: AwsEfsThroughputModeEnum | null | undefined;
};

/** Which EC2 instances a managed instances capacity provider may launch */
export type AwsInstanceRequirementsInput = {
  /** e.g. c5.* or m5.large */
  allowedInstanceTypes?: Array<string> | null | undefined;
  /** Whether burstable T-series instances may be launched */
  burstablePerformance?: AwsBurstablePerformanceEnum | null | undefined;
  /** arm64 or x86_64 */
  cpuArchitecture?: string | null | undefined;
  /** e.g. amazon-web-services, intel, amd */
  cpuManufacturers?: Array<string> | null | undefined;
  /** Memory per instance, in MiB */
  memoryMib?: IntRangeInput | null | undefined;
  /** vCPUs per instance */
  vcpuCount?: IntRangeInput | null | undefined;
};

/** Load balancer settings for an AWS cloud account */
export type AwsLoadBalancerSettingsInput = {
  /** Application load balancers only: response when no route matches */
  defaultAction?: AwsAlbDefaultActionInput | null | undefined;
  /** Application load balancers only: ACM certificate for HTTPS traffic */
  defaultSslCertificateArn?: string | null | undefined;
};

/** NAT gateways an AWS network gets: none, one, or one per availability zone */
export type AwsNatGatewayOptionEnum =
  /** No NAT gateway. Private subnets have no outbound internet access. */
  | 'NONE'
  /** One NAT gateway in each availability zone. */
  | 'PER_AZ'
  /** One NAT gateway shared by every private subnet. */
  | 'SINGLE';

/** Network settings only AWS has */
export type AwsNetworkSettingsInput = {
  /** Defaults to true */
  enableInternetAccess?: boolean | null | undefined;
  /** Defaults to SINGLE with internet access and NONE without */
  natGatewayOption?: AwsNatGatewayOptionEnum | null | undefined;
};

/** Status of a bastion host */
export type BastionStatusEnum =
  /** The bastion is running and takes connections. */
  | 'ACTIVE'
  /** The bastion is destroyed. */
  | 'DELETED'
  /** Destroying the bastion failed. */
  | 'DELETE_FAILED'
  /** The bastion is being destroyed. */
  | 'DELETING'
  /** Provisioning the bastion failed. */
  | 'FAILED'
  /** The bastion is waiting to be provisioned. */
  | 'PENDING'
  /** The bastion is being provisioned. */
  | 'PROVISIONING';

/** Cache engine type */
export type CacheEngineEnum =
  /** Memcached, a key-value cache with no persistence */
  | 'MEMCACHED'
  /** Redis OSS */
  | 'REDIS'
  /** Valkey, an open-source in-memory store that Redis clients can use */
  | 'VALKEY';

/** Status of a cache */
export type CacheStatusEnum =
  /** Ready for connections */
  | 'ACTIVE'
  /** The last change did not complete */
  | 'FAILED'
  /** Being created or changed */
  | 'PENDING';

/** Certificate status values */
export type CertificateStatusEnum =
  /** Issued and usable in every region. */
  | 'ACTIVE'
  /** Deleted. */
  | 'DELETED'
  /** Being deleted. */
  | 'DELETING'
  /** Past its expiry date. */
  | 'EXPIRED'
  /** Validation failed in every region. */
  | 'FAILED'
  /** Issued in some regions and failed in the others. */
  | 'PARTIAL'
  /** Requested and not yet issued in any region. */
  | 'PENDING'
  /** Waiting for its DNS validation records to resolve in at least one region. */
  | 'VALIDATING';

/** What a cleanup item is */
export type CleanupKindEnum =
  /** Routing that served hostnames before they moved to new routing, kept until public DNS points at the new one. */
  | 'PREVIOUS_ROUTING';

/** The status of CLI execution for a step */
export type CliStatus =
  /** A CLI claimed the step and is running it. */
  | 'CLAIMED'
  /** The CLI finished the step. */
  | 'COMPLETE'
  /** The CLI reported a failure. `cliError` says why. */
  | 'FAILED'
  /** No CLI has claimed the step yet. */
  | 'PENDING';

/** Results of a CLI task. Set exactly one field, matching the step's cliTask. */
export type CliTaskOutputsInput = {
  artifactUpload?: ArtifactUploadCliOutputsInput | null | undefined;
  containerPush?: ContainerPushCliOutputsInput | null | undefined;
  localBuild?: LocalBuildCliOutputsInput | null | undefined;
  objectUpload?: ObjectUploadCliOutputsInput | null | undefined;
};

/** Supported cloud providers */
export type CloudProviderEnum =
  /** Amazon Web Services. */
  | 'AWS'
  /** Microsoft Azure. */
  | 'AZURE'
  /** Cloudflare. */
  | 'CLOUDFLARE'
  /** DigitalOcean. */
  | 'DIGITALOCEAN'
  /** Google Cloud. */
  | 'GCP'
  /** Vultr. */
  | 'VULTR';

/** Status of a cluster */
export type ClusterStatusEnum =
  /** The cluster is ready to run services. */
  | 'ACTIVE'
  /** Provisioning the cluster failed. */
  | 'FAILED'
  /** The cluster is being provisioned. */
  | 'PENDING';

export type ContainerPushCliOutputsInput = {
  imageUri: string;
  localImageTag: string;
  success: boolean;
};

/** A new bastion to create in a network. */
export type CreateBastionInput = {
  /** CIDR blocks allowed to SSH to a public bastion. Leave empty to allow any address. */
  allowedCidrs?: Array<string> | null | undefined;
  /** Cloud account ID */
  cloudAccountId: string;
  /** User-friendly name */
  name: string;
  /** Network ID */
  networkId: string;
  /** Give the bastion a public address that takes SSH from allowedCidrs. Without it the bastion has no inbound access and is reached through startBastionSession. Fixed at create. */
  publicAccess?: boolean;
  /** URL-friendly identifier for CLI and API references */
  slug: string;
};

/** A new cache to create in a network */
export type CreateCacheInput = {
  /** Required when the cloud account is AWS */
  aws?: AwsCacheSettingsInput | null | undefined;
  /** Days of backups kept. Defaults to 0 (none). Memcached keeps none. */
  backupRetentionDays?: number | null | undefined;
  /** Cloud account ID */
  cloudAccountId: string;
  /** Cache engine */
  engine: CacheEngineEnum;
  /** Engine version, e.g. 8.0 */
  engineVersion?: string | null | undefined;
  /** User-friendly name */
  name: string;
  /** Network ID - required for all caches */
  networkId: string;
  /** Node size. Leave out for a serverless cache. */
  size?: string | null | undefined;
  /** URL-friendly identifier for CLI and API references */
  slug: string;
};

/** A certificate to request. */
export type CreateCertificateInput = {
  /** Other hostnames to cover. */
  additionalDomains?: Array<string> | null | undefined;
  /** Required when the cloud account is AWS */
  aws?: AwsCertificateSettingsInput | null | undefined;
  /** Cloud account to issue the certificate in. */
  cloudAccountId: string;
  /** Domain to tie the certificate to. */
  domainId?: string | null | undefined;
  /** Main hostname to cover. A wildcard such as `*.example.com` is allowed. */
  primaryDomain: string;
};

/** A new cluster to create. */
export type CreateClusterInput = {
  /** Required when the cloud account is AWS */
  aws?: AwsClusterSettingsInput | null | undefined;
  /** Cloud account ID */
  cloudAccountId: string;
  /** User-friendly name */
  name: string;
  /** Network ID - required for managed instances */
  networkId?: string | null | undefined;
  /** Cloud region to create the cluster in */
  region: string;
  /** URL-friendly identifier for CLI and API references */
  slug: string;
};

/** A new database server. Send the settings section for the cloud account it runs in. */
export type CreateDatabaseInput = {
  /** Settings for a server in an AWS cloud account */
  aws?: AwsDatabaseSettingsInput | null | undefined;
  /** Days of automatic backups. Defaults to 7. */
  backupRetentionDays?: number | null | undefined;
  /** Cloud account ID */
  cloudAccountId: string;
  /** Database engine */
  engine: DatabaseEngineEnum;
  /** Engine version, e.g. 16.4 */
  engineVersion?: string | null | undefined;
  /** Keep a standby copy in a second zone */
  highAvailability?: boolean | null | undefined;
  /** User-friendly name */
  name: string;
  /** Network ID - required for all databases */
  networkId: string;
  /** Reachable from outside the network */
  publiclyAccessible?: boolean | null | undefined;
  /** Machine size. Not used when the server scales on its own. */
  size?: string | null | undefined;
  /** URL-friendly identifier for CLI and API references */
  slug: string;
  /** Storage in GB */
  storageGb?: number | null | undefined;
};

/** A root domain to register with the team. */
export type CreateDomainInput = {
  /** Root domain FQDN (e.g., example.com) */
  name: string;
};

/** An environment to add to a project. */
export type CreateEnvironmentInput = {
  /** Cloud account the environment deploys into. */
  cloudAccountId: string;
  /** Colour shown for the environment in the console. */
  color?: string | null | undefined;
  /** Whether this is a production environment. */
  isProduction?: boolean;
  /** Display name. */
  name: string;
  /** Network the environment deploys into. */
  networkId?: string | null | undefined;
  /** Project to add the environment to. */
  projectId: string;
  /** Cloud region the environment deploys into, such as `us-east-1`. */
  region: string;
  /** Slug that names the environment under `environments` in `gantry.yml`. */
  slug: string;
};

/** A new shared filesystem to create in a network */
export type CreateFilesystemInput = {
  /** Required when the cloud account is AWS */
  aws?: AwsFilesystemSettingsInput | null | undefined;
  /** Cloud account ID */
  cloudAccountId: string;
  /** User-friendly name */
  name: string;
  /** Network ID. The filesystem takes the network's region. */
  networkId: string;
  /** URL-friendly identifier for CLI and API references */
  slug: string;
};

/** A new load balancer to create. */
export type CreateLoadBalancerInput = {
  /** Only for an AWS cloud account */
  aws?: AwsLoadBalancerSettingsInput | null | undefined;
  /** Cloud account ID */
  cloudAccountId: string;
  /** User-friendly name */
  name: string;
  /** Network ID. Required for application load balancers. */
  networkId?: string | null | undefined;
  /** Required for regional types without a network. A load balancer in a network takes the network's region. */
  region?: string | null | undefined;
  /** URL-friendly identifier for CLI and API references */
  slug: string;
  /** Load balancer type */
  type: LoadBalancerTypeEnum;
};

/** A new network to create. */
export type CreateNetworkInput = {
  /** Only for an AWS cloud account */
  aws?: AwsNetworkSettingsInput | null | undefined;
  /** Address range, e.g. 10.0.0.0/16 */
  cidr: string;
  /** Cloud account ID */
  cloudAccountId: string;
  /** When true, databases and caches get no network-wide ingress. Defaults to false. */
  leastPrivilegeMode?: boolean | null | undefined;
  /** User-friendly name */
  name: string;
  /** Cloud region to create the network in */
  region: string;
  /** URL-friendly identifier for CLI and API references */
  slug: string;
  /** Subnets to create in the network */
  subnets: Array<NetworkSubnetInput>;
};

/** A project to create. */
export type CreateProjectInput = {
  /** Cloud the project deploys to. */
  cloudProvider: CloudProviderEnum;
  /** Display name. The slug is made from it. */
  name: string;
  /** Free-text label for grouping projects. */
  tag?: string | null | undefined;
};

/** A new secret to store in a cloud account */
export type CreateSecretInput = {
  /** Cloud account to store the secret in */
  cloudAccountId: string;
  /** What the secret is for */
  description?: string | null | undefined;
  /** Keys and values to store */
  keyValuePairs: Array<SecretKeyValueInput>;
  /** Name, unique in the cloud account */
  name: string;
};

/** The environment whose staged version takes all traffic. */
export type CutoverInput = {
  /** Also complete the release, dropping the previous version */
  complete?: boolean | null | undefined;
  /** Environment slug (e.g. "production") */
  environment: string;
  /** Project ID */
  projectId: string;
};

/** Database engine type */
export type DatabaseEngineEnum =
  /** MariaDB */
  | 'MARIADB'
  /** MySQL */
  | 'MYSQL'
  /** PostgreSQL */
  | 'POSTGRESQL';

/** Status of a database */
export type DatabaseStatusEnum =
  /** Ready for connections */
  | 'ACTIVE'
  /** The last change did not complete */
  | 'FAILED'
  /** Being created or changed */
  | 'PENDING';

/** IN_PLACE sets a new password on the same user. STAGED (Advanced Deployments) creates the user in the other slot, which the next deploy switches to */
export type DatabaseUserRotationMode =
  /** Set a new password on the same user now. Running instances fail to connect until they restart. */
  | 'IN_PLACE'
  /** Create the user in the other slot. The next deploy switches to it while the current user keeps working. */
  | 'STAGED';

/** Options that change how a deploy runs. */
export type DeploymentOptionsInput = {
  /** Delete stale files after upload */
  deleteStale?: boolean | null | undefined;
  /** Force re-upload all files */
  force?: boolean | null | undefined;
  /** Go live without running the post-deploy commands. The deployment records the skip. */
  skipPostDeploy?: boolean | null | undefined;
  /** Deploy without running the services' pre-deploy commands. The deployment records the skip. */
  skipPreDeploy?: boolean | null | undefined;
};

/** The phase of a deployment step */
export type DeploymentPhase =
  /** Builds the code and container images, run by the CLI. */
  | 'BUILDING'
  /** Provisions and updates the compute for the version. */
  | 'DEPLOYING'
  /** Points routing and DNS at the version. */
  | 'GO_LIVE'
  /** Runs post-deploy commands and finishes the deployment. */
  | 'POST_DEPLOY'
  /** Creates what the version needs before it deploys, such as queues. */
  | 'SETUP'
  /** Uploads artifacts, images and static files, run by the CLI. */
  | 'UPLOADING';

/** The status of a deployment */
export type DeploymentStatus =
  /** Waiting on something outside the deployment, such as a certificate that has not validated yet. It resumes on its own. */
  | 'BLOCKED'
  /** Cancelled before it finished. */
  | 'CANCELLED'
  /** A cancel was requested and open steps are being stopped. */
  | 'CANCELLING'
  /** Every step finished. */
  | 'COMPLETE'
  /** A step failed. `lastMessage` says what failed. */
  | 'FAILED'
  /** The steps are planned and the first ones are starting. */
  | 'INITIALIZING'
  /** Queued and not picked up yet. */
  | 'PENDING'
  /** Gantry is working out the steps the deployment needs. */
  | 'PLANNING'
  /** Steps are running. */
  | 'RUNNING'
  /** Ended with nothing to do, for example because a newer deployment replaced it. */
  | 'SKIPPED';

/** The status of a deployment step */
export type DeploymentStepStatus =
  /** Waiting for the CLI to claim and run the step. */
  | 'AWAITING_CLI'
  /** Stopped because the deployment was cancelled. */
  | 'CANCELLED'
  /** Finished. */
  | 'COMPLETE'
  /** Failed. `error` or `cliError` says why. */
  | 'FAILED'
  /** Waiting for the CLI to send the list of files it will upload. */
  | 'MANIFEST_REQUIRED'
  /** Waiting for the steps it depends on. */
  | 'PENDING'
  /** Gantry is running the step. */
  | 'PROCESSING'
  /** Ready and queued for Gantry to run. */
  | 'QUEUED';

/** One env var to store */
export type EnvVarInput = {
  /** Variable name */
  key: string;
  /** Variable value */
  value: string;
};

/** Where a stored env var applies. Narrower scopes win over broader ones. */
export type EnvVarScopeEnum =
  /** Every service deployed to one cloud account */
  | 'CLOUD_ACCOUNT'
  /** One project environment, or one service there when `service` is set */
  | 'ENVIRONMENT'
  /** Every service deployed to one network */
  | 'NETWORK'
  /** Every service in one project */
  | 'PROJECT'
  /** Every service the team deploys */
  | 'TEAM';

/** Where a value in a service env came from, lowest precedence first. */
export type EnvVarSourceEnum =
  /** Injected by a database, cache, bucket or filesystem binding */
  | 'BINDING'
  /** Stored at the cloud account scope */
  | 'CLOUD_ACCOUNT'
  /** Stored at the environment scope */
  | 'ENVIRONMENT'
  /** The environment's `env` for the service in gantry.yml */
  | 'ENVIRONMENT_YAML'
  /** Stored at the network scope */
  | 'NETWORK'
  /** Copied from a preview's parent environment, by the template's inherit_env */
  | 'PARENT_ENVIRONMENT'
  /** Stored at the project scope */
  | 'PROJECT'
  /** The service's `secrets` in gantry.yml */
  | 'SECRET'
  /** Stored for this service only in the environment */
  | 'SERVICE_OVERRIDE'
  /** The service's `env` in gantry.yml */
  | 'SERVICE_YAML'
  /** Stored at the team scope */
  | 'TEAM';

/** The scope a stored env var operation applies to */
export type EnvVarTargetInput = {
  /** Required for CLOUD_ACCOUNT */
  cloudAccountId?: string | null | undefined;
  /** Required for ENVIRONMENT */
  environmentSlug?: string | null | undefined;
  /** Required for NETWORK */
  networkId?: string | null | undefined;
  /** Required for PROJECT and ENVIRONMENT */
  projectId?: string | null | undefined;
  /** Where the variables apply */
  scope: EnvVarScopeEnum;
  /** ENVIRONMENT only: a service name, for an override that applies to that service only */
  service?: string | null | undefined;
};

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
  /** Ready to mount */
  | 'ACTIVE'
  /** The last change did not complete */
  | 'FAILED'
  /** Being created or changed */
  | 'PENDING';

/** An inclusive range of whole numbers. */
export type IntRangeInput = {
  /** Highest allowed value. Omit for no limit. */
  max?: number | null | undefined;
  /** Lowest allowed value */
  min: number;
};

/** Set exactly one source: from or buildNumber. */
export type LiftBuildInput = {
  /** Project build number to lift */
  buildNumber?: number | null | undefined;
  /** Environment slug (e.g. "production") */
  environment: string;
  /** Environment slug whose live build is lifted */
  from?: string | null | undefined;
  /** Project ID */
  projectId: string;
};

/** A preview to create, or to redeploy when it exists. */
export type LiftPreviewEnvironmentInput = {
  /** The preview's name. An existing preview with this name is redeployed. Without one, a new preview is created and named by its id. */
  name?: string | null | undefined;
  /** Project id. Must match the `id` in the YAML. */
  projectId: string;
  /** Services to deploy, in place of the template's `services` for this lift. */
  services?: Array<string> | null | undefined;
  /** Branch and commit to record on the preview. */
  sourceRef?: PreviewSourceRefInput | null | undefined;
  /** Template name from `previews:`. */
  template: string;
  /** Variable values that win over every other source. */
  variables?: Array<VariableOverrideInput> | null | undefined;
  /** The `gantry.yml` content. */
  yaml: string;
};

/** Status of a load balancer */
export type LoadBalancerStatusEnum =
  /** The load balancer is ready to take routes. */
  | 'ACTIVE'
  /** Provisioning the load balancer failed. */
  | 'FAILED'
  /** The load balancer is being provisioned. */
  | 'PENDING';

/** Type of load balancer */
export type LoadBalancerTypeEnum =
  /** A regional HTTP and HTTPS load balancer inside a network. */
  | 'APPLICATION'
  /** An HTTP and HTTPS load balancer with no region. */
  | 'GLOBAL';

export type LocalBuildCliOutputsInput = {
  buildCommands?: string | null | undefined;
  localImageTag?: string | null | undefined;
  serviceName: string;
  success: boolean;
};

/** A subnet to create in the network. */
export type NetworkSubnetInput = {
  /** Address range inside the network's range, e.g. 10.0.1.0/24 */
  cidr: string;
  /** Subnet name, unique in the network */
  name: string;
  /** Public or private */
  type: SubnetTypeEnum;
  /** Availability zone */
  zone?: string | null | undefined;
};

export type ObjectUploadCliOutputsInput = {
  success: boolean;
  /** Total bytes uploaded */
  totalSize: number;
  uploadedFiles: number;
};

/** Where a deploy's post-deploy commands are. Queued and started mean the version is live. */
export type PostDeployState =
  /** The version is live and the commands are about to start. */
  | 'QUEUED'
  /** The deploy asked to skip the post-deploy commands. */
  | 'SKIPPED'
  /** The commands are running. */
  | 'STARTED';

/** Where the preview was lifted from, read from local git. */
export type PreviewSourceRefInput = {
  /** Branch checked out when the preview was lifted. */
  branch?: string | null | undefined;
  /** Commit checked out when the preview was lifted. */
  commit?: string | null | undefined;
};

/** The environment a release operation acts on. */
export type ReleaseEnvironmentInput = {
  /** Environment slug (e.g. "production") */
  environment: string;
  /** Project ID */
  projectId: string;
};

/** A version's part in the environment's release */
export type ReleaseRole =
  /** The new version, taking part of the traffic. */
  | 'CANARY'
  /** The version taking the stable traffic. */
  | 'LIVE'
  /** The version a cutover replaced, kept so an abort can put it back. */
  | 'PREVIOUS'
  /** The new version, running with no traffic. */
  | 'STAGED';

/** Where the release in progress stands: staged at 0%, split across both versions, cut over with the previous version kept, or none. */
export type ReleaseState =
  /** The new version takes all traffic, and the previous one is kept until the release completes. */
  | 'CUT_OVER'
  /** No release is in progress. One version takes all traffic. */
  | 'NONE'
  /** The new version takes part of the traffic. */
  | 'SPLIT'
  /** The new version runs beside the live one with no traffic. */
  | 'STAGED';

/** A `gantry.yml` to resolve against a project. */
export type ResolveProjectInput = {
  /** Environment slug to resolve. Without it, every environment in the YAML. */
  environment?: string | null | undefined;
  /** Project id. Must match the `id` in the YAML. */
  projectId: string;
  /** Variable values that win over every other source. */
  variables?: Array<VariableOverrideInput> | null | undefined;
  /** The `gantry.yml` content. */
  yaml: string;
};

/** The environment to roll back, and optionally the version to make live. */
export type RollbackInput = {
  /** Environment slug (e.g. "production") */
  environment: string;
  /** Project ID */
  projectId: string;
  /** Version to make live. Defaults to the latest earlier version with an older build than the environment's current one. */
  versionId?: string | null | undefined;
};

/** One key and its value */
export type SecretKeyValueInput = {
  /** Key name. Must not be empty. */
  key: string;
  /** Value stored under the key */
  value: string;
};

/** Env vars to store at a scope */
export type SetEnvVarsInput = {
  /** Required for CLOUD_ACCOUNT */
  cloudAccountId?: string | null | undefined;
  /** Required for ENVIRONMENT */
  environmentSlug?: string | null | undefined;
  /** Required for NETWORK */
  networkId?: string | null | undefined;
  /** Required for PROJECT and ENVIRONMENT */
  projectId?: string | null | undefined;
  /** Where the variables apply */
  scope: EnvVarScopeEnum;
  /** ENVIRONMENT only: a service name, for an override that applies to that service only */
  service?: string | null | undefined;
  /** Variables to store */
  variables: Array<EnvVarInput>;
};

/** How much traffic the new version of a canary release takes. */
export type ShiftTrafficInput = {
  /** Also complete the release, dropping the previous version. Only at 100. */
  complete?: boolean | null | undefined;
  /** Environment slug (e.g. "production") */
  environment: string;
  /** Share of traffic, 0 to 100, the new version takes */
  percent: number;
  /** Project ID */
  projectId: string;
};

/** The environment to tear down, with the token and phrase that confirm it. */
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
  /** The CLI runs the step on the machine that started the deploy. */
  | 'CLI'
  /** Gantry runs the step in the cloud. */
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

/** Whether a subnet is reachable from the internet */
export type SubnetTypeEnum =
  /** No inbound route from the internet. */
  | 'PRIVATE'
  /** Has a route to and from the internet. */
  | 'PUBLIC';

/** The preview to tear down. */
export type TeardownPreviewEnvironmentInput = {
  /** The preview's name: its `--as` name, or its id. */
  name: string;
  /** Project id. */
  projectId: string;
  /** Template name from `previews:`. */
  template: string;
};

/** What a teardown does to routing the environment uses. */
export type TeardownRoutingChangeEnum =
  /** Nothing else routes through it. A CDN is removed with its DNS records; a load balancer drops its rules for the environment. */
  | 'REMOVED'
  /** Other environments still route through it, and keep their routes. */
  | 'UPDATED';

/** What serves the routing a teardown changes. */
export type TeardownRoutingEdgeEnum =
  /** A CDN, identified by its hostnames. */
  | 'CDN'
  /** A hostname served directly by its service. */
  | 'DIRECT'
  /** A gateway, identified by its hostnames. */
  | 'GATEWAY'
  /** A load balancer, identified by its name. */
  | 'LOAD_BALANCER';

/** Env vars to remove from a scope */
export type UnsetEnvVarsInput = {
  /** Required for CLOUD_ACCOUNT */
  cloudAccountId?: string | null | undefined;
  /** Required for ENVIRONMENT */
  environmentSlug?: string | null | undefined;
  /** Names of the variables to remove */
  keys: Array<string>;
  /** Required for NETWORK */
  networkId?: string | null | undefined;
  /** Required for PROJECT and ENVIRONMENT */
  projectId?: string | null | undefined;
  /** Where the variables apply */
  scope: EnvVarScopeEnum;
  /** ENVIRONMENT only: a service name, for an override that applies to that service only */
  service?: string | null | undefined;
};

/** Settings to change on a database server. Leave a field out to keep it. A change that reaches the server applies right away; a size change restarts it briefly. */
export type UpdateDatabaseInput = {
  /** Settings for a server in an AWS cloud account */
  aws?: AwsDatabaseSettingsInput | null | undefined;
  /** Days of automatic backups. 0 turns backups off and deletes existing ones. */
  backupRetentionDays?: number | null | undefined;
  /** Keep a standby copy in a second zone */
  highAvailability?: boolean | null | undefined;
  /** User-friendly name */
  name?: string | null | undefined;
  /** Provisioned servers only. Restarts the server. */
  size?: string | null | undefined;
  /** Storage in GB. It can only grow. */
  storageGb?: number | null | undefined;
};

/** Changes to a secret. Fields left out stay as they are. */
export type UpdateSecretInput = {
  /** New description */
  description?: string | null | undefined;
  /** Secret ID */
  id: string;
  /** Every key and value the secret should hold. Replaces the current set. */
  keyValuePairs?: Array<SecretKeyValueInput> | null | undefined;
  /** New name, unique in the cloud account */
  name?: string | null | undefined;
};

/** A variable value given for this resolution only. */
export type VariableOverrideInput = {
  /** Variable name. */
  name: string;
  /** Value as a string. It is converted to the variable's declared type. */
  value: string;
};

export type GetCachesQueryVariables = Exact<{ [key: string]: never; }>;


export type GetCachesQuery = { caches: Array<{ id: string, name: string, slug: string, engine: CacheEngineEnum, status: CacheStatusEnum, cloudAccountId: string, networkId: string, endpoint: string | null, port: number | null, createdAt: string }> };

export type GetCacheTypesQueryVariables = Exact<{
  provider: CloudProviderEnum;
}>;


export type GetCacheTypesQuery = { cacheTypes: Array<{ type: CacheEngineEnum, displayName: string, provider: string, description: string, guidance: string, supportsServerless: boolean, supportsClusterMode: boolean, requiresNetwork: boolean }> };

export type GetCacheEngineVersionsQueryVariables = Exact<{
  provider: CloudProviderEnum;
  engine?: CacheEngineEnum | null | undefined;
  region?: string | null | undefined;
  aws?: AwsCacheCatalogFilterInput | null | undefined;
}>;


export type GetCacheEngineVersionsQuery = { cacheEngineVersions: Array<{ engine: CacheEngineEnum, version: string, providerData: Record<string, unknown> }> };

export type GetCacheSizesQueryVariables = Exact<{
  provider: CloudProviderEnum;
  engine?: CacheEngineEnum | null | undefined;
  region?: string | null | undefined;
}>;


export type GetCacheSizesQuery = { cacheSizes: Array<{ size: string, family: string, memoryGiB: number, vcpu: number }> };

export type CreateCacheMutationVariables = Exact<{
  input: CreateCacheInput;
}>;


export type CreateCacheMutation = { createCache: { success: boolean, message: string | null, deploymentId: string | null, cache: { id: string, name: string, slug: string, engine: CacheEngineEnum, status: CacheStatusEnum } | null } };

export type GetCleanupItemsQueryVariables = Exact<{ [key: string]: never; }>;


export type GetCleanupItemsQuery = { cleanupItems: Array<{ id: string, kind: CleanupKindEnum, description: string, readyToRemove: boolean, hostnames: Array<{ hostname: string, dnsMoved: boolean, dnsTarget: string | null }> }> };

export type CleanUpMutationVariables = Exact<{
  ids: Array<string | number> | string | number;
}>;


export type CleanUpMutation = { cleanUp: { success: boolean, message: string | null, removed: Array<string> } };

export type GetCloudsQueryVariables = Exact<{ [key: string]: never; }>;


export type GetCloudsQuery = { clouds: Array<{ id: string, name: string, provider: CloudProviderEnum, createdAt: string }> };

export type GetClustersQueryVariables = Exact<{ [key: string]: never; }>;


export type GetClustersQuery = { clusters: Array<{ id: string, name: string, slug: string, provider: string, status: ClusterStatusEnum, region: string, cloudAccountId: string, createdAt: string }> };

export type GetClusterTypesQueryVariables = Exact<{
  provider: CloudProviderEnum;
}>;


export type GetClusterTypesQuery = { clusterTypes: Array<{ type: string, displayName: string, provider: string, description: string, guidance: string | null }> };

export type CreateClusterMutationVariables = Exact<{
  input: CreateClusterInput;
}>;


export type CreateClusterMutation = { createCluster: { success: boolean, message: string | null, deploymentId: string | null, cluster: { id: string, name: string, slug: string, provider: string, status: ClusterStatusEnum, region: string } | null } };

export type DatabaseLogsQueryVariables = Exact<{
  id: string;
  since?: string | null | undefined;
  limit?: number | null | undefined;
  grep?: string | null | undefined;
  cursor?: string | null | undefined;
}>;


export type DatabaseLogsQuery = { databaseLogs: { cursor: string, lines: Array<{ timestamp: string, message: string }> } };

export type GetDatabasesQueryVariables = Exact<{ [key: string]: never; }>;


export type GetDatabasesQuery = { databases: Array<{ id: string, name: string, slug: string, engine: DatabaseEngineEnum, status: DatabaseStatusEnum, cloudAccountId: string, networkId: string, provider: string, endpoint: string | null, port: number | null, publiclyAccessible: boolean, createdAt: string }> };

export type GetDatabaseCredentialsQueryVariables = Exact<{
  id: string;
}>;


export type GetDatabaseCredentialsQuery = { databaseCredentials: { success: boolean, message: string | null, username: string | null, password: string | null } };

export type GetDatabaseTypesQueryVariables = Exact<{
  provider: CloudProviderEnum;
}>;


export type GetDatabaseTypesQuery = { databaseTypes: Array<{ engine: DatabaseEngineEnum, displayName: string, provider: string, description: string, guidance: string, supportsServerless: boolean, requiresNetwork: boolean, providerData: Record<string, unknown> }> };

export type GetDatabaseEngineVersionsQueryVariables = Exact<{
  provider: CloudProviderEnum;
  engine?: DatabaseEngineEnum | null | undefined;
  region?: string | null | undefined;
  aws?: AwsDatabaseCatalogFilterInput | null | undefined;
}>;


export type GetDatabaseEngineVersionsQuery = { databaseEngineVersions: Array<{ engine: DatabaseEngineEnum, version: string, description: string, providerData: Record<string, unknown> }> };

export type GetDatabaseSizesQueryVariables = Exact<{
  provider: CloudProviderEnum;
  engine?: DatabaseEngineEnum | null | undefined;
  region?: string | null | undefined;
  aws?: AwsDatabaseCatalogFilterInput | null | undefined;
}>;


export type GetDatabaseSizesQuery = { databaseSizes: Array<{ size: string, family: string, vcpu: number, memoryMb: number }> };

export type CreateDatabaseMutationVariables = Exact<{
  input: CreateDatabaseInput;
}>;


export type CreateDatabaseMutation = { createDatabase: { success: boolean, message: string | null, deploymentId: string | null, database: { id: string, name: string, slug: string, engine: DatabaseEngineEnum, status: DatabaseStatusEnum } | null } };

export type GetDatabaseServiceUsersQueryVariables = Exact<{
  id: string;
}>;


export type GetDatabaseServiceUsersQuery = { databaseServiceUsers: Array<{ id: string, databaseName: string, username: string, auth: string, access: string, status: string, serviceName: string, environmentSlug: string }> };

export type AdoptDatabaseMutationVariables = Exact<{
  id: string;
  database: string;
}>;


export type AdoptDatabaseMutation = { adoptDatabase: { success: boolean, message: string | null, deploymentId: string | null } };

export type RotateDatabaseServiceUserMutationVariables = Exact<{
  id: string;
  serviceUserId: string;
  mode?: DatabaseUserRotationMode | null | undefined;
}>;


export type RotateDatabaseServiceUserMutation = { rotateDatabaseServiceUser: { success: boolean, message: string | null, deploymentId: string | null } };

export type UpdateDatabaseMutationVariables = Exact<{
  id: string;
  input: UpdateDatabaseInput;
}>;


export type UpdateDatabaseMutation = { updateDatabase: { success: boolean, message: string | null, deploymentId: string | null } };

export type GetDatabaseOperationQueryVariables = Exact<{
  id: string;
}>;


export type GetDatabaseOperationQuery = { deployment: { status: DeploymentStatus, lastMessage: string | null } | null };

export type ReleaseStatusQueryVariables = Exact<{
  projectId: string;
  environment: string;
}>;


export type ReleaseStatusQuery = { releaseStatus: { strategy: string, state: ReleaseState, since: string, holdExpiresAt: string | null, versions: Array<{ versionId: string, number: number | null, role: ReleaseRole, weight: number, createdAt: string }> } | null };

export type CutoverMutationVariables = Exact<{
  input: CutoverInput;
}>;


export type CutoverMutation = { cutover: { success: boolean, message: string | null, deploymentId: string | null } };

export type ShiftTrafficMutationVariables = Exact<{
  input: ShiftTrafficInput;
}>;


export type ShiftTrafficMutation = { shiftTraffic: { success: boolean, message: string | null, deploymentId: string | null } };

export type AbortReleaseMutationVariables = Exact<{
  input: ReleaseEnvironmentInput;
}>;


export type AbortReleaseMutation = { abortRelease: { success: boolean, message: string | null, deploymentId: string | null } };

export type CompleteReleaseMutationVariables = Exact<{
  input: ReleaseEnvironmentInput;
}>;


export type CompleteReleaseMutation = { completeRelease: { success: boolean, message: string | null, deploymentId: string | null } };

export type RollbackMutationVariables = Exact<{
  input: RollbackInput;
}>;


export type RollbackMutation = { rollback: { success: boolean, message: string | null, deploymentId: string | null } };

export type ReapplyRoutingMutationVariables = Exact<{
  input: ReleaseEnvironmentInput;
}>;


export type ReapplyRoutingMutation = { reapplyRouting: { success: boolean, message: string | null, deploymentId: string | null } };

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


export type GetDeploymentVersionsQuery = { versionsByProject: Array<{ id: string, number: number | null, gitRef: string | null, createdAt: string }> };

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

export type EnvVarsQueryVariables = Exact<{
  input: EnvVarTargetInput;
}>;


export type EnvVarsQuery = { envVars: Array<{ key: string, value: string, updatedAt: string }> };

export type SetEnvVarsMutationVariables = Exact<{
  input: SetEnvVarsInput;
}>;


export type SetEnvVarsMutation = { setEnvVars: { success: boolean, message: string | null, created: Array<string>, updated: Array<string>, removed: Array<string> } };

export type ReplaceEnvVarsMutationVariables = Exact<{
  input: SetEnvVarsInput;
}>;


export type ReplaceEnvVarsMutation = { replaceEnvVars: { success: boolean, message: string | null, created: Array<string>, updated: Array<string>, removed: Array<string> } };

export type UnsetEnvVarsMutationVariables = Exact<{
  input: UnsetEnvVarsInput;
}>;


export type UnsetEnvVarsMutation = { unsetEnvVars: { success: boolean, message: string | null, created: Array<string>, updated: Array<string>, removed: Array<string> } };

export type ResolvedServiceEnvQueryVariables = Exact<{
  projectId: string;
  environmentSlug: string;
  service: string;
}>;


export type ResolvedServiceEnvQuery = { resolvedServiceEnv: { versionNumber: number | null, variables: Array<{ key: string, value: string, source: EnvVarSourceEnum, overrides: Array<EnvVarSourceEnum> }> } };

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


export type GetFilesystemsQuery = { filesystems: Array<{ id: string, name: string, slug: string, provider: string, region: string, status: FilesystemStatusEnum, cloudAccountId: string, networkId: string, createdAt: string }> };

export type GetFilesystemNetworksQueryVariables = Exact<{ [key: string]: never; }>;


export type GetFilesystemNetworksQuery = { networks: Array<{ id: string, name: string, region: string, provider: string, cloudAccountId: string }> };

export type CreateFilesystemMutationVariables = Exact<{
  input: CreateFilesystemInput;
}>;


export type CreateFilesystemMutation = { createFilesystem: { success: boolean, message: string | null, filesystem: { id: string, name: string, slug: string, provider: string, status: FilesystemStatusEnum } | null } };

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

export type GetLoadBalancersQueryVariables = Exact<{ [key: string]: never; }>;


export type GetLoadBalancersQuery = { loadBalancers: Array<{ id: string, name: string, slug: string, type: LoadBalancerTypeEnum, region: string | null, endpoint: string | null, status: LoadBalancerStatusEnum, cloudAccountId: string, createdAt: string }> };

export type GetLoadBalancerTypesQueryVariables = Exact<{
  provider: CloudProviderEnum;
}>;


export type GetLoadBalancerTypesQuery = { loadBalancerTypes: Array<{ type: LoadBalancerTypeEnum, displayName: string, provider: string, description: string, guidance: string, requiresNetwork: boolean, requiresRegion: boolean }> };

export type CreateLoadBalancerMutationVariables = Exact<{
  input: CreateLoadBalancerInput;
}>;


export type CreateLoadBalancerMutation = { createLoadBalancer: { success: boolean, message: string | null, deploymentId: string | null, loadBalancer: { id: string, name: string, slug: string, type: LoadBalancerTypeEnum, status: LoadBalancerStatusEnum } | null } };

export type VerifyLoginQueryVariables = Exact<{ [key: string]: never; }>;


export type VerifyLoginQuery = { whoami: { teamIds: Array<string>, kind: string, tokenName: string, authenticated: boolean } };

export type ServiceLogsQueryVariables = Exact<{
  projectId: string;
  environmentSlug: string;
  service: string;
  function?: string | null | undefined;
  since?: string | null | undefined;
  limit?: number | null | undefined;
  grep?: string | null | undefined;
  cursor?: string | null | undefined;
}>;


export type ServiceLogsQuery = { serviceLogs: { cursor: string, lines: Array<{ timestamp: string, message: string }> } };

export type GetNetworksQueryVariables = Exact<{ [key: string]: never; }>;


export type GetNetworksQuery = { networks: Array<{ id: string, name: string, slug: string, region: string, cloudAccountId: string, stackStatus: string | null, createdAt: string }> };

export type CreateNetworkMutationVariables = Exact<{
  input: CreateNetworkInput;
}>;


export type CreateNetworkMutation = { createNetwork: { success: boolean, message: string | null, deploymentId: string | null, network: { id: string, name: string, slug: string, region: string } | null } };

export type LiftPreviewEnvironmentMutationVariables = Exact<{
  input: LiftPreviewEnvironmentInput;
}>;


export type LiftPreviewEnvironmentMutation = { liftPreviewEnvironment: { ok: boolean, created: boolean | null, errors: Array<{ code: string, message: string, path: string, suggestion: string | null }>, preview: { id: string, slug: string, template: string, name: string, parentEnvironment: string, services: Array<string>, databases: string | null, urls: Array<string>, createdAt: string } | null, resolved: { environment: string, config: Record<string, unknown>, plan: { builds: Array<{ name: string, architecture: string }> } } | null } };

export type PreviewEnvironmentsQueryVariables = Exact<{
  projectId: string;
  template?: string | null | undefined;
}>;


export type PreviewEnvironmentsQuery = { previewEnvironments: Array<{ id: string, slug: string, template: string, name: string, parentEnvironment: string, services: Array<string>, databases: string | null, urls: Array<string>, createdAt: string }> };

export type TeardownPreviewEnvironmentMutationVariables = Exact<{
  input: TeardownPreviewEnvironmentInput;
}>;


export type TeardownPreviewEnvironmentMutation = { teardownPreviewEnvironment: { success: boolean, message: string, teardownId: string | null } };

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

export type StartCommandRunMutationVariables = Exact<{
  projectId: string;
  environmentSlug: string;
  service: string;
  command: Array<string> | string;
  function?: string | null | undefined;
}>;


export type StartCommandRunMutation = { startCommandRun: { success: boolean, message: string | null, runId: string | null, aws: { region: string, functionName: string, qualifier: string, payload: string, credentials: { accessKeyId: string, secretAccessKey: string, sessionToken: string } } | null } };

export type CommandRunQueryVariables = Exact<{
  projectId: string;
  environmentSlug: string;
  service: string;
  runId: string;
  outputCursor?: string | null | undefined;
}>;


export type CommandRunQuery = { commandRun: { state: string, exitCode: number | null, output: string, outputCursor: string | null, message: string | null } };

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

export type StartShellSessionMutationVariables = Exact<{
  projectId: string;
  environmentSlug: string;
  service: string;
  instance?: string | null | undefined;
  command?: string | null | undefined;
}>;


export type StartShellSessionMutation = { startShellSession: { success: boolean, message: string | null, instanceId: string | null, aws: { region: string, sessionId: string, streamUrl: string, tokenValue: string, target: string } | null } };

export type TeardownPreviewQueryVariables = Exact<{
  projectId: string;
  environmentSlug: string;
}>;


export type TeardownPreviewQuery = { teardownPreview: { environmentId: string, environmentName: string, totalResources: number, teardownToken: string, expiresAt: string, resources: Array<{ id: string, resourceType: string, resourceId: string | null, status: string }>, routing: Array<{ edge: TeardownRoutingEdgeEnum, name: string, otherEnvironments: number, change: TeardownRoutingChangeEnum }> } };

export type StartTeardownMutationVariables = Exact<{
  input: StartTeardownInput;
}>;


export type StartTeardownMutation = { startTeardown: { success: boolean, message: string | null, teardownId: string | null } };

export type GetVersionsQueryVariables = Exact<{
  projectId: string;
  environmentId: string;
}>;


export type GetVersionsQuery = { versionsByProject: Array<{ id: string, number: number | null, gitRef: string | null, createdAt: string }> };

export type WhoAmIQueryVariables = Exact<{ [key: string]: never; }>;


export type WhoAmIQuery = { whoami: { teamId: string | null, teamIds: Array<string>, kind: string, tokenName: string, authenticated: boolean, isAdmin: boolean, access: Array<{ resource: string, level: string }> } };

export type GetBastionsQueryVariables = Exact<{
  networkId?: string | null | undefined;
}>;


export type GetBastionsQuery = { bastions: Array<{ id: string, slug: string, name: string, status: BastionStatusEnum, networkId: string, cloudAccountId: string, sshUser: string, provider: string, publicAccess: boolean, publicIp: string | null, createdAt: string }> };

export type GetBastionQueryVariables = Exact<{
  slug: string;
}>;


export type GetBastionQuery = { bastion: { id: string, slug: string, name: string, status: BastionStatusEnum, networkId: string, cloudAccountId: string, sshUser: string, provider: string, publicAccess: boolean, publicIp: string | null, createdAt: string } | null };

export type GetBastionPrivateKeyQueryVariables = Exact<{
  slug: string;
}>;


export type GetBastionPrivateKeyQuery = { bastionPrivateKey: { success: boolean, message: string | null, privateKey: string | null, sshUser: string | null, hostPublicKey: string | null, hostKeyFingerprint: string | null } };

export type CreateBastionMutationVariables = Exact<{
  input: CreateBastionInput;
}>;


export type CreateBastionMutation = { createBastion: { success: boolean, message: string | null, deploymentId: string | null, bastion: { slug: string, name: string, status: BastionStatusEnum, networkId: string, cloudAccountId: string, sshUser: string, provider: string, publicAccess: boolean, publicIp: string | null } | null } };

export type DestroyBastionMutationVariables = Exact<{
  slug: string;
}>;


export type DestroyBastionMutation = { destroyBastion: { success: boolean, message: string | null, deploymentId: string | null } };

export type GetBastionCloudsQueryVariables = Exact<{ [key: string]: never; }>;


export type GetBastionCloudsQuery = { clouds: Array<{ id: string, name: string, provider: CloudProviderEnum }> };

export type GetBastionNetworksQueryVariables = Exact<{ [key: string]: never; }>;


export type GetBastionNetworksQuery = { networks: Array<{ id: string, name: string, slug: string, region: string, cloudAccountId: string, stackStatus: string | null }> };

export type StartBastionSessionMutationVariables = Exact<{
  slug: string;
}>;


export type StartBastionSessionMutation = { startBastionSession: { success: boolean, message: string | null, aws: { region: string, sessionId: string, streamUrl: string, tokenValue: string, target: string } | null } };

export type GetTunnelBastionQueryVariables = Exact<{
  slug: string;
}>;


export type GetTunnelBastionQuery = { bastion: { id: string, provider: string, publicAccess: boolean, publicIp: string | null } | null };

export type StartVersionDeploymentMutationVariables = Exact<{
  environment: string;
  config: Record<string, unknown>;
  versionId?: string | null | undefined;
  options?: DeploymentOptionsInput | null | undefined;
}>;


export type StartVersionDeploymentMutation = { startDeployment: { success: boolean, message: string | null, deploymentIds: Array<string> | null, versionId: string | null } };

export type ClaimStepMutationVariables = Exact<{
  stepId: string;
}>;


export type ClaimStepMutation = { claimStep: { success: boolean, message: string | null, step: { id: string, stepType: string, cliTask: string | null, cliInputs:
        | { __typename: 'ArtifactUploadCliInputs', stepId: string, provider: string, bucketName: string, objectKey: string, region: string, maxArtifactBytes: number, excludePatterns: Array<string> | null, packageSourcePath: string | null, aws: { accessKeyId: string, secretAccessKey: string, sessionToken: string } | null, source: { bucketName: string, objectKey: string, region: string, aws: { accessKeyId: string, secretAccessKey: string, sessionToken: string } | null } | null }
        | { __typename: 'ContainerPushCliInputs', stepId: string, imageUri: string, localImageTag: string | null, registryEndpoint: string, registryUsername: string, registryPassword: string | null, source: { imageUri: string, registryEndpoint: string, registryUsername: string, registryPassword: string | null } | null }
        | { __typename: 'LocalBuildCliInputs', stepId: string, serviceName: string, versionTag: string, projectId: string, projectSlug: string, buildCommands: Array<string> | null, dockerfile: string | null, workingDir: string | null, dockerTarget: string | null, namedBuildName: string | null, architecture: string | null, buildArgs: Array<{ name: string, value: string }> | null }
        | { __typename: 'ObjectUploadCliInputs', stepId: string, sourcePath: string, includePatterns: Array<string> | null, excludePatterns: Array<string> | null, source: { bucketName: string, region: string, keyPrefix: string, aws: { accessKeyId: string, secretAccessKey: string, sessionToken: string } | null } | null }
       | null } | null } };

export type CancelLiftDeploymentMutationVariables = Exact<{
  id: string;
}>;


export type CancelLiftDeploymentMutation = { cancelDeployment: { success: boolean, message: string | null } };

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

export type GetCloudChoicesQueryVariables = Exact<{ [key: string]: never; }>;


export type GetCloudChoicesQuery = { clouds: Array<{ id: string, name: string, provider: CloudProviderEnum }> };

export type GetNetworkChoicesQueryVariables = Exact<{ [key: string]: never; }>;


export type GetNetworkChoicesQuery = { networks: Array<{ id: string, name: string, slug: string, region: string, cloudAccountId: string, stackStatus: string | null }> };

export type GetProjectChoicesQueryVariables = Exact<{ [key: string]: never; }>;


export type GetProjectChoicesQuery = { projects: Array<{ id: string, name: string, slug: string }> };

export type GetEnvironmentChoicesQueryVariables = Exact<{
  projectId?: string | null | undefined;
}>;


export type GetEnvironmentChoicesQuery = { environments: Array<{ id: string, name: string, slug: string, projectId: string, isProduction: boolean }> };

export type GetSecretChoicesQueryVariables = Exact<{
  cloudAccountId?: string | null | undefined;
}>;


export type GetSecretChoicesQuery = { secrets: Array<{ id: string, name: string, description: string | null, cloudAccountId: string }> };

export type GetDomainChoicesQueryVariables = Exact<{ [key: string]: never; }>;


export type GetDomainChoicesQuery = { domains: Array<{ id: string, name: string }> };

export type GetCloudRegionChoicesQueryVariables = Exact<{
  provider: CloudProviderEnum;
}>;


export type GetCloudRegionChoicesQuery = { cloudRegions: Array<{ code: string, name: string }> };

export type LiftBuildMutationVariables = Exact<{
  input: LiftBuildInput;
}>;


export type LiftBuildMutation = { liftBuild: { success: boolean, message: string | null, versionId: string | null, versionNumber: number | null, yamlSnapshot: string | null } };

export type ReleaseOutputQueryVariables = Exact<{
  versionId: string;
  after?: string | null | undefined;
}>;


export type ReleaseOutputQuery = { releaseOutput: { cursor: string | null, lines: Array<{ message: string, deploymentId: string }> } };

export type GetReleaseDeploymentQueryVariables = Exact<{
  id: string;
}>;


export type GetReleaseDeploymentQuery = { deployment: { id: string, status: DeploymentStatus, lastMessage: string | null, versionId: string | null, steps: Array<{ stepType: string, status: DeploymentStepStatus }> | null } | null };

export type ResolveProjectQueryVariables = Exact<{
  input: ResolveProjectInput;
}>;


export type ResolveProjectQuery = { resolveProject: { ok: boolean, blueprintReference: string | null, errors: Array<{ code: string, message: string, path: string, suggestion: string | null }>, environments: Array<{ environment: string, config: Record<string, unknown>, resolvedYaml: string, provenance: Array<{ name: string, type: string, value: string, source: string }>, plan: { services: Array<{ name: string, type: string, deploymentType: string, source: string, cluster: string | null }>, routing: Array<{ domain: string, entryType: string, loadBalancer: string | null, paths: Array<{ path: string, service: string, deploymentType: string, routeHops: Array<string> }> }>, builds: Array<{ name: string, architecture: string }> } }> } };

export type GetRoutingDeploymentQueryVariables = Exact<{
  id: string;
}>;


export type GetRoutingDeploymentQuery = { deployment: { id: string, status: DeploymentStatus, lastMessage: string | null, postDeployState: PostDeployState | null, steps: Array<{ stepType: string, status: DeploymentStepStatus }> | null } | null };

export type VersionRouteUrlsQueryVariables = Exact<{
  versionId: string;
}>;


export type VersionRouteUrlsQuery = { versionRouteUrls: Array<{ url: string, domain: string | null, path: string, serviceName: string, cache: string | null }> };

export type VersionDnsRecordsQueryVariables = Exact<{
  versionId: string;
}>;


export type VersionDnsRecordsQuery = { versionDnsRecords: Array<{ hostname: string, recordType: string, name: string, value: string, managed: boolean, syncStatus: string }> };

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
      | { __typename: 'ObjectUploadCliInputs', uploadUrls: { store: Array<{ path: string, key: string, url: string, contentType: string }> } | null }
     | null } | null };
