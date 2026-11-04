import { checkbox } from '@inquirer/prompts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

import {
  AWS_OPTIONS_GROUP,
  awsCertificateRegions,
  awsOption,
  buildAwsDatabaseUpdate,
  buildAwsNetworkSettings,
  toAwsCacheDeploymentMode,
  toAwsDatabaseDeploymentMode,
  toAwsDatabaseFlavor,
} from './aws'

vi.mock('@inquirer/prompts', () => ({ checkbox: vi.fn(), input: vi.fn(), select: vi.fn() }))

const regions = [
  { code: 'us-east-1', name: 'US East (N. Virginia)' },
  { code: 'eu-west-1', name: 'Europe (Ireland)' },
]

describe('aws cloud module', () => {
  it('puts AWS flags under their own help heading', () => {
    expect(awsOption('--aws-nat <option>', 'NAT gateways').helpGroupHeading).toBe(AWS_OPTIONS_GROUP)
  })

  it.each([
    ['rds', 'rds'],
    [' Aurora ', 'aurora'],
  ])('reads the database service %j as %s', (flavor, expected) => {
    expect(toAwsDatabaseFlavor(flavor)).toBe(expected)
  })

  it('rejects another database service without echoing it back', () => {
    expect(() => toAwsDatabaseFlavor('docdb')).toThrow(
      /^Unknown AWS database service\. Use rds or aurora\.$/
    )
  })

  it.each([
    [toAwsCacheDeploymentMode, 'node-based', 'NODE_BASED'],
    [toAwsDatabaseDeploymentMode, 'provisioned', 'PROVISIONED'],
    [toAwsDatabaseDeploymentMode, 'serverless', 'SERVERLESS'],
  ])('reads the deployment mode %#', (read, mode, expected) => {
    expect(read(mode)).toBe(expected)
  })

  describe('buildAwsNetworkSettings', () => {
    it('sends AWS settings only when an AWS flag is set', () => {
      expect(buildAwsNetworkSettings({ awsNat: 'per-az', awsNoInternet: true })).toEqual({
        ok: true,
        value: { natGatewayOption: 'PER_AZ', enableInternetAccess: false },
      })
      expect(buildAwsNetworkSettings({})).toEqual({ ok: true, value: undefined })
    })

    it('refuses an unknown NAT option', () => {
      expect(buildAwsNetworkSettings({ awsNat: 'double' })).toEqual({
        ok: false,
        message: '--aws-nat must be none, single or per-az',
      })
    })
  })

  describe('buildAwsDatabaseUpdate', () => {
    it('turns master rotation off and Performance Insights on', () => {
      expect(
        buildAwsDatabaseUpdate({ awsNoMasterRotation: true, awsPerformanceInsights: true })
      ).toEqual({
        ok: true,
        value: { masterPasswordRotation: false, performanceInsightsEnabled: true },
      })
    })

    it('refuses both sides of a switch', () => {
      expect(
        buildAwsDatabaseUpdate({ awsMasterRotation: true, awsNoMasterRotation: true })
      ).toEqual({
        ok: false,
        message: 'Choose either --aws-master-rotation or --aws-no-master-rotation.',
      })
    })
  })

  describe('awsCertificateRegions', () => {
    let logSpy: MockInstance

    beforeEach(() => {
      vi.mocked(checkbox).mockReset()
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    })

    afterEach(() => {
      logSpy.mockRestore()
    })

    it('reads a region list from the flag without prompting', async () => {
      await expect(awsCertificateRegions('us-east-1, eu-west-1', regions)).resolves.toEqual({
        ok: true,
        value: ['us-east-1', 'eu-west-1'],
      })
      expect(checkbox).not.toHaveBeenCalled()
      expect(logSpy).not.toHaveBeenCalled()
    })

    it('refuses a region the cloud does not offer', async () => {
      await expect(awsCertificateRegions('us-east-1,mars-north-1', regions)).resolves.toEqual({
        ok: false,
        message: 'Unknown region: mars-north-1. See "gantry regions --cloud <id>".',
      })
    })

    it('offers the cloud regions with us-east-1 checked and warns when it is left out', async () => {
      vi.mocked(checkbox).mockResolvedValueOnce(['eu-west-1'])

      await expect(awsCertificateRegions(undefined, regions)).resolves.toEqual({
        ok: true,
        value: ['eu-west-1'],
      })
      const { choices } = vi.mocked(checkbox).mock.calls[0][0] as unknown as {
        choices: { value: string; checked: boolean }[]
      }
      expect(choices.filter((c) => c.checked).map((c) => c.value)).toEqual(['us-east-1'])
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('CloudFront'))
    })
  })
})
