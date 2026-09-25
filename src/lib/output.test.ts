import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { MockInstance } from 'vitest'

import {
  createTable,
  formatDate,
  printError,
  printHeading,
  printSuccess,
  renderTree,
  slugify,
  styledCell,
} from './output'

describe('output', () => {
  describe('createTable', () => {
    it('creates a table with the given headers', () => {
      const table = createTable({ head: ['Name', 'Status', 'Date'] })

      expect(table).toBeDefined()
      expect(table.options.head).toEqual(['Name', 'Status', 'Date'])
    })

    it('creates a table with custom styling', () => {
      const table = createTable({ head: ['Column 1', 'Column 2'] })

      expect(table.options.style.head).toEqual(['cyan'])
      expect(table.options.style.border).toEqual(['gray'])
    })

    it('draws borders with box-drawing characters', () => {
      const table = createTable({ head: ['Test'] })

      expect(table.options.chars.top).toBe('─')
      expect(table.options.chars['top-left']).toBe('┌')
      expect(table.options.chars['top-right']).toBe('┐')
      expect(table.options.chars.left).toBe('│')
      expect(table.options.chars.right).toBe('│')
    })

    it('accepts empty headers', () => {
      const table = createTable({ head: [] })

      expect(table).toBeDefined()
      expect(table.options.head).toEqual([])
    })

    it('accepts a single header', () => {
      const table = createTable({ head: ['Single'] })

      expect(table.options.head).toEqual(['Single'])
    })

    it('strips control sequences from string cells but keeps styled cells', () => {
      const table = createTable({ head: ['Name', 'Prod'] })

      table.push(['web\x1b[2J\x1b]0;pwned\x07\x9b', styledCell('\x1b[32m✓\x1b[0m')], [42, null])

      expect(table[0]).toEqual(['web', { content: '\x1b[32m✓\x1b[0m' }])
      expect(table[1]).toEqual([42, null])
      const rendered = table.toString()
      expect(rendered).not.toContain('\x1b[2J')
      expect(rendered).not.toContain('\x1b]0;')
      expect(rendered).toContain('\x1b[32m✓\x1b[0m')
    })
  })

  describe('formatDate', () => {
    it('formats an ISO date string', () => {
      const dateStr = '2024-03-15T10:30:00Z'
      const formatted = formatDate(dateStr)

      expect(formatted).toMatch(/Mar 15, 2024/)
    })

    it('formats dates across months', () => {
      const dates = [
        { input: '2024-01-01T12:00:00Z', month: 'Jan', day: '1', year: '2024' },
        { input: '2024-06-15T12:00:00Z', month: 'Jun', day: '15', year: '2024' },
        { input: '2024-12-31T12:00:00Z', month: 'Dec', day: '31', year: '2024' },
      ]

      for (const { input, month, day, year } of dates) {
        const formatted = formatDate(input)
        expect(formatted).toContain(month)
        expect(formatted).toContain(day)
        expect(formatted).toContain(year)
      }
    })

    it('formats dates across years', () => {
      expect(formatDate('2023-05-10T00:00:00Z')).toMatch(/2023/)
      expect(formatDate('2025-05-10T00:00:00Z')).toMatch(/2025/)
    })

    it('formats full timestamp strings', () => {
      const timestamp = new Date('2024-07-20T15:45:30Z').toISOString()
      const formatted = formatDate(timestamp)

      expect(formatted).toMatch(/Jul 20, 2024/)
    })
  })

  describe('printError', () => {
    let consoleErrorSpy: MockInstance

    beforeEach(() => {
      consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {
        // intentionally empty: suppress console output during tests
      })
    })

    afterEach(() => {
      consoleErrorSpy.mockRestore()
    })

    it('prints the error to stderr in red', () => {
      printError('Test error message')

      expect(consoleErrorSpy).toHaveBeenCalledWith('\x1b[31mError:\x1b[0m Test error message')
    })

    it('prints an empty error message', () => {
      printError('')

      expect(consoleErrorSpy).toHaveBeenCalledWith('\x1b[31mError:\x1b[0m ')
    })

    it('prints multiline error messages', () => {
      const multilineError = 'Line 1\nLine 2\nLine 3'
      printError(multilineError)

      expect(consoleErrorSpy).toHaveBeenCalledWith(`\x1b[31mError:\x1b[0m ${multilineError}`)
    })

    it.each([
      ['clear screen', 'Deploy \x1b[2Jfailed'],
      ['OSC title', 'Deploy \x1b]0;Deploy succeeded\x07failed'],
      ['8-bit CSI', 'Deploy \x9b2Jfailed'],
    ])('neutralises %s in the message but keeps its own red prefix', (_label, message) => {
      printError(message)

      expect(consoleErrorSpy).toHaveBeenCalledWith('\x1b[31mError:\x1b[0m Deploy failed')
    })

    it('prints error messages with special characters', () => {
      printError('Error: File "test.txt" not found!')

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '\x1b[31mError:\x1b[0m Error: File "test.txt" not found!'
      )
    })
  })

  describe('printSuccess', () => {
    let consoleLogSpy: MockInstance

    beforeEach(() => {
      consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {
        // intentionally empty: suppress console output during tests
      })
    })

    afterEach(() => {
      consoleLogSpy.mockRestore()
    })

    it('prints the message with a green checkmark', () => {
      printSuccess('Operation completed')

      expect(consoleLogSpy).toHaveBeenCalledWith('\x1b[32m✓\x1b[0m Operation completed')
    })

    it('prints an empty success message', () => {
      printSuccess('')

      expect(consoleLogSpy).toHaveBeenCalledWith('\x1b[32m✓\x1b[0m ')
    })

    it('prints multiline success messages', () => {
      const multilineSuccess = 'Step 1 complete\nStep 2 complete'
      printSuccess(multilineSuccess)

      expect(consoleLogSpy).toHaveBeenCalledWith(`\x1b[32m✓\x1b[0m ${multilineSuccess}`)
    })

    it('prints success messages with special characters', () => {
      printSuccess('Deployed to "production" environment!')

      expect(consoleLogSpy).toHaveBeenCalledWith(
        '\x1b[32m✓\x1b[0m Deployed to "production" environment!'
      )
    })

    it('strips control sequences from the message but keeps its own checkmark colour', () => {
      printSuccess('Signed in as \x1b[2Jci\r')

      expect(consoleLogSpy).toHaveBeenCalledWith('\x1b[32m✓\x1b[0m Signed in as ci')
    })
  })

  describe('createTable key-value rows', () => {
    it('passes non-array rows through unchanged', () => {
      const table = createTable({ head: [] })

      table.push({ Name: 'web' })

      expect(table[0]).toEqual({ Name: 'web' })
    })
  })

  describe('slugify', () => {
    it.each([
      ['My App', 'my-app'],
      ['  Shop -- API v2!  ', 'shop-api-v2'],
      ['---', ''],
      ['Café Crème', 'caf-cr-me'],
    ])('slugifies %j to %j', (input, expected) => {
      expect(slugify(input)).toBe(expected)
    })
  })

  describe('renderTree', () => {
    it('returns nothing for an empty tree', () => {
      expect(renderTree([])).toEqual([])
    })

    it('draws nested branches with the right connectors and indentation', () => {
      expect(
        renderTree([
          {
            label: 'api',
            children: [{ label: 'web' }, { label: 'worker', children: [{ label: 'q' }] }],
          },
          { label: 'cdn', children: [] },
        ])
      ).toEqual(['├── api', '│   ├── web', '│   └── worker', '│       └── q', '└── cdn'])
    })
  })

  describe('printHeading', () => {
    it('strips control sequences from the heading but keeps its own styling', () => {
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

      printHeading('DNS\x1b]0;x\x07 records')

      expect(consoleLogSpy).toHaveBeenCalledWith('\n\x1b[1m\x1b[4mDNS records\x1b[0m')
      consoleLogSpy.mockRestore()
    })
  })
})
