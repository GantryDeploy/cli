import type { CodegenConfig } from '@graphql-codegen/cli'

/**
 * Generated from a committed copy of the public API's SDL, refreshed with
 * `npm run schema:pull`. Deliberately not introspection: codegen then needs no
 * server, no credentials, and no network, and a schema change shows up as a
 * reviewable diff next to the regenerated types.
 *
 * `documents` only finds operations whose template literal is preceded by the
 * GraphQL magic comment; an untagged operation escapes schema validation.
 */
const config: CodegenConfig = {
  schema: './schema/public-api.graphql',
  documents: ['src/**/*.ts', '!src/generated/**', '!src/**/*.test.ts'],
  generates: {
    'src/generated/graphql.ts': {
      // typescript-operations v6+ emits the input and enum types each operation
      // uses; adding the `typescript` plugin would declare them twice.
      plugins: ['typescript-operations'],
      config: {
        enumsAsTypes: true,
        scalars: {
          DateTime: 'string',
          BigInt: 'string',
          JSON: 'Record<string, unknown>',
        },
        skipTypename: true,
      },
    },
  },
}

export default config
