# Gantry CLI

The command line interface for [Gantry](https://gantrydeploy.com) - deploy applications to production in your own cloud account.

```bash
npm install -g @gantrydeploy/cli
gantry login
gantry lift production
```

Requires Node.js 22.13+ or 24+ (the current LTS lines).

## What this is for

Gantry builds and deploys containers, serverless functions, and static sites in your cloud account, managing the infrastructure they need.

Use the CLI locally or in CI with a `gantry.yml` configuration file.

- **Check and inspect** a config before anything is deployed - validate it, see the composed result after blueprints and variables resolve, and see which services and routes a deploy would produce.
- **Deploy** - build each service, upload what changed, provision the infrastructure the config asks for, and route traffic to the new version.
- **Control releases** - promote a version between environments, roll back, or shift traffic gradually.
- **Manage infrastructure** - networks, clusters, databases, caches, filesystems, load balancers, domains, secrets.
- **Access running services** - run a one-off command in a live service, or open a local tunnel to a database or cache through a bastion, so nothing private needs a public address.

## Documentation

**<https://gantrydeploy.com/docs>**: guides, the full command reference, and the `gantry.yml` configuration reference.

`gantry --help` lists every command; `gantry <command> --help` covers its flags and subcommands.

## Authentication

```bash
gantry login
```

Paste a personal token (`gpat_`) from the Console under **Settings → Tokens**. The CLI verifies it with the API and saves it to `~/.gantry/credentials`.

For CI, use a team token (`gnat_`) from **Team Settings → API Tokens** and set it as `GANTRY_API_TOKEN`. Team tokens have their own role and permissions and are not tied to an individual user.

If your personal token has access to multiple teams, use the global `--team` flag or `GANTRY_TEAM` for commands that don't identify a specific resource. Pass one of the team IDs listed by `gantry whoami`.

## Keeping secrets out of shell history

Values passed as flags land in shell history and are visible to other processes through the command line. Pipe secrets through stdin instead:

```bash
# Save a token without a prompt
printf '%s' "$TOKEN" | gantry login --token-stdin

# Create or update a secret from KEY=value lines
op read op://vault/app/env | gantry secrets create --cloud <id> --name app --from-file -
gantry secrets update <id> --from-file - < .env.production
```

`gantry secrets update` with `--set` or `--from-file` **replaces all keys** in the secret: any existing key you leave out is deleted. Before sending, the CLI compares your keys with the secret's current key names. If any would be removed, it lists their names (never values) and asks for confirmation. Without a terminal (CI, or values piped through `--from-file -`), pass `--yes` to confirm, or the update fails. An empty set of values (for example a file with only comments) is an error.

A `--from-file` file (or stdin) holds one `KEY=value` per line. LF and CRLF line endings and a leading UTF-8 BOM are accepted. Blank lines and lines starting with `#` (after any indentation) are skipped, and a leading `export ` is stripped from the key, so a shell-style `.env` works. Everything after the first `=` is the value, taken literally: quotes are kept as part of the value, and there is no escape or `${VAR}` expansion. `API_KEY="abc"` stores `"abc"` with the quotes.

`gantry login` with no flags still prompts with masked input, and `--token` / `--set` still work. When a secrets entry is malformed, the error names only its position (`--set #2`, `stdin line 4`), never its content. API errors mask Gantry tokens, `password`/`secret`/`token`/`value` fields, and any values you just submitted.

Two commands print secrets on purpose, because that is their job. Avoid running them where output is logged:

- `gantry databases credentials` prints the connection details, including the password.
- `gantry resolve` prints the resolved configuration, including variable values.

## What gets deployed

`gantry lift` copies your project into a staging directory and builds the deployment from that copy. Three things decide which files are copied:

1. **`.env` files are left out by default:** `.env` and `.env.*` in any directory, except `.env.example`. `gantry lift` names each file it left out. Put values your app needs at runtime in Gantry secrets.
2. **`.gitignore` files** are honoured the way git honours them: each applies to its own directory, and deeper files override their parents. Set `setup.use_gitignore: false` in `gantry.yml` to skip them, for example when the project gitignores WordPress core.
3. **`.gantryignore` files** use the same syntax, apply only to deployments, and are read whatever `use_gitignore` says. They are evaluated after every `.gitignore`, so a `.gantryignore` rule always wins.

Use `.gantryignore` to keep committed files out of a deployment, or to deploy a file that is otherwise left out:

```gitignore
# Ship the file a Next.js or Vite build reads
!.env.production

# Ship a plugin the repository gitignores
!wp-content/plugins/my-plugin.php

# Keep drafts out of the deployment
docs/drafts/
```

Within the rules, the last match wins. A file inside an ignored directory can't be re-included on its own, because the directory is never entered. Re-include the directory, ignore its contents, then re-include the file:

```gitignore
!vendor/
vendor/*
!vendor/autoload.php
```

`.git` and the `.gantry` staging directory are never copied.

## Tunnels and bastion host keys

`gantry databases tunnel` and `gantry caches tunnel` forward a local port through a bastion over SSH. The CLI checks the bastion's SSH host key before forwarding anything.

Gantry generates each bastion's host key when it provisions the bastion and returns the key's fingerprint with the bastion's SSH credentials. The CLI checks the key the bastion presents against that fingerprint, so even the first connection is verified and there is nothing to confirm. A key that doesn't match is refused, `--trust-host-key` included. `gantry bastions ssh` does the same by passing `ssh` a known_hosts file holding only that key.

Bastions provisioned before Gantry recorded host keys have no fingerprint until they are re-provisioned. For those, the CLI falls back to trust on first use, the way `ssh` does:

- **First connection to a bastion:** the CLI shows the key's fingerprint (`SHA256:...`, the same format `ssh-keygen -lf` prints) and asks `Trust this bastion? (y/N)`. If you answer yes, the fingerprint is saved. If you answer no, the tunnel is not opened.
- **Later connections:** the key must match the saved fingerprint. If it doesn't, the CLI refuses to open the tunnel and does not prompt. A changed key can mean someone is intercepting the connection.
- **No terminal (CI, scripts):** the CLI can't prompt, so an unknown key fails. Pass `--trust-host-key` to trust the key and save it on first connection. The fingerprint is still printed. The flag never overrides a mismatch.

Fingerprints are saved in `~/.gantry/known_hosts`. The directory is created with mode 0700 and the file with mode 0600. Each line is `<host id> <fingerprint>`. The host id is the bastion's EC2 instance id, so a rebuilt bastion is treated as a new host and prompts again rather than failing. If the instance id is not available, the host id is `bastion-<id>@<public IP>`.

To reset a bastion whose key legitimately changed, delete its line from `~/.gantry/known_hosts`. The mismatch error names the host id. The next tunnel will prompt again. To forget every bastion, delete the file.

## Bastion private keys

`gantry bastions key <slug> --output <path>` writes a bastion's SSH private key to a new file with mode 0600, and refuses to overwrite an existing file. If you print the key to stdout instead, set a restrictive umask first so the file is never world-readable:

```bash
(umask 077; gantry bastions key <slug> > ~/.ssh/<slug>.pem)
```

The command then prints the `ssh` commands for connecting by hand: one line adds the host key Gantry recorded to `~/.ssh/known_hosts`, and the connect line uses `StrictHostKeyChecking=yes`, so `ssh` refuses any other key.

## Environment variables

| Variable           | Purpose                                                     |
| ------------------ | ----------------------------------------------------------- |
| `GANTRY_API_TOKEN` | API token. Takes precedence over `~/.gantry/credentials`    |
| `GANTRY_TEAM`      | Which team to act in, for a token that covers more than one |
| `GANTRY_API_URL`   | API endpoint. Defaults to `https://api.gantrydeploy.com`    |

## Contributing

An `.nvmrc` is provided; run `nvm use` first.

```bash
npm install
npm run dev          # tsup --watch
npm link             # puts `gantry` on PATH from this working tree
npm test
npm run test:coverage
npm run lint
npm run typecheck
npm run test:package # pack the tarball and smoke-test the installed CLI
```

`npm run test:package` builds and packs the tarball exactly as a release does, installs it into an empty project, and runs the installed `gantry` bin. The release workflow publishes that same tarball, verified by checksum, rather than rebuilding.

### Pull requests and releases

Pull request titles must follow [Conventional Commits](https://www.conventionalcommits.org/), for example `fix: handle a missing gantry.yml` or `feat(secrets): read values from stdin`. PRs are squash-merged, so the title becomes the commit on `main`, and a required check validates it. Use `feat` for new behaviour, `fix` for bug fixes, and add `!` (`feat!: …`) or a `BREAKING CHANGE:` footer for incompatible changes.

Releases are automated with [release-please](https://github.com/googleapis/release-please). It keeps a release PR open that bumps the version and updates `CHANGELOG.md` from the merged PR titles. Merging that PR tags the release, and the release workflow runs the full check suite, packs the tarball once, smoke-tests it on every supported Node version, and publishes that exact tarball to npm with provenance after a maintainer approves the `release` environment.

Dependabot opens grouped update PRs weekly for npm dependencies and monthly for GitHub Actions (`.github/dependabot.yml`). Production dependency updates are titled `deps:` and cut a patch release; development dependency and action updates are titled `chore:` and `ci:` and do not.

`npm run test:coverage` enforces the thresholds in `vitest.config.ts`, and CI fails when coverage drops below them: at least 80% lines, branches, functions, and statements for `src/lib/**`, `src/commands/**`, and the package as a whole. Never lower them. On every CI run, the Node 24.x job writes a coverage table (totals and per file) to the run's summary page and uploads the full HTML report as the `coverage-report` artifact. Locally, open `coverage/index.html` after `npm run test:coverage`.

The CLI talks to Gantry's public GraphQL API and holds no platform logic of its own - configuration is parsed and resolved server-side, so this package stays a client.

GraphQL types are generated from a committed copy of the API schema:

```bash
npm run schema:sync
```

This downloads the API schema into `schema/public-api.graphql` and regenerates `src/generated/graphql.ts`. To regenerate types from the existing local schema, run `npm run codegen`. CI runs `npm run codegen:check`, which fails if the generated types differ from what is committed.

Bug reports and pull requests: <https://github.com/GantryDeploy/cli/issues>. Report security vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not as public issues.

## License

Apache-2.0
