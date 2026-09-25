import js from '@eslint/js'
import prettierConfig from 'eslint-config-prettier'
import importXPlugin, { createNodeResolver } from 'eslint-plugin-import-x'
import prettierPlugin from 'eslint-plugin-prettier'
import tseslint from 'typescript-eslint'

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/*.config.mjs',
      '**/*.config.ts',
      'codegen.ts',
      'scripts/**',
      'src/generated/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      prettier: prettierPlugin,
      import: importXPlugin,
    },
    settings: {
      // import-x v4 requires the new resolver interface; the legacy default node
      // resolver is rejected. Keyed under both namespaces so it applies whether
      // the plugin is referenced as `import` or `import-x`.
      'import/resolver-next': [createNodeResolver()],
      'import-x/resolver-next': [createNodeResolver()],
    },
    rules: {
      'prettier/prettier': 'error',

      'import/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      'import/no-duplicates': 'error',
      'import/first': 'error',
      'import/newline-after-import': 'error',

      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',

      // The console IS this program's output surface: command results, tables,
      // spinners, and error text are all printed through it.
      'no-console': 'off',
      'no-debugger': 'warn',
    },
  },

  prettierConfig,
]
