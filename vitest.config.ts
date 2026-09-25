import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: '@gantrydeploy/cli',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html', 'lcov'],
      reportOnFailure: true,
      include: ['src/**/*.ts'],
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.test.ts',
        '**/*.d.ts',
        'src/generated/**',
        // Entry wiring: the Node version gate and command registration.
        'src/index.ts',
        'src/main.ts',
      ],
      // 80% is the floor everywhere: raise these as coverage improves, never lower them.
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
        'src/lib/**': {
          lines: 80,
          functions: 80,
          branches: 80,
          statements: 80,
        },
        'src/commands/**': {
          lines: 80,
          functions: 80,
          branches: 80,
          statements: 80,
        },
      },
    },
  },
})
