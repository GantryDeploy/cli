import type {
  RepairableResourceTypeEnum,
  RepairResourceMutation,
  RepairResourceMutationVariables,
} from '../generated/graphql'

import { formatApiError, graphqlRequest } from './client'
import { printError, printSuccess } from './output'

const REPAIR_RESOURCE_MUTATION = /* GraphQL */ `
  mutation RepairResource($resourceType: RepairableResourceTypeEnum!, $id: String!) {
    repairResource(resourceType: $resourceType, id: $id) {
      success
      message
    }
  }
`

/**
 * Asks Gantry to apply a resource's saved configuration to its infrastructure again,
 * then says where to watch it. Exits non-zero when the API refuses.
 */
export async function repairResource(
  resourceType: RepairableResourceTypeEnum,
  resource: { id: string; slug: string },
  listCommand: string
): Promise<void> {
  try {
    const { repairResource: result } = await graphqlRequest<
      RepairResourceMutation,
      RepairResourceMutationVariables
    >(REPAIR_RESOURCE_MUTATION, { resourceType, id: resource.id })
    if (!result.success) {
      printError(result.message)
      process.exit(1)
    }
    printSuccess(`Repairing ${resource.slug}. Gantry is applying its saved configuration again.`)
    console.log(`  Check progress: ${listCommand}`)
  } catch (error) {
    printError(formatApiError(error))
    process.exit(1)
  }
}
