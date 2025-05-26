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

## Inputs

| Input                | Description                                           | Required | Default                  |
| -------------------- | ----------------------------------------------------- | -------- | ------------------------ |
| `token`              | GitHub token for authentication                       | Yes      | -                        |
| `root-dir`           | Root directory for the release                        | Yes      | `.`                      |
| `manifest-file`      | Path to the manifest file containing package versions | Yes      | `.release-manifest.json` |
| `create-prereleases` | Whether to create prereleases from pull requests      | No       | `false`                  |
| `prerelease-label`   | The PR label to use for prereleases                   | No       | `Prerelease`             |

## Outputs

| Output       | Description                                            |
| ------------ | ------------------------------------------------------ |
| `version`    | The version that was released                          |
| `prerelease` | Whether the release was a prerelease                   |
| `versions`   | The versions that were released (e.g. from a monorepo) |

## Manifest File Format

The manifest file should be a JSON file that lists all possible packages to
release in the format:

```json
{
  "path/to/package": "1.0.0",
  "another/package": "2.1.0"
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
          manifest-file: '.release-manifest.json'
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
          manifest-file: '.release-manifest.json'
          create-prereleases: true
          prerelease-label: 'Prerelease'
```

## How It Works

1. The action checks if it's running on a pull request or the main branch
2. For pull requests:
   - If `create-prereleases` is false, it exits
   - If the PR is tagged with the prerelease label, it creates a prerelease
   - If the PR is tagged with "release-me", it creates a full release
3. For each package in the manifest:
   - Gathers commits since the last merge to main
   - Parses conventional commit messages
   - Determines version bump based on commit types
   - Generates changelog
4. Creates a release with:
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
