import { VersionBump, ConventionalCommit } from './types.js'
import semver from 'semver'

const CONVENTIONAL_COMMIT_TYPES = {
  feat: 'minor',
  fix: 'patch',
  docs: 'none',
  style: 'none',
  refactor: 'patch',
  perf: 'patch',
  test: 'none',
  chore: 'none',
  revert: 'patch',
  ci: 'none',
  build: 'none'
} as const

export function parseConventionalCommit(message: string): ConventionalCommit {
  const conventionalCommitRegex =
    /^(?<type>feat|fix|docs|style|refactor|perf|test|chore|revert|ci|build)(?:\((?<scope>[^)]+)\))?(?<breaking>!)?: (?<message>.+)$/
  const match = message.match(conventionalCommitRegex)

  if (!match) {
    return {
      type: 'chore',
      breaking: false,
      message,
      hash: ''
    }
  }

  const { type, scope, breaking, message: commitMessage } = match.groups || {}
  return {
    type: type || 'chore',
    scope,
    breaking: Boolean(breaking),
    message: commitMessage || message,
    hash: ''
  }
}

export function determineVersionBump(
  commits: ConventionalCommit[]
): VersionBump {
  let highestBump: VersionBump = 'none'

  for (const commit of commits) {
    if (commit.breaking) {
      return 'major'
    }

    const bump = CONVENTIONAL_COMMIT_TYPES[
      commit.type as keyof typeof CONVENTIONAL_COMMIT_TYPES
    ] as VersionBump

    // Update highestBump if the current bump is higher
    if (
      bump === 'major' ||
      (bump === 'minor' && highestBump !== 'major') ||
      (bump === 'patch' && highestBump === 'none')
    ) {
      highestBump = bump
    }
  }

  return highestBump
}

export function calculateNewVersion(
  currentVersion: string,
  bump: VersionBump,
  isPreRelease: boolean,
  preReleaseNumber?: number
): string {
  const version = semver.parse(currentVersion)
  if (!version) {
    throw new Error(`Invalid version: ${currentVersion}`)
  }

  let newVersion = currentVersion
  switch (bump) {
    case 'major':
      newVersion = `${version.major + 1}.0.0`
      break
    case 'minor':
      newVersion = `${version.major}.${version.minor + 1}.0`
      break
    case 'patch':
      newVersion = `${version.major}.${version.minor}.${version.patch + 1}`
      break
    case 'none':
      // Keep current version
      break
  }

  if (isPreRelease) {
    newVersion = `${newVersion}-rc.${preReleaseNumber || 1}`
  }

  return newVersion
}

export function generateChangelog(commits: ConventionalCommit[]): string {
  const sections: { [key: string]: string[] } = {
    '🚀 Features': [],
    '🐛 Fixes': [],
    '📝 Documentation': [],
    '♻️ Refactors': [],
    '⚡️ Performance': [],
    '🧪 Tests': [],
    '🔧 Chores': [],
    '⏪ Reverts': [],
    '🔨 Build': [],
    '👷 CI': []
  }

  for (const commit of commits) {
    let section: string
    switch (commit.type) {
      case 'feat':
        section = '🚀 Features'
        break
      case 'fix':
        section = '🐛 Fixes'
        break
      case 'docs':
        section = '📝 Documentation'
        break
      case 'refactor':
        section = '♻️ Refactors'
        break
      case 'perf':
        section = '⚡️ Performance'
        break
      case 'test':
        section = '🧪 Tests'
        break
      case 'chore':
        section = '🔧 Chores'
        break
      case 'revert':
        section = '⏪ Reverts'
        break
      case 'build':
        section = '🔨 Build'
        break
      case 'ci':
        section = '👷 CI'
        break
      default:
        section = '🔧 Chores'
    }

    const message = commit.breaking
      ? `**BREAKING CHANGE:** ${commit.message}`
      : commit.message
    sections[section].push(`- ${message}`)
  }

  const changelog = Object.entries(sections)
    .filter(([_, items]) => items.length > 0)
    .map(([title, items]) => `### ${title}\n\n${items.join('\n')}`)
    .join('\n\n')

  return changelog
}
