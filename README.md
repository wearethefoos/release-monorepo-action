# Release Action

A GitHub Action that creates SemVer releases based on conventional commits. This
action analyzes commit messages to determine version bumps and creates releases
accordingly.

## Features

- Automatically determines version bumps based on conventional commit messages
- Supports prereleases from pull requests
- Creates GitHub releases with changelogs
- Updates package versions in manifest files
- Handles multiple packages in a monorepo setup
- Tag pull requests to create prereleases

## Supported Package Formats

The action automatically detects and updates version information in the
following file types:

- **package.json** - For Node.js/JavaScript projects
- **Cargo.toml** - For Rust projects
- **pyproject.toml** - For Python projects (updates the `project.version` field)
- **version.txt** - For projects using a simple text file for versioning

The action will automatically detect which file type exists in each package
directory and update it accordingly.

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
| `git-user-name`           | The git user name to use for release commits created by this action                                                                                                                                                                                                                               | No       | `github-actions[bot]`                           |
| `git-user-email`          | The git user email to use for release commits created by this action                                                                                                                                                                                                                              | No       | `41898282+github-actions[bot]@users.noreply...` |

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
      - uses: actions/checkout@v4
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
      - uses: actions/checkout@v4
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
```

## Requirements

- **Git history**: The workflow must use `fetch-depth: 0` in
  `actions/checkout@v4` to fetch the full git history, which is necessary for
  analyzing commits and managing tags locally.
- **gh CLI**: The GitHub CLI is pre-installed and pre-authenticated on all
  GitHub-hosted runners via the `GH_TOKEN` environment variable, which is
  automatically set from the `token` input.

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
