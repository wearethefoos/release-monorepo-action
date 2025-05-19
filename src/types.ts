export interface ReleaseConfig {
  manifestFile: string
  createPreReleases: boolean
  preReleaseLabel: string
}

export interface PackageManifest {
  [packagePath: string]: string
}

export interface ConventionalCommit {
  type: string
  scope?: string
  breaking: boolean
  message: string
  hash: string
}

export interface PackageChanges {
  path: string
  currentVersion: string
  newVersion: string
  commits: ConventionalCommit[]
  changelog: string
}

export interface ReleaseContext {
  isPullRequest: boolean
  isPreRelease: boolean
  shouldRelease: boolean
  pullRequestNumber?: number
  baseRef: string
  headRef: string
  owner: string
  repo: string
}

export type VersionBump = 'major' | 'minor' | 'patch' | 'none'

export interface VersionInfo {
  version: string
  isPreRelease: boolean
  preReleaseNumber?: number
}

export interface ReleaseResult {
  version: string
  preRelease: boolean
  changes: PackageChanges[]
}
