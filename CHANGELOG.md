# Changelog

## [1.2.0](https://github.com/GantryDeploy/cli/compare/v1.1.0...v1.2.0) (2026-11-27)


### Features

* add gantry shell for interactive sessions on a running container instance (G1167) ([f7e4936](https://github.com/GantryDeploy/cli/commit/f7e493676f89428d8b4824b4c483931c0612f4fe))
* **bastions:** reach private bastions through Session Manager and create public ones with --public (G1156) ([f7e4936](https://github.com/GantryDeploy/cli/commit/f7e493676f89428d8b4824b4c483931c0612f4fe))
* **bastions:** verify host keys against the fingerprint Gantry recorded (G899) ([#8](https://github.com/GantryDeploy/cli/issues/8)) ([c788df0](https://github.com/GantryDeploy/cli/commit/c788df09820e478ab0dd4f56ca3c4e2e797093d8))
* **cleanup:** add gantry cleanup to remove previous routing, and point to it at the end of lift (G1176) ([f7e4936](https://github.com/GantryDeploy/cli/commit/f7e493676f89428d8b4824b4c483931c0612f4fe))
* **cli:** require -e, --env on run, shell and logs (G1197) ([f7e4936](https://github.com/GantryDeploy/cli/commit/f7e493676f89428d8b4824b4c483931c0612f4fe))
* **db:** add --no-master-rotation to gantry db create (G-640) ([ff14abf](https://github.com/GantryDeploy/cli/commit/ff14abf84b45d6645f8ba3b93e11d7386445e148))
* **db:** add gantry db adopt and gantry db users (G-644) ([#11](https://github.com/GantryDeploy/cli/issues/11)) ([ff14abf](https://github.com/GantryDeploy/cli/commit/ff14abf84b45d6645f8ba3b93e11d7386445e148))
* **db:** add gantry db rotate-user with --staged and --in-place to rotate a service database password ([085e3b6](https://github.com/GantryDeploy/cli/commit/085e3b6e32acd3d2caea28e5531235ac4302ac0e))
* **db:** add gantry db update to change a server's capacity, storage, backups and master password rotation ([085e3b6](https://github.com/GantryDeploy/cli/commit/085e3b6e32acd3d2caea28e5531235ac4302ac0e))
* **db:** send shared settings plus an aws section, rename --instance-class to --size and --multi-az to --high-availability ([085e3b6](https://github.com/GantryDeploy/cli/commit/085e3b6e32acd3d2caea28e5531235ac4302ac0e))
* **deploy:** add gantry deploy release commands, lift --from and --build, and rollback to the previous version (G1180) ([f7e4936](https://github.com/GantryDeploy/cli/commit/f7e493676f89428d8b4824b4c483931c0612f4fe))
* **deploy:** print post-deploy output after a cutover (G1174) ([f7e4936](https://github.com/GantryDeploy/cli/commit/f7e493676f89428d8b4824b4c483931c0612f4fe))
* **deploy:** show when a held release times out in deploy status (G1131) ([f7e4936](https://github.com/GantryDeploy/cli/commit/f7e493676f89428d8b4824b4c483931c0612f4fe))
* **docs:** export the command tree for the docs reference (G1188) ([f7e4936](https://github.com/GantryDeploy/cli/commit/f7e493676f89428d8b4824b4c483931c0612f4fe))
* **env:** add gantry env get, set, unset, pull and push (G982) ([f7e4936](https://github.com/GantryDeploy/cli/commit/f7e493676f89428d8b4824b4c483931c0612f4fe))
* **env:** label a preview template's env as its source (G1208) ([f7e4936](https://github.com/GantryDeploy/cli/commit/f7e493676f89428d8b4824b4c483931c0612f4fe))
* **firewalls:** add firewall commands and show each route's firewall after lift (G871 G995) ([f7e4936](https://github.com/GantryDeploy/cli/commit/f7e493676f89428d8b4824b4c483931c0612f4fe))
* **firewalls:** list and replace a firewall's ordered rules with rules and rules set (G871 G993 G994 G995) ([f7e4936](https://github.com/GantryDeploy/cli/commit/f7e493676f89428d8b4824b4c483931c0612f4fe))
* **lb:** add --allowed-cidr and --aws-cdn-only to create, and lb firewall to attach or detach a firewall (G1227 G1228) ([f7e4936](https://github.com/GantryDeploy/cli/commit/f7e493676f89428d8b4824b4c483931c0612f4fe))
* **lb:** add --internal to create and show visibility (G1219) ([f7e4936](https://github.com/GantryDeploy/cli/commit/f7e493676f89428d8b4824b4c483931c0612f4fe))
* **lb:** remove the GATEWAY_HTTP load balancer type and label API Gateway route hops (G1176) ([f7e4936](https://github.com/GantryDeploy/cli/commit/f7e493676f89428d8b4824b4c483931c0612f4fe))
* **lift:** add --skip-post-deploy and --post-deploy-async ([f7e4936](https://github.com/GantryDeploy/cli/commit/f7e493676f89428d8b4824b4c483931c0612f4fe))
* **lift:** mark locked routes and point at origin-lock show (G1220) ([f7e4936](https://github.com/GantryDeploy/cli/commit/f7e493676f89428d8b4824b4c483931c0612f4fe))
* **lift:** read cloud-neutral deploy task inputs (object-upload, objectKey, registry credentials, aws upload section) and take the artifact size limit from the server ([085e3b6](https://github.com/GantryDeploy/cli/commit/085e3b6e32acd3d2caea28e5531235ac4302ac0e))
* **lift:** ship a build to an environment in another region or cloud account, copying the build there (G1175) ([f7e4936](https://github.com/GantryDeploy/cli/commit/f7e493676f89428d8b4824b4c483931c0612f4fe))
* **lift:** ship an environment's live build again with --from set to the same environment, and add --skip-pre-deploy (G982) ([f7e4936](https://github.com/GantryDeploy/cli/commit/f7e493676f89428d8b4824b4c483931c0612f4fe))
* **logs:** add gantry logs and gantry databases logs ([f7e4936](https://github.com/GantryDeploy/cli/commit/f7e493676f89428d8b4824b4c483931c0612f4fe))
* name the environment with --env on versions, deployments and validate ([f7e4936](https://github.com/GantryDeploy/cli/commit/f7e493676f89428d8b4824b4c483931c0612f4fe))
* **origin-lock:** add origin-lock show for a locked hostname's header (G1220) ([f7e4936](https://github.com/GantryDeploy/cli/commit/f7e493676f89428d8b4824b4c483931c0612f4fe))
* **origin-lock:** show setup steps for the proxy a hostname is locked to (G1225) ([f7e4936](https://github.com/GantryDeploy/cli/commit/f7e493676f89428d8b4824b4c483931c0612f4fe))
* **preview:** create, redeploy, list and tear down preview environments (G1123 G1124) ([f7e4936](https://github.com/GantryDeploy/cli/commit/f7e493676f89428d8b4824b4c483931c0612f4fe))
* replace gantry console with gantry run, adding ECS support (G1164) ([#15](https://github.com/GantryDeploy/cli/issues/15)) ([429598a](https://github.com/GantryDeploy/cli/commit/429598a310d8d0fca1bdb4f1c6fd33d4b9a875f6))
* resolve each command's cloud from the cloud account, move AWS-only flags under --aws-*, key catalogs by cloud, read the bastion SSH user from the API and use cloud-neutral deploy task inputs ([085e3b6](https://github.com/GantryDeploy/cli/commit/085e3b6e32acd3d2caea28e5531235ac4302ac0e))
* **resolve:** write the editor schema header to --output files (G1191) ([f7e4936](https://github.com/GantryDeploy/cli/commit/f7e493676f89428d8b4824b4c483931c0612f4fe))
* retry mutations safely with idempotency keys (G900) ([#6](https://github.com/GantryDeploy/cli/issues/6)) ([f6c8171](https://github.com/GantryDeploy/cli/commit/f6c81714f85b7721ec90bdf69c47ab5bc7cfbcbd))
* **run:** target a function with gantry run --function ([#18](https://github.com/GantryDeploy/cli/issues/18)) ([2e2c68b](https://github.com/GantryDeploy/cli/commit/2e2c68b0b2d1d7bc30f87712436a8febb8f3abb5))
* stream release and post-deploy command output in gantry lift and promote (G870) ([f7e4936](https://github.com/GantryDeploy/cli/commit/f7e493676f89428d8b4824b4c483931c0612f4fe))
* stream release step output in gantry lift (G990) ([f7e4936](https://github.com/GantryDeploy/cli/commit/f7e493676f89428d8b4824b4c483931c0612f4fe))
* **teardown:** list the routing a teardown removes or updates (G1213) ([f7e4936](https://github.com/GantryDeploy/cli/commit/f7e493676f89428d8b4824b4c483931c0612f4fe))
* use list and show subcommands for projects and clouds, matching other resources (G977) ([#13](https://github.com/GantryDeploy/cli/issues/13)) ([6982d75](https://github.com/GantryDeploy/cli/commit/6982d75a1171cb3cba151532ec3a4e4362eb11a2))


### Bug Fixes

* **bastions:** reach a private bastion through its own cloud's session service (G1156) ([f7e4936](https://github.com/GantryDeploy/cli/commit/f7e493676f89428d8b4824b4c483931c0612f4fe))
* build Docker images for the configured architecture (G1168) ([#14](https://github.com/GantryDeploy/cli/issues/14)) ([1bcd9f2](https://github.com/GantryDeploy/cli/commit/1bcd9f21fcd5eb474bd93f7a3c52260d8e227c1f))
* **clouds:** refuse a cloud's missing resource as a configuration that is not valid (G1176) ([f7e4936](https://github.com/GantryDeploy/cli/commit/f7e493676f89428d8b4824b4c483931c0612f4fe))
* **clouds:** say a cloud doesn't support a feature without promising it later (G1176) ([f7e4936](https://github.com/GantryDeploy/cli/commit/f7e493676f89428d8b4824b4c483931c0612f4fe))
* **deploy:** show a preview's versions by id in deploy status, the version picker and versions (G1123) ([f7e4936](https://github.com/GantryDeploy/cli/commit/f7e493676f89428d8b4824b4c483931c0612f4fe))
* **env:** label variables a preview copies from its parent environment (G1208) ([f7e4936](https://github.com/GantryDeploy/cli/commit/f7e493676f89428d8b4824b4c483931c0612f4fe))
* **lift:** cancel a deployment whose step no CLI could claim (G-961) ([f7e4936](https://github.com/GantryDeploy/cli/commit/f7e493676f89428d8b4824b4c483931c0612f4fe))
* **lift:** fail the service and release the deployment when a CLI step cannot be reported (G-959 G-968) ([f7e4936](https://github.com/GantryDeploy/cli/commit/f7e493676f89428d8b4824b4c483931c0612f4fe))
* **lift:** list each deployed path as written in gantry.yml, with its cache, in aligned columns (G1217) ([f7e4936](https://github.com/GantryDeploy/cli/commit/f7e493676f89428d8b4824b4c483931c0612f4fe))
* **lift:** report an unreachable API after ten polls instead of over an hour (G-964) ([f7e4936](https://github.com/GantryDeploy/cli/commit/f7e493676f89428d8b4824b4c483931c0612f4fe))
* **lift:** run each service's CLI step without pausing the other services (G-962 G-969) ([f7e4936](https://github.com/GantryDeploy/cli/commit/f7e493676f89428d8b4824b4c483931c0612f4fe))
* **lift:** time out a service after five minutes on a CLI step nobody is running (G-958) ([f7e4936](https://github.com/GantryDeploy/cli/commit/f7e493676f89428d8b4824b4c483931c0612f4fe))
* **lift:** wait for routing and report its failure when --from or --build ships an existing build ([f7e4936](https://github.com/GantryDeploy/cli/commit/f7e493676f89428d8b4824b4c483931c0612f4fe))
* require Node.js 22.22.2 or 24.15.0, matching @inquirer/prompts ([b1300f4](https://github.com/GantryDeploy/cli/commit/b1300f4720ec9b3dded1c51c0193d978fb7bab23))
* **rollback:** describe the default target as the latest earlier version with an older build (G1116) ([f7e4936](https://github.com/GantryDeploy/cli/commit/f7e493676f89428d8b4824b4c483931c0612f4fe))


### Dependencies

* bump minimatch to 11 to fix GHSA-g3hv-75wg-m249 ([085e3b6](https://github.com/GantryDeploy/cli/commit/085e3b6e32acd3d2caea28e5531235ac4302ac0e))
* bump the production group across 1 directory with 4 updates ([085e3b6](https://github.com/GantryDeploy/cli/commit/085e3b6e32acd3d2caea28e5531235ac4302ac0e))
* bump the production group across 1 directory with 5 updates ([#27](https://github.com/GantryDeploy/cli/issues/27)) ([522b31a](https://github.com/GantryDeploy/cli/commit/522b31ab2776f6a2e1904dfa4a5892484a9fa265))
* bump the production group across 1 directory with 7 updates ([b1300f4](https://github.com/GantryDeploy/cli/commit/b1300f4720ec9b3dded1c51c0193d978fb7bab23))

## [1.1.0](https://github.com/GantryDeploy/cli/compare/v1.0.0...v1.1.0) (2026-10-21)


### Features

* leave .env files out of deployments and add .gantryignore (G972) ([#4](https://github.com/GantryDeploy/cli/issues/4)) ([f567600](https://github.com/GantryDeploy/cli/commit/f56760028e59bfed2394181e17d9f9cc01563b72))

## 1.0.0 (2026-10-20)


### Features

* initial release ([d2c409b](https://github.com/GantryDeploy/cli/commit/d2c409b39201fa9b6c504d52965c298427781083))
