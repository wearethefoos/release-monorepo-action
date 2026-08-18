# Release Action

A GitHub Action that creates SemVer releases based on conventional commits. This
action analyzes commit messages to determine version bumps and creates releases
accordingly.

## Features

- Automatically determines version bumps based on conventional commit messages
- Supports prereleases from pull requests
- Creates annotated Git release tags with changelogs (no GitHub Releases
  objects - see [Upgrading to v3](#upgrading-to-v3-breaking-changes))
- Updates package versions in manifest files
- Handles multiple packages in a monorepo setup
- Tag pull requests to create prereleases

## Upgrading to v3 (Breaking Changes)

Starting with v3, this action does almost all of its work with local `git` and
the `gh` CLI instead of the GitHub REST API, so it depends on far fewer npm
packages. This changes what your workflow needs to provide, and changes one
user-visible behavior:

- **`fetch-depth: 0` is now required, not just recommended.** Version bumps,
  changelogs, and tag lookups are computed from the local clone's commit history
  and tags. With the default shallow checkout (`fetch-depth: 1`, the
  `actions/checkout` default), this action will compute wrong version bumps or
  miss existing release tags entirely, some of which fail silently rather than
  erroring. See [Requirements](#requirements) below.
- **GitHub Releases are no longer created.** Releases are now plain annotated
  Git tags (`git tag -a`, with the changelog as the tag message) pushed straight
  to the repository - there's no more entry on the repository's "Releases" page
  or `GET /repos/{owner}/{repo}/releases` response. If any of your own tooling
  reads GitHub Releases (not tags) for this repository, point it at tags instead
  (e.g. `git tag -l` or `gh api repos/{owner}/{repo}/tags`).
- **New `issues: write` permission is required**, in addition to the
  `contents: write` and `pull-requests: write` this action already needed - see
  [Workflow Permissions](#workflow-permissions).
- **New `overwrite-existing-tags` input**, currently defaulting to `true` to
  match this action's pre-v3 behavior, but that default is deprecated and will
  change to `false` in a future release. Set it explicitly now (either way) so a
  future upgrade doesn't silently change what happens on a tag collision - see
  [Inputs](#inputs).
- **`cargo` is required on the runner if your repository has Cargo.toml
  packages** (to keep Cargo.lock in sync after a version bump - see
  [Supported Package Formats](#supported-package-formats)); **`gh` is required**
  for pull request, label, and comment operations, but it's pre-installed and
  pre-authenticated on GitHub-hosted runners already, so most workflows need no
  changes for this one - see [Requirements](#requirements).

## Supported Package Formats

The action automatically detects and updates version information in the
following file types:

- **package.json** - For Node.js/JavaScript projects
- **Cargo.toml** - For Rust projects
- **pyproject.toml** - For Python projects (updates the `project.version` field)
- **version.txt** - For projects using a simple text file for versioning

The action will automatically detect which file type exists in each package
directory and update it accordingly.

Cargo.toml and pyproject.toml are updated with a targeted edit of just the
`version` field's value, not a full parse/reformat, so comments, key order, and
existing formatting are left exactly as they were - no separate formatting step
is needed afterward. If a changed package has a Cargo.lock (either its own, for
a standalone crate, or a shared one at the repository root, for a Cargo
workspace), it's refreshed via `cargo update --workspace` as part of the same
release commit, so it never goes stale relative to the bumped Cargo.toml
version. This requires `cargo` to be available on the runner (and any private
registry authentication your workspace needs to already be configured) whenever
the repository contains Cargo.toml packages.

## Inputs

| Input                     | Description                                                                                                                                                                                                                                                                                       | Required | Default                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------- |
| `token`                   | GitHub token for authentication                                                                                                                                                                                                                                                                   | Yes      | -                                               |
| `root-dir`                | Root directory for the release                                                                                                                                                                                                                                                                    | Yes      | `.`                                             |
| `manifest-file`           | Path to the manifest file containing package versions                                                                                                                                                                                                                                             | Yes      | `.release-manifest.json`                        |
| `create-prereleases`      | Whether to create prereleases from pull requests                                                                                                                                                                                                                                                  | No       | `false`                                         |
| `prerelease-label`        | The PR label to use for prereleases                                                                                                                                                                                                                                                               | No       | `Prerelease`                                    |
| `release-target`          | The target environment to release to (e.g. main, canary, aws). Cannot be "latest"                                                                                                                                                                                                                 | No       | `main`                                          |
| `overwrite-existing-tags` | Whether to force-move a release tag that already exists to the current commit instead of failing the run. **Deprecated:** defaults to `true` for now (matching pre-2.x behavior); this default will change to `false` in a future release, so set it explicitly to avoid a later behavior change. | No       | `true`                                          |
| `indentation`             | The indentation to use for JSON files, can be "tab" or a number of spaces. Default is 2 spaces.                                                                                                                                                                                                   | No       | `'2'`                                           |
| `git-user-name`           | The Git username to use for release commits created by this action                                                                                                                                                                                                                                | No       | `github-actions[bot]`                           |
| `git-user-email`          | The Git user email to use for release commits created by this action                                                                                                                                                                                                                              | No       | `41898282+github-actions[bot]@users.noreply...` |

## Outputs

| Output             | Description                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `releases-created` | Whether one or more releases were created                                                                                   |
| `version`          | The version that was released                                                                                               |
| `prerelease`       | Whether the release was a prerelease                                                                                        |
| `versions`         | JSON formatted Array of versions (path, version, and whether it was a prerelease) that were released (e.g. from a monorepo) |

## Manifest File Format

The manifest file should be a JSON file that lists all possible packages to
release in the format:

```json
{
  "path/to/package": {
    "latest": "1.0.0",
    "main": "0.9.33",
    "canary": "1.0.0"
  },
  "another/package": {
    "latest": "1.1.0",
    "main": "1.1.0"
  }
}
```

## Usage

### Basic Usage

```yaml
name: Release

on:
  push:
    branches:
      - main
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0

      - uses: wearethefoos/release-action@v1
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
```

### With Prereleases

```yaml
name: Release

on:
  push:
    branches:
      - main
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0

      - uses: wearethefoos/release-action@v1
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          create-prereleases: true
          # Add this label to a PR to create prereleases for it
          prerelease-label: 'Prerelease'
```

## Workflow Permissions

This action requires the following permissions in your workflow:

```yaml
permissions:
  contents: write # For creating commits, tags, and pushing to main
  pull-requests: write # For creating and updating release PRs, adding labels, and posting comments
  issues: write # For adding labels to the PR (the labels API is an Issues-scoped endpoint even for PRs)
```

## Requirements

- **Git history**: The workflow must use `fetch-depth: 0` in
  `actions/checkout@v6` to fetch the full Git history, which is necessary for
  analyzing commits and managing tags locally.
- **gh CLI**: The GitHub CLI is pre-installed and pre-authenticated on all
  GitHub-hosted runners via the `GH_TOKEN` environment variable, which is
  automatically set from the `token` input.
- **cargo**: Only needed if the repository contains Cargo.toml packages - used
  to refresh Cargo.lock after a version bump (see
  [Supported Package Formats](#supported-package-formats)). Not pre-installed on
  standard GitHub-hosted runners; add a Rust toolchain setup step (and any
  private registry authentication your workspace needs) before this action if
  you release Rust packages.

## How It Works

1. The action checks if it's running on a pull request or the main branch
1. For merges / commits to main:
   - It gathers commit info to determine the version bump (see below)
   - It creates a release PR with the changes to the package versions,
     changelogs, and manifest.
   - If the merge / commit was from a release PR, it creates releases and
     outputs the versioning info.
1. For pull requests:
   - If `create-prereleases` is false, it exits
   - If the PR is tagged with the prerelease label, it creates a prerelease and
     outputs the versioning info.
1. For each package in the manifest:
   - Gathers commits since the last merge to main
   - Parses conventional commit messages
   - Determines version bump based on commit types
   - Generates changelog
1. Creates a release with:
   - Updated package versions
   - Generated changelog
   - GitHub release and tags

## Conventional Commit Types

The action supports the following conventional commit types:

- `feat`: Minor version bump
- `fix`: Patch version bump
- `docs`: No version bump
- `style`: No version bump
- `refactor`: Patch version bump
- `perf`: Patch version bump
- `test`: No version bump
- `chore`: No version bump
- `revert`: Patch version bump
- `ci`: No version bump
- `build`: No version bump

Breaking changes (indicated by `!` in the commit message) will trigger a major
version bump.

## License

MIT
