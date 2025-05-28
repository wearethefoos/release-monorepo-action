export interface ReleaseConfig {
  manifestFile: string
  createPreReleases: boolean
  prereleaseLabel: string
  releaseTarget: string
}

export interface PackageTargetVersions {
  latest: string
  [target: string]: string
}

export interface PackageManifest {
  [packagePath: string]: PackageTargetVersions
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
  releaseTarget: string
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
  prereleaseNumber?: number
}

export interface ReleaseResult {
  version: string
  prerelease: boolean
  changes: PackageChanges[]
}
