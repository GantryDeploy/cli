# Changelog

## [1.2.0](https://github.com/GantryDeploy/cli/compare/v1.1.0...v1.2.0) (2026-11-06)


### Features

* **bastions:** verify host keys against the fingerprint Gantry recorded (G899) ([#8](https://github.com/GantryDeploy/cli/issues/8)) ([c788df0](https://github.com/GantryDeploy/cli/commit/c788df09820e478ab0dd4f56ca3c4e2e797093d8))
* **db:** add --no-master-rotation to gantry db create (G-640) ([ff14abf](https://github.com/GantryDeploy/cli/commit/ff14abf84b45d6645f8ba3b93e11d7386445e148))
* **db:** add gantry db adopt and gantry db users (G-644) ([#11](https://github.com/GantryDeploy/cli/issues/11)) ([ff14abf](https://github.com/GantryDeploy/cli/commit/ff14abf84b45d6645f8ba3b93e11d7386445e148))
* **db:** add gantry db rotate-user with --staged and --in-place to rotate a service database password ([085e3b6](https://github.com/GantryDeploy/cli/commit/085e3b6e32acd3d2caea28e5531235ac4302ac0e))
* **db:** add gantry db update to change a server's capacity, storage, backups and master password rotation ([085e3b6](https://github.com/GantryDeploy/cli/commit/085e3b6e32acd3d2caea28e5531235ac4302ac0e))
* **db:** send shared settings plus an aws section, rename --instance-class to --size and --multi-az to --high-availability ([085e3b6](https://github.com/GantryDeploy/cli/commit/085e3b6e32acd3d2caea28e5531235ac4302ac0e))
* **lift:** read cloud-neutral deploy task inputs (object-upload, objectKey, registry credentials, aws upload section) and take the artifact size limit from the server ([085e3b6](https://github.com/GantryDeploy/cli/commit/085e3b6e32acd3d2caea28e5531235ac4302ac0e))
* replace gantry console with gantry run, adding ECS support (G1164) ([#15](https://github.com/GantryDeploy/cli/issues/15)) ([429598a](https://github.com/GantryDeploy/cli/commit/429598a310d8d0fca1bdb4f1c6fd33d4b9a875f6))
* resolve each command's cloud from the cloud account, move AWS-only flags under --aws-*, key catalogs by cloud, read the bastion SSH user from the API and use cloud-neutral deploy task inputs ([085e3b6](https://github.com/GantryDeploy/cli/commit/085e3b6e32acd3d2caea28e5531235ac4302ac0e))
* retry mutations safely with idempotency keys (G900) ([#6](https://github.com/GantryDeploy/cli/issues/6)) ([f6c8171](https://github.com/GantryDeploy/cli/commit/f6c81714f85b7721ec90bdf69c47ab5bc7cfbcbd))
* use list and show subcommands for projects and clouds, matching other resources (G977) ([#13](https://github.com/GantryDeploy/cli/issues/13)) ([6982d75](https://github.com/GantryDeploy/cli/commit/6982d75a1171cb3cba151532ec3a4e4362eb11a2))


### Bug Fixes

* build Docker images for the configured architecture (G1168) ([#14](https://github.com/GantryDeploy/cli/issues/14)) ([1bcd9f2](https://github.com/GantryDeploy/cli/commit/1bcd9f21fcd5eb474bd93f7a3c52260d8e227c1f))


### Dependencies

* bump minimatch to 11 to fix GHSA-g3hv-75wg-m249 ([085e3b6](https://github.com/GantryDeploy/cli/commit/085e3b6e32acd3d2caea28e5531235ac4302ac0e))
* bump the production group across 1 directory with 4 updates ([085e3b6](https://github.com/GantryDeploy/cli/commit/085e3b6e32acd3d2caea28e5531235ac4302ac0e))

## [1.1.0](https://github.com/GantryDeploy/cli/compare/v1.0.0...v1.1.0) (2026-10-21)


### Features

* leave .env files out of deployments and add .gantryignore (G972) ([#4](https://github.com/GantryDeploy/cli/issues/4)) ([f567600](https://github.com/GantryDeploy/cli/commit/f56760028e59bfed2394181e17d9f9cc01563b72))

## 1.0.0 (2026-10-20)


### Features

* initial release ([d2c409b](https://github.com/GantryDeploy/cli/commit/d2c409b39201fa9b6c504d52965c298427781083))
