import { defineConfig } from 'tsup'

export default defineConfig(({ watch }) => ({
  entry: ['src/index.ts'],
  // ESM-only: the package is `type: module` and the bin is ESM. A CJS build
  // can't `require()` ESM-only deps like ora v8. The createRequire banner below
  // lets esbuild's `__require` shim resolve CJS deps via a real Node require, so
  // mixed CJS/ESM dependencies all load from a single ESM bundle.
  format: ['esm'],
  dts: false,
  // Off to keep the published package small; the source is public in the repo,
  // and stack traces point at readable, unminified bundle code anyway.
  sourcemap: false,
  clean: !watch,
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire } from 'module';\nconst require = createRequire(import.meta.url);",
  },
}))
