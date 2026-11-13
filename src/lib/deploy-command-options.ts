import { Option } from 'commander'

/** The pre- and post-deploy flags that `lift`, `promote` and `redeploy` all take. */
export interface DeployCommandOptions {
  skipPreDeploy?: boolean
  skipPostDeploy?: boolean
  postDeployAsync?: boolean
}

export function skipPreDeployOption(): Option {
  return new Option('--skip-pre-deploy', "Deploy without running the services' pre_deploy commands")
}

export function skipPostDeployOption(): Option {
  return new Option(
    '--skip-post-deploy',
    "Go live without running the services' post_deploy commands"
  ).conflicts('postDeployAsync')
}

export function postDeployAsyncOption(): Option {
  return new Option(
    '--post-deploy-async',
    'Exit once the version is live, while its post_deploy commands still run'
  ).conflicts('skipPostDeploy')
}

/** The skips to send in `startDeployment`'s options. */
export function deployCommandSkips(options: DeployCommandOptions): {
  skipPreDeploy: boolean
  skipPostDeploy: boolean
} {
  return {
    skipPreDeploy: options.skipPreDeploy === true,
    skipPostDeploy: options.skipPostDeploy === true,
  }
}
