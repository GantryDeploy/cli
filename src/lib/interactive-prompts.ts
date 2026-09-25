import { checkbox, input, select } from '@inquirer/prompts'

import type {
  GetCloudChoicesQuery,
  GetCloudChoicesQueryVariables,
  GetCloudRegionChoicesQuery,
  GetCloudRegionChoicesQueryVariables,
  GetDomainChoicesQuery,
  GetDomainChoicesQueryVariables,
  GetEnvironmentChoicesQuery,
  GetEnvironmentChoicesQueryVariables,
  GetNetworkChoicesQuery,
  GetNetworkChoicesQueryVariables,
  GetProjectChoicesQuery,
  GetProjectChoicesQueryVariables,
  GetSecretChoicesQuery,
  GetSecretChoicesQueryVariables,
} from '../generated/graphql'

import { graphqlRequest } from './client'
import { AWS_REGIONS } from './domain-validation'
import { printError } from './output'

const CLOUDS_QUERY = /* GraphQL */ `
  query GetCloudChoices {
    clouds {
      id
      name
      provider
    }
  }
`

const NETWORKS_QUERY = /* GraphQL */ `
  query GetNetworkChoices {
    networks {
      id
      name
      slug
      region
      cloudAccountId
      stackStatus
    }
  }
`

const PROJECTS_QUERY = /* GraphQL */ `
  query GetProjectChoices {
    projects {
      id
      name
      slug
    }
  }
`

const ENVIRONMENTS_QUERY = /* GraphQL */ `
  query GetEnvironmentChoices($projectId: String) {
    environments(projectId: $projectId) {
      id
      name
      projectId
      isProduction
    }
  }
`

const SECRETS_QUERY = /* GraphQL */ `
  query GetSecretChoices($cloudAccountId: String) {
    secrets(cloudAccountId: $cloudAccountId) {
      id
      name
      description
      cloudAccountId
    }
  }
`

const DOMAINS_QUERY = /* GraphQL */ `
  query GetDomainChoices {
    domains {
      id
      name
    }
  }
`

const CLOUD_REGIONS_QUERY = /* GraphQL */ `
  query GetCloudRegionChoices($provider: String) {
    cloudRegions(provider: $provider) {
      code
      name
    }
  }
`

export async function selectCloud(): Promise<string> {
  const data = await graphqlRequest<GetCloudChoicesQuery, GetCloudChoicesQueryVariables>(
    CLOUDS_QUERY
  )
  if (data.clouds.length === 0) {
    printError('No cloud accounts found.')
    process.exit(1)
  }

  return select({
    message: 'Select a cloud account:',
    choices: data.clouds.map((c) => ({
      name: `${c.name} (${c.provider.toUpperCase()})`,
      value: c.id,
    })),
  })
}

export async function selectNetwork(
  cloudAccountId: string,
  options?: { allowNone?: boolean }
): Promise<string | undefined> {
  const data = await graphqlRequest<GetNetworkChoicesQuery, GetNetworkChoicesQueryVariables>(
    NETWORKS_QUERY
  )
  const filtered = data.networks.filter(
    (n) => n.cloudAccountId === cloudAccountId && n.stackStatus?.toLowerCase() === 'deployed'
  )

  if (filtered.length === 0 && !options?.allowNone) {
    printError('No active networks found for the selected cloud account.')
    process.exit(1)
  }

  const choices: { name: string; value: string }[] = filtered.map((n) => ({
    name: `${n.name} (${n.region}) — ${n.slug}`,
    value: n.id,
  }))

  if (options?.allowNone) {
    choices.unshift({ name: 'None', value: '__none__' })
  }

  if (choices.length === 0) {
    return undefined
  }

  const selected = await select({
    message: 'Select a network:',
    choices,
  })

  return selected === '__none__' ? undefined : selected
}

export async function selectRegion(provider?: string): Promise<string> {
  const data = await graphqlRequest<
    GetCloudRegionChoicesQuery,
    GetCloudRegionChoicesQueryVariables
  >(CLOUD_REGIONS_QUERY, {
    provider: provider ?? 'aws',
  })

  if (data.cloudRegions.length === 0) {
    printError('No regions found.')
    process.exit(1)
  }

  return select({
    message: 'Select a region:',
    choices: data.cloudRegions.map((r) => ({
      name: `${r.code} — ${r.name}`,
      value: r.code,
    })),
  })
}

export async function selectRegions(defaults?: string[]): Promise<string[]> {
  const defaultSet = new Set(defaults ?? ['us-east-1'])

  const selected = await checkbox({
    message: 'Select AWS regions:',
    choices: AWS_REGIONS.map((r) => ({
      name: `${r.code} — ${r.name}`,
      value: r.code,
      checked: defaultSet.has(r.code),
    })),
    required: true,
  })

  if (!selected.includes('us-east-1')) {
    console.log(
      '\n  ⚠ CloudFront distributions require certificates in us-east-1. If you plan to use CloudFront CDN, consider including that region.\n'
    )
  }

  return selected
}

export async function selectProject(): Promise<string> {
  const data = await graphqlRequest<GetProjectChoicesQuery, GetProjectChoicesQueryVariables>(
    PROJECTS_QUERY
  )
  if (data.projects.length === 0) {
    printError('No projects found.')
    process.exit(1)
  }

  return select({
    message: 'Select a project:',
    choices: data.projects.map((p) => ({
      name: `${p.name} — ${p.slug}`,
      value: p.id,
    })),
  })
}

export async function selectEnvironment(projectId: string): Promise<string> {
  const data = await graphqlRequest<
    GetEnvironmentChoicesQuery,
    GetEnvironmentChoicesQueryVariables
  >(ENVIRONMENTS_QUERY, {
    projectId,
  })

  if (data.environments.length === 0) {
    printError('No environments found for the selected project.')
    process.exit(1)
  }

  return select({
    message: 'Select an environment:',
    choices: data.environments.map((e) => ({
      name: `${e.name}${e.isProduction ? ' (production)' : ''}`,
      value: e.id,
    })),
  })
}

export async function selectSecret(cloudAccountId?: string): Promise<string> {
  const variables: GetSecretChoicesQueryVariables = {}
  if (cloudAccountId) variables.cloudAccountId = cloudAccountId

  const data = await graphqlRequest<GetSecretChoicesQuery, GetSecretChoicesQueryVariables>(
    SECRETS_QUERY,
    variables
  )
  if (data.secrets.length === 0) {
    printError('No secrets found.')
    process.exit(1)
  }

  return select({
    message: 'Select a secret:',
    choices: data.secrets.map((s) => ({
      name: `${s.name}${s.description ? ` — ${s.description}` : ''}`,
      value: s.id,
    })),
  })
}

export async function selectDomain(): Promise<{ id: string; name: string }> {
  const data = await graphqlRequest<GetDomainChoicesQuery, GetDomainChoicesQueryVariables>(
    DOMAINS_QUERY
  )
  if (data.domains.length === 0) {
    printError('No domains found.')
    process.exit(1)
  }

  const selectedId = await select({
    message: 'Select a domain:',
    choices: data.domains.map((d) => ({
      name: d.name,
      value: d.id,
    })),
  })

  const domain = data.domains.find((d) => d.id === selectedId)
  if (!domain) {
    printError('No domains found.')
    process.exit(1)
  }
  return { id: domain.id, name: domain.name }
}

export async function promptName(resource: string): Promise<string> {
  return input({
    message: `${resource} name:`,
    validate: (v) => (v.trim().length > 0 ? true : 'Name is required'),
  })
}
