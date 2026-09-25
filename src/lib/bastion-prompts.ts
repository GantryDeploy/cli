import { input, select } from '@inquirer/prompts'
import ora from 'ora'

import type {
  CreateBastionMutation,
  CreateBastionMutationVariables,
  GetBastionCloudsQuery,
  GetBastionCloudsQueryVariables,
  GetBastionNetworksQuery,
  GetBastionNetworksQueryVariables,
  GetBastionPrivateKeyQuery,
  GetBastionPrivateKeyQueryVariables,
  GetBastionQuery,
  GetBastionQueryVariables,
  GetBastionsQuery,
  GetBastionsQueryVariables,
} from '../generated/graphql'

import { formatApiError, graphqlRequest } from './client'
import { printError, slugify } from './output'

export const BASTIONS_QUERY = /* GraphQL */ `
  query GetBastions($networkId: String) {
    bastions(networkId: $networkId) {
      slug
      name
      status
      networkId
      cloudAccountId
      instanceId
      publicIp
      createdAt
    }
  }
`

export const BASTION_QUERY = /* GraphQL */ `
  query GetBastion($slug: String!) {
    bastion(slug: $slug) {
      slug
      name
      status
      networkId
      cloudAccountId
      instanceId
      publicIp
      createdAt
    }
  }
`

export const BASTION_PRIVATE_KEY_QUERY = /* GraphQL */ `
  query GetBastionPrivateKey($slug: String!) {
    bastionPrivateKey(slug: $slug) {
      success
      message
      privateKey
    }
  }
`

export const CREATE_BASTION_MUTATION = /* GraphQL */ `
  mutation CreateBastion($input: CreateBastionInput!) {
    createBastion(input: $input) {
      success
      message
      bastion {
        slug
        name
        status
        networkId
        cloudAccountId
        instanceId
        publicIp
      }
      deploymentId
    }
  }
`

export const DESTROY_BASTION_MUTATION = /* GraphQL */ `
  mutation DestroyBastion($slug: String!) {
    destroyBastion(slug: $slug) {
      success
      message
      deploymentId
    }
  }
`

export type Bastion = GetBastionsQuery['bastions'][number]

type CreatedBastion = NonNullable<CreateBastionMutation['createBastion']['bastion']>

interface SelectBastionOptions {
  networkId?: string
  includeCreateOption?: boolean
  filter?: (bastion: Bastion) => boolean
}

export async function fetchBastions(networkId?: string): Promise<Bastion[]> {
  const variables: GetBastionsQueryVariables = {}
  if (networkId) variables.networkId = networkId

  const data = await graphqlRequest<GetBastionsQuery, GetBastionsQueryVariables>(
    BASTIONS_QUERY,
    variables
  )
  return data.bastions
}

export async function fetchBastion(slug: string): Promise<Bastion | null> {
  const data = await graphqlRequest<GetBastionQuery, GetBastionQueryVariables>(BASTION_QUERY, {
    slug,
  })
  return data.bastion
}

export async function fetchBastionPrivateKey(slug: string): Promise<string> {
  const data = await graphqlRequest<GetBastionPrivateKeyQuery, GetBastionPrivateKeyQueryVariables>(
    BASTION_PRIVATE_KEY_QUERY,
    { slug }
  )
  if (!data.bastionPrivateKey.success || !data.bastionPrivateKey.privateKey) {
    throw new Error(data.bastionPrivateKey.message ?? 'Failed to retrieve SSH key')
  }
  return data.bastionPrivateKey.privateKey
}

export async function selectBastion(
  options: SelectBastionOptions = {}
): Promise<Bastion | 'create'> {
  const bastions = await fetchBastions(options.networkId)

  let filtered = bastions
  if (options.filter) {
    filtered = bastions.filter(options.filter)
  }

  const choices: { name: string; value: string }[] = filtered.map((b) => {
    const ip = b.publicIp ? ` — ${b.publicIp}` : ''
    return {
      name: `${b.name} (${b.status})${ip}`,
      value: b.slug,
    }
  })

  if (options.includeCreateOption) {
    choices.push({ name: '+ Create a new bastion', value: '__create__' })
  }

  if (choices.length === 0) {
    printError('No bastion hosts available.')
    process.exit(1)
  }

  const selected = await select({
    message: 'Select a bastion host:',
    choices,
  })

  if (selected === '__create__') {
    return 'create'
  }

  const bastion = filtered.find((b) => b.slug === selected)
  if (!bastion) {
    throw new Error('Selected bastion not found')
  }
  return bastion
}

const CLOUDS_QUERY = /* GraphQL */ `
  query GetBastionClouds {
    clouds {
      id
      name
      provider
    }
  }
`

const NETWORKS_QUERY = /* GraphQL */ `
  query GetBastionNetworks {
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

export async function createBastionInteractive(options: {
  cloudAccountId?: string
  networkId?: string
  name?: string
  slug?: string
  waitForActive?: boolean
}): Promise<CreatedBastion> {
  let cloudAccountId = options.cloudAccountId
  let networkId = options.networkId

  if (!cloudAccountId) {
    const data = await graphqlRequest<GetBastionCloudsQuery, GetBastionCloudsQueryVariables>(
      CLOUDS_QUERY
    )
    if (data.clouds.length === 0) {
      printError('No cloud accounts found.')
      process.exit(1)
    }

    cloudAccountId = await select({
      message: 'Select a cloud account:',
      choices: data.clouds.map((c) => ({
        name: `${c.name} (${c.provider})`,
        value: c.id,
      })),
    })
  }

  if (!networkId) {
    const data = await graphqlRequest<GetBastionNetworksQuery, GetBastionNetworksQueryVariables>(
      NETWORKS_QUERY
    )
    const validNetworks = data.networks.filter(
      (n) => n.cloudAccountId === cloudAccountId && n.stackStatus?.toLowerCase() === 'deployed'
    )
    if (validNetworks.length === 0) {
      printError('No active networks found for the selected cloud account.')
      process.exit(1)
    }

    networkId = await select({
      message: 'Select a network:',
      choices: validNetworks.map((n) => ({
        name: `${n.name} (${n.region}) — ${n.slug}`,
        value: n.id,
      })),
    })
  }

  const name =
    options.name ??
    (await input({
      message: 'Enter a name for the new bastion:',
      validate: (v) => (v.trim().length > 0 ? true : 'Name is required'),
    }))

  const slug = options.slug ?? slugify(name)

  const spinner = ora('Creating bastion host...').start()

  try {
    const data = await graphqlRequest<CreateBastionMutation, CreateBastionMutationVariables>(
      CREATE_BASTION_MUTATION,
      {
        input: {
          cloudAccountId,
          networkId,
          name,
          slug,
        },
      }
    )

    const result = data.createBastion
    const bastion = result.bastion
    if (!result.success || !bastion) {
      spinner.fail(result.message ?? 'Failed to create bastion')
      process.exit(1)
    }

    spinner.succeed(`Bastion created: ${bastion.name} (${bastion.slug})`)

    if (options.waitForActive !== false) {
      return await pollBastionUntilActive(bastion.slug)
    }

    return bastion
  } catch (error) {
    spinner.fail('Failed to create bastion')
    printError(formatApiError(error))
    process.exit(1)
  }
}

export async function pollBastionUntilActive(slug: string, timeoutMs = 300_000): Promise<Bastion> {
  const spinner = ora('Waiting for bastion to become active...').start()
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    const bastion = await fetchBastion(slug)

    if (bastion?.status.toLowerCase() === 'active') {
      spinner.succeed('Bastion is active')
      return bastion
    }

    if (bastion?.status.toLowerCase() === 'failed') {
      spinner.fail('Bastion failed to provision')
      process.exit(1)
    }

    await new Promise((resolve) => setTimeout(resolve, 2000))
  }

  spinner.fail('Timed out waiting for bastion to become active')
  process.exit(1)
}

export function activeOnly(bastion: Bastion): boolean {
  return bastion.status.toLowerCase() === 'active'
}

const GONE_STATUSES = new Set(['deleting', 'deleted'])

export function nonDestroyed(bastion: Bastion): boolean {
  return !GONE_STATUSES.has(bastion.status.toLowerCase())
}
