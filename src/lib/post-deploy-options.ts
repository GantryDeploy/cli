import { Option } from 'commander'

export interface PostDeployOptions {
  skipPostDeploy?: boolean
  postDeployAsync?: boolean
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
