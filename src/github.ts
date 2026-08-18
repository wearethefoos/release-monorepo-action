import * as core from '@actions/core'
import {
  ReleaseContext,
  PackageChanges,
  PackageManifest,
  PackageTargetVersions
} from './types.js'
import * as fs from 'fs'
import * as path from 'path'
import { determineVersionBump, parseConventionalCommit } from './version.js'
import { basename } from 'path'
import { getActionContext } from './context.js'
import * as git from './git.js'
import * as gh from './gh.js'

interface CommitFile {
  filename: string
  status: string
  additions: number
  deletions: number
  changes: number
}

interface Commit {
  sha: string
  commit: {
    message: string
  }
  files?: CommitFile[]
}

/**
 * Replaces the `version = "..."` field inside a TOML file's top-level
 * `[tableName]` table (e.g. Cargo.toml's `[package]`, pyproject.toml's
 * `[project]`) via a targeted string replacement, rather than a full
 * parse-and-reserialize round trip. A round trip through a TOML
 * stringifier reformats the whole file -- reordering keys, dropping
 * comments, changing quote/whitespace style -- which was forcing consumers
 * to run a separate formatter (e.g. `taplo fmt`) after every release PR
 * just to undo it. This only ever touches the exact characters between the
 * version field's quotes, so everything else in the file, including
 * comments and dependency version specifiers elsewhere in the document, is
 * untouched byte-for-byte.
 *
 * Returns null (leaving the file alone, matching the old
 * `if (parsed.package)`-guarded behavior) when the file has no
 * `[tableName]` table or no `version` field within it -- e.g. a Cargo
 * workspace root that only has a `[workspace]` table.
 */
function replaceTomlVersion(
  content: string,
  tableName: string,
  newVersion: string
): string | null {
  const headerRegex = new RegExp(
    `^\\[${tableName}\\][ \\t]*(?:#.*)?[ \\t]*\\r?\\n`,
    'm'
  )
  const headerMatch = headerRegex.exec(content)
  if (!headerMatch) {
    return null
  }

  // The section runs until the next top-level table header (`[...]`, not
  // `[[...]]`... a `[[` line still starts with `[` so this also correctly
  // stops there) or end of file.
  const sectionStart = headerMatch.index + headerMatch[0].length
  const rest = content.slice(sectionStart)
  const nextHeaderMatch = /^\[[^\]]*\]/m.exec(rest)
  const sectionEnd =
    nextHeaderMatch === null
      ? content.length
      : sectionStart + nextHeaderMatch.index

  const section = content.slice(sectionStart, sectionEnd)
  const versionRegex = /^version[ \t]*=[ \t]*(["'])([^"']*)\1/dm
  const versionMatch = versionRegex.exec(section)
  if (!versionMatch?.indices) {
    return null
  }

  const [valueStart, valueEnd] = versionMatch.indices[2]
  const absoluteStart = sectionStart + valueStart
  const absoluteEnd = sectionStart + valueEnd

  return (
    content.slice(0, absoluteStart) + newVersion + content.slice(absoluteEnd)
  )
}

/**
 * Thin facade over local git operations (src/git.ts) and the `gh` CLI
 * (src/gh.ts). Public method names and signatures are unchanged from the
 * previous Octokit-backed implementation so callers (src/main.ts) and their
 * tests survive untouched; internals are synchronous git/gh calls wrapped in
 * `async` methods for API compatibility.
 */
export class GitHubService {
  private releaseContext: ReleaseContext

  constructor(token: string) {
    this.releaseContext = getActionContext()
    gh.configureGh(
      token,
      `${this.releaseContext.owner}/${this.releaseContext.repo}`
    )
    git.configureGitAuth(token)
    git.fetchTags()
  }

  public async onMainBranch(): Promise<boolean> {
    if (this.releaseContext.headRef === 'refs/heads/main') {
      core.debug('On main branch')
      return true
    }

    core.debug(`On branch ${this.releaseContext.headRef}`)
    return false
  }

  public async isDeletedReleaseBranch(target: string): Promise<boolean> {
    if (this.releaseContext.headRef !== `release-${target}`) {
      return false
    }

    return !git.remoteBranchExists(`release-${target}`)
  }

  async getCommitCount(ref: string = 'HEAD'): Promise<number> {
    const resolved = git.resolveRef(ref) ?? 'HEAD'
    return git.getCommitCount(resolved)
  }

  async getPullRequestLabels(): Promise<string[]> {
    if (
      !this.releaseContext.isPullRequest ||
      !this.releaseContext.pullRequestNumber
    ) {
      return []
    }

    const pr = gh.getPullRequest(this.releaseContext.pullRequestNumber)
    return pr ? pr.labels : []
  }

  getPullRequestNumberFromContext(): number | null {
    if (
      !this.releaseContext.isPullRequest ||
      !this.releaseContext.pullRequestNumber
    ) {
      return null
    }

    return this.releaseContext.pullRequestNumber
  }

  async isPullRequestMerged(): Promise<boolean> {
    if (
      !this.releaseContext.isPullRequest ||
      !this.releaseContext.pullRequestNumber
    ) {
      return false
    }

    const pr = gh.getPullRequest(this.releaseContext.pullRequestNumber)
    return pr ? pr.merged : false
  }

  private generateReleasePRTitle(changes: PackageChanges[]): string {
    if (changes.length === 1) {
      const change = changes[0]
      if (change.path === '.') {
        return `chore: release ${change.newVersion}`
      } else {
        return `chore: release ${change.name}@${change.newVersion}`
      }
    } else {
      return `chore: release ${changes[0].releaseTarget}`
    }
  }

  /**
   * Fails fast (matching the old repos.getBranch behavior) when origin/main
   * cannot be resolved locally.
   */
  private getMainSha(): string {
    const sha = git.getRemoteBranchSha('main')
    if (!sha) {
      throw new Error('Could not resolve origin/main SHA')
    }
    return sha
  }

  async createReleasePullRequest(
    changes: PackageChanges[],
    label: string = 'release-me',
    manifestFile: string = '.release-manifest.json'
  ): Promise<void> {
    // Determine PR title and commit message
    const title = this.generateReleasePRTitle(changes)
    const commitMessage = title

    // Create a new branch with the format 'release-<target>'
    const branchName = `release-${changes[0].releaseTarget}`

    // Ensure origin/main exists before doing any work
    this.getMainSha()

    // Update package versions and changelogs locally
    const files: git.CommitFileEntry[] = []
    // Directories whose Cargo.toml just changed -- used below to find and
    // refresh any Cargo.lock (standalone crate, or a shared workspace lock
    // at the repo root) so consumers no longer need a separate workflow to
    // keep it in sync after a version bump.
    const changedCargoTomlDirs = new Set<string>()
    for (const change of changes) {
      await this.updatePackageVersion(change.path, change.newVersion)

      // Add the updated version file to the set of files to commit
      for (const filePath of [
        path.join(change.path, 'package.json'),
        path.join(change.path, 'Cargo.toml'),
        path.join(change.path, 'version.txt')
      ]) {
        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath, 'utf-8')
          files.push({ path: filePath, content })
          if (filePath.endsWith('Cargo.toml')) {
            changedCargoTomlDirs.add(change.path)
          }
        }
      }

      // Add/update the changelog
      const changelogPath = path.join(change.path, 'CHANGELOG.md')
      let changelogContent = ''
      if (fs.existsSync(changelogPath)) {
        changelogContent = fs.readFileSync(changelogPath, 'utf-8')
      }

      // Ensure the changelog starts with a level 1 heading
      const packageName =
        change.path === '.'
          ? 'Changelog'
          : `${change.name.charAt(0).toUpperCase() + change.name.slice(1)} Changelog`
      if (!changelogContent.startsWith('# ')) {
        changelogContent = `# ${packageName}\n\n${changelogContent}`
      }

      // Add the new version section after the level 1 heading
      const compareLink = `https://github.com/${this.releaseContext.owner}/${this.releaseContext.repo}/compare/${change.path === '.' ? '' : `${change.name}-`}v${change.currentVersion}...${change.path === '.' ? '' : `${change.name}-`}v${change.newVersion}`
      const newVersionSection = `## [${change.newVersion}](${compareLink}) (${new Date().toISOString().split('T')[0]})\n\n${change.changelog}\n`
      const lines = changelogContent.split('\n')
      const headingIndex = lines.findIndex((line) => line.startsWith('# '))
      if (headingIndex !== -1) {
        lines.splice(headingIndex + 2, 0, newVersionSection)
        changelogContent = lines.join('\n')
      } else {
        changelogContent = newVersionSection + changelogContent
      }

      files.push({
        path: changelogPath,
        content: changelogContent.trimEnd() + '\n'
      })
    }

    // Update the release manifest
    const manifestPath = manifestFile
    let manifestContent = '{}'
    if (fs.existsSync(manifestPath)) {
      manifestContent = fs.readFileSync(manifestPath, 'utf-8')
    }
    const manifest = JSON.parse(manifestContent)
    await this.updateManifest(manifest, changes, changes[0].releaseTarget)
    const indentation = core.getInput('indentation') ?? '2'
    const indent =
      indentation === 'tab' ? '\t' : ' '.repeat(parseInt(indentation))
    const formattedManifestJSON =
      JSON.stringify(manifest, null, 2).replace(/ {2}/g, indent) + '\n'
    files.push({ path: manifestPath, content: formattedManifestJSON })

    // Refresh Cargo.lock wherever a changed Cargo.toml's version bump would
    // leave it stale: the crate's own directory (a standalone crate with
    // its own lockfile) and the repo root (a shared workspace lockfile),
    // whichever of those actually have a Cargo.lock. `cargo update
    // --workspace` is the standard way to resync a lockfile's own-package
    // version entries after a manual Cargo.toml edit -- Cargo.lock embeds
    // resolved checksums/dependency-graph data that can't be hand-patched
    // the way Cargo.toml's `version` field can.
    const cargoLockDirs = new Set<string>()
    if (changedCargoTomlDirs.size > 0) {
      for (const dir of ['.', ...changedCargoTomlDirs]) {
        if (fs.existsSync(path.join(dir, 'Cargo.lock'))) {
          cargoLockDirs.add(dir)
        }
      }
    }
    const postWriteCommands: git.CommitPostWriteCommand[] = [
      ...cargoLockDirs
    ].map((cwd) => ({
      cwd,
      file: 'cargo' as const,
      args: ['update', '--workspace']
    }))

    // Commit the files to the release branch (creates or force-updates it)
    git.commitFilesToBranch({
      branch: branchName,
      baseRef: 'origin/main',
      message: commitMessage,
      files,
      postWriteCommands,
      userName: core.getInput('git-user-name'),
      userEmail: core.getInput('git-user-email')
    })

    // Create or update the PR. The old pulls.list `labels` filter param was
    // a silent no-op on GitHub's API, so filtering is (and always
    // effectively was) primarily by head branch.
    const existingPRs = gh.listOpenPullRequests(branchName)

    const body = this.generatePullRequestBody(changes)

    if (existingPRs.length > 0) {
      // Update existing PR
      gh.updatePullRequest(existingPRs[0].number, title, body)

      if (!existingPRs[0].labels.includes(label)) {
        gh.addLabels(existingPRs[0].number, [
          label,
          `release-target:${changes[0].releaseTarget}`
        ])
      }
    } else {
      // Create new PR
      const newPrNumber = gh.createPullRequest({
        title,
        body,
        head: branchName,
        base: 'main'
      })

      gh.addLabels(newPrNumber, [
        label,
        `release-target:${changes[0].releaseTarget}`
      ])
    }
  }

  private generateVersionBumpPRTitle(changes: PackageChanges[]): string {
    if (changes.length === 1) {
      const change = changes[0]
      return `chore: bump ${change.releaseTarget} to ${change.path}@${change.newVersion}`
    } else {
      return `chore: bump ${changes[0].releaseTarget} to latest`
    }
  }

  async createVersionBumpPullRequest(
    changes: PackageChanges[],
    label: string = 'release-me',
    manifestFile: string = '.release-manifest.json'
  ): Promise<void> {
    // Determine PR title and commit message
    const title = this.generateVersionBumpPRTitle(changes)
    const commitMessage = title

    // Create a new branch with the format 'release-<target>'
    const branchName = `release-${changes[0].releaseTarget}`

    // Ensure origin/main exists before doing any work
    this.getMainSha()

    // Update the release manifest
    const manifestPath = manifestFile

    const manifest = await this.getManifestFromMain(
      manifestFile,
      core.getInput('root-dir') ?? '.'
    )
    await this.updateManifest(manifest, changes, changes[0].releaseTarget)
    const updatedManifestContent = JSON.stringify(manifest, null, 2) + '\n'

    const files: git.CommitFileEntry[] = [
      { path: manifestPath, content: updatedManifestContent }
    ]

    // Commit the files to the release branch (creates or force-updates it)
    git.commitFilesToBranch({
      branch: branchName,
      baseRef: 'origin/main',
      message: commitMessage,
      files,
      userName: core.getInput('git-user-name'),
      userEmail: core.getInput('git-user-email')
    })

    // Create or update the PR
    const existingPRs = gh.listOpenPullRequests(branchName)

    const body = this.generatePullRequestBody(changes)

    if (existingPRs.length > 0) {
      // Update existing PR
      gh.updatePullRequest(existingPRs[0].number, title, body)

      if (!existingPRs[0].labels.includes(label)) {
        gh.addLabels(existingPRs[0].number, [
          label,
          `release-target:${changes[0].releaseTarget}`
        ])
      }
    } else {
      // Create new PR
      const newPrNumber = gh.createPullRequest({
        title,
        body,
        head: branchName,
        base: 'main'
      })

      gh.addLabels(newPrNumber, [
        label,
        `release-target:${changes[0].releaseTarget}`
      ])
    }
  }

  async removeLabel(label: string, prNumber: number): Promise<void> {
    gh.removeLabel(prNumber, label)
  }

  async addLabel(label: string, prNumber: number): Promise<void> {
    // If we're adding the 'released' label, remove the 'release-me' label
    if (label === 'released') {
      try {
        await this.removeLabel('release-me', prNumber)
      } catch (error) {
        core.warning(`Failed to remove release-me label: ${error}`)
      }
    }

    gh.addLabels(prNumber, [label])
  }

  private generatePullRequestBody(changes: PackageChanges[]): string {
    return changes
      .map((change) => {
        return `## ${change.path === '.' ? 'Changelog' : `${change.name.charAt(0).toUpperCase() + change.name.slice(1)} Changelog`} (${change.currentVersion} -> ${change.newVersion})\n\n${change.changelog}`
      })
      .join('\n\n')
  }

  async createRelease(
    changes: PackageChanges[],
    prerelease: boolean = false,
    overwriteExistingTags: boolean = true
  ): Promise<void> {
    const manifest = await this.getManifestFromMain(
      core.getInput('manifest-file') ?? '.release-manifest.json',
      core.getInput('root-dir') ?? '.'
    )

    const versions = []

    for (const change of changes) {
      const newVersion = prerelease
        ? change.newVersion
        : manifest[change.path][change.releaseTarget]

      const versionBase = `v${newVersion}`
      const tagName =
        change.path === '.'
          ? versionBase
          : `${basename(change.path)}-${versionBase}`
      const releaseName =
        change.path === '.'
          ? versionBase
          : `${basename(change.path)} ${versionBase}`

      // Create the annotated tag (replaces the old refs/tags createRef +
      // repos.createRelease pair). The tag message is the changelog -
      // GitHub Releases are no longer created at all.
      if (git.tagExists(tagName)) {
        if (!overwriteExistingTags) {
          // Hard failure, not a silent skip: continuing past this would
          // either leave the tag unreleased while the action still claims
          // success, or (if we kept looping) leave a partial/inconsistent
          // set of tags pushed for a multi-package release. Abort
          // immediately so the run fails loudly via main's catch, before
          // any releases-created/version/versions output is set.
          throw new Error(
            `Tag ${tagName} already exists. Refusing to overwrite it. Set ` +
              `the "overwrite-existing-tags" input to "true" to allow ` +
              `force-moving existing tags to the current commit.`
          )
        }

        core.info(
          `Tag ${tagName} already exists; overwriting it to point at ${this.releaseContext.sha} (overwrite-existing-tags is enabled)`
        )
        git.createAnnotatedTag(
          tagName,
          change.changelog || releaseName,
          this.releaseContext.sha,
          true
        )
        git.pushTag(tagName, true)
      } else {
        core.info(`Creating release ${releaseName}`)
        git.createAnnotatedTag(
          tagName,
          change.changelog || releaseName,
          this.releaseContext.sha
        )
        git.pushTag(tagName)
      }

      versions.push({
        name: basename(change.path),
        path: change.path,
        version: newVersion,
        prerelease: !!prerelease
      })
    }

    if (versions.length === 1) {
      const version = versions[0]
      core.setOutput('version', version.version)
    }

    core.setOutput('prerelease', prerelease)
    core.setOutput('versions', JSON.stringify(versions))

    core.info(
      `Versions on ${changes[0].releaseTarget} bumped to ${versions
        .map((version) => `${version.name}-v${version.version}`)
        .join(', ')}`
    )
  }

  /**
   * Check if a tag name is a prerelease tag.
   */
  private isPrereleaseTag(tagName: string): boolean {
    return (
      tagName.includes('-rc.') ||
      tagName.includes('-alpha') ||
      tagName.includes('-beta') ||
      tagName.includes('-pre')
    )
  }

  /**
   * Get the most recent non-prerelease tag (for any package). Replaces the
   * old hybrid tags-then-Releases-API lookup now that Releases are dropped
   * entirely.
   */
  private getLatestReleaseTag(): string | null {
    const tags = git.listTagsByDateDesc()
    const tag = tags.find((tagName) => !this.isPrereleaseTag(tagName))
    return tag ?? null
  }

  /**
   * Fetch all commits (with files) since the last release (or fallback) for the repo.
   * Returns the array of commits (with files) for further filtering.
   */
  async getAllCommitsSinceLastRelease(
    checkPaths: boolean = true
  ): Promise<Commit[]> {
    // Get the most recent non-prerelease release tag (for any package)
    const lastReleaseTag = this.getLatestReleaseTag()

    // If no release found, get commits since the beginning
    let base: string
    if (lastReleaseTag) {
      base = lastReleaseTag
    } else {
      // Get total commit count and use that to look back
      const totalCommits = await this.getCommitCount()
      const lookbackCount = Math.min(50, totalCommits)
      base = `HEAD~${lookbackCount - 1}`
    }

    const head = git.resolveRef(this.releaseContext.headRef) ?? 'HEAD'

    core.info(
      `Getting all commits since last release with base ${base} and head ${head}...`
    )

    const gitCommits = git.getCommitsBetween(base, head, checkPaths)

    // Filter commits to only include those that would be relevant for a
    // version bump
    const commits: Commit[] = gitCommits
      .filter((commit) => {
        core.debug(commit.message.split('\n')[0])

        const conventionalCommit = parseConventionalCommit(commit.message)

        return determineVersionBump([conventionalCommit]) !== 'none'
      })
      .map((commit) => ({
        sha: commit.sha,
        commit: { message: commit.message },
        files: commit.files.map((filename) => ({
          filename,
          status: '',
          additions: 0,
          deletions: 0,
          changes: 0
        }))
      }))

    core.info(`Total commits found: ${commits.length}`)
    return commits
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  async getLastReleaseVersion(packagePath: string): Promise<string | null> {
    try {
      return this.getLastReleaseVersionFromTags(packagePath)
    } catch (error) {
      console.warn('Error getting last release version:', error)
      return null
    }
  }

  private getLastReleaseVersionFromTags(packagePath: string): string | null {
    const tags = git.listTagsByDateDesc()

    // Find the most recent non-prerelease tag for this package
    const lastTag = tags.find((tagName) => {
      // Skip prerelease tags
      if (this.isPrereleaseTag(tagName)) {
        return false
      }

      if (packagePath === '.') {
        // For root package, look for tags without package prefix
        return !tagName.includes('/') && tagName.startsWith('v')
      } else {
        // For specific packages, look for tags with package prefix
        const packageName = basename(packagePath)
        return tagName.startsWith(`${packageName}-v`)
      }
    })

    return lastTag ?? null
  }

  async getLatestRcVersion(
    packagePath: string,
    baseVersion: string
  ): Promise<number> {
    try {
      const latestRcFromTags = this.getLatestRcVersionFromTags(
        packagePath,
        baseVersion
      )
      return (latestRcFromTags ?? 0) + 1 // Return next RC number
    } catch (error) {
      console.warn('Error getting latest RC version:', error)
      return 1 // Default to RC.1 if error
    }
  }

  /**
   * Finds the latest RC number for a package's base version. FIXED (bug
   * present in the old Octokit implementation): the regex is now built from
   * basename(packagePath) - matching how tags are actually named in
   * createRelease() - rather than the raw packagePath, and is anchored with
   * escaped dots so it cannot match unrelated tags.
   *
   * ALSO FIXED: for the root package, packagePath is '.', so
   * basename('.') is '.' -- that produced the regex `^\.-v...`, which can
   * never match, because createRelease() tags the root package with NO
   * prefix at all (`v<version>-rc.<n>`, only subpackages get a
   * `<basename>-` prefix). Root RC lookup therefore always returned null
   * (-> RC.1) here, and combined with the tag-already-exists guard in
   * createRelease, every prerelease after the first for the same root base
   * version collided with the existing v<version>-rc.1 tag.
   */
  private getLatestRcVersionFromTags(
    packagePath: string,
    baseVersion: string
  ): number | null {
    const tags = git.listTagsByDateDesc()
    const escapedBaseVersion = this.escapeRegExp(baseVersion)
    const rcRegex =
      packagePath === '.'
        ? new RegExp(`^v${escapedBaseVersion}-rc\\.(\\d+)$`)
        : new RegExp(
            `^${this.escapeRegExp(basename(packagePath))}-v${escapedBaseVersion}-rc\\.(\\d+)$`
          )

    const latestRc = tags
      .filter((tagName) => rcRegex.test(tagName))
      .map((tagName) => {
        const match = tagName.match(rcRegex)
        return match ? parseInt(match[1], 10) : 0
      })
      .sort((a, b) => b - a)[0]

    return latestRc || null
  }

  async getChangelogForPackage(packagePath: string): Promise<string> {
    try {
      const changelogPath = path.join(packagePath, 'CHANGELOG.md')
      const content = git.getFileAtRef('origin/main', changelogPath)

      if (content === null) {
        return ''
      }

      const lines = content.split('\n')

      // Find the first version section
      const versionIndex = lines.findIndex((line) => line.startsWith('## '))
      if (versionIndex === -1) return ''

      // Get everything up to the next version section or end of file
      const nextVersionIndex = lines.findIndex(
        (line, i) => i > versionIndex && line.startsWith('## ')
      )
      const endIndex = nextVersionIndex === -1 ? lines.length : nextVersionIndex

      return lines.slice(versionIndex, endIndex).join('\n').trim()
    } catch (error) {
      core.warning(`Failed to get changelog for ${packagePath}: ${error}`)
      return ''
    }
  }

  async findReleasePRByVersions(
    manifest: PackageManifest,
    releaseTarget: string
  ): Promise<number | null> {
    try {
      // Get the most recently updated closed PRs. Matching is
      // title-primary: gh's --label filter (unlike the old octokit
      // pulls.list, whose labels param was a silent no-op) actually
      // filters server-side, so applying it here as a hard requirement
      // would miss release PRs whose labels never got applied (e.g. a
      // failed addLabels call after merge, or a consumer-supplied custom
      // label). Labels are therefore used only as a secondary/bonus signal
      // below, matching the old effective behavior.
      const prs = gh.listClosedReleasePullRequests(10)

      // Convert manifest to PackageChanges format
      const changes: PackageChanges[] = Object.entries(manifest).map(
        ([path, newVersion]) => ({
          name: basename(path),
          path,
          currentVersion: '', // We don't need this for title matching
          newVersion: newVersion.latest,
          commits: [], // We don't need this for title matching
          changelog: '', // We don't need this for title matching
          releaseTarget // FIX: previously hardcoded to 'main'
        })
      )

      // Generate the expected title
      const expectedTitle = this.generateReleasePRTitle(changes)

      // Find every PR that matches our title.
      const titleMatches = prs.filter((pr) => pr.title === expectedTitle)
      if (titleMatches.length === 0) {
        return null
      }

      // Prefer a match that also carries the expected release labels (a
      // bonus signal, never a requirement), falling back to the first
      // title match otherwise.
      const expectedLabels = ['release-me', `release-target:${releaseTarget}`]
      const labeledMatch = titleMatches.find((pr) =>
        expectedLabels.every((label) => pr.labels.includes(label))
      )

      return (labeledMatch ?? titleMatches[0]).number
    } catch (error) {
      core.warning(`Failed to find release PR: ${error}`)
      return null
    }
  }

  async createComment(body: string): Promise<void> {
    if (!this.releaseContext.pullRequestNumber) {
      return
    }
    gh.createComment(this.releaseContext.pullRequestNumber, body)
  }

  async updatePackageVersion(
    packagePath: string,
    newVersion: string
  ): Promise<void> {
    const packageJsonPath = path.join(packagePath, 'package.json')
    const cargoTomlPath = path.join(packagePath, 'Cargo.toml')
    const pyprojectTomlPath = path.join(packagePath, 'pyproject.toml')
    const versionTxtPath = path.join(packagePath, 'version.txt')
    const indentation = core.getInput('indentation') ?? '2'
    const indent =
      indentation === 'tab' ? '\t' : ' '.repeat(parseInt(indentation))

    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))
      packageJson.version = newVersion
      const formattedJSON =
        JSON.stringify(packageJson, null, 2).replace(/ {2}/g, indent) + '\n'
      fs.writeFileSync(packageJsonPath, formattedJSON)
    } else if (fs.existsSync(cargoTomlPath)) {
      const updated = replaceTomlVersion(
        fs.readFileSync(cargoTomlPath, 'utf-8'),
        'package',
        newVersion
      )
      if (updated !== null) {
        fs.writeFileSync(cargoTomlPath, updated)
      }
    } else if (fs.existsSync(pyprojectTomlPath)) {
      const updated = replaceTomlVersion(
        fs.readFileSync(pyprojectTomlPath, 'utf-8'),
        'project',
        newVersion
      )
      if (updated !== null) {
        fs.writeFileSync(pyprojectTomlPath, updated)
      }
    } else if (fs.existsSync(versionTxtPath)) {
      // For version.txt, we just write the version number directly
      fs.writeFileSync(versionTxtPath, newVersion + '\n')
    } else {
      throw new Error(
        `No package.json, Cargo.toml, pyproject.toml, or version.txt found in ${packagePath}`
      )
    }
  }

  async getPullRequestFromCommit(sha: string): Promise<number | null> {
    try {
      const prs = gh.getMergedPullRequestsForCommit(sha)

      // Find the most recently merged PR
      const mergedPRs = prs.filter((pr) => pr.merged)
      if (mergedPRs.length === 0) return null

      // Sort by merged_at date in descending order
      mergedPRs.sort((a, b) => {
        const dateA = new Date(a.mergedAt as string).getTime()
        const dateB = new Date(b.mergedAt as string).getTime()
        return dateB - dateA
      })

      return mergedPRs[0].number
    } catch (error) {
      core.warning(`Failed to get PR from commit ${sha}: ${error}`)
      return null
    }
  }

  async wasReleasePR(prNumber: number): Promise<boolean> {
    try {
      const pr = gh.getPullRequest(prNumber)
      return pr ? pr.labels.includes('release-me') : false
    } catch (error) {
      core.warning(`Failed to get PR ${prNumber}: ${error}`)
      return false
    }
  }

  async getManifestFromMain(
    manifestFile: string,
    rootDir: string = '.'
  ): Promise<PackageManifest> {
    try {
      const filePath =
        rootDir === '.' ? manifestFile : path.join(rootDir, manifestFile)
      const content = git.getFileAtRef('origin/main', filePath)

      if (content === null) {
        throw new Error(
          `Manifest file ${manifestFile} not found in main branch`
        )
      }

      const manifest = JSON.parse(content)

      // Convert old manifest format to new format if needed
      const newManifest: PackageManifest = {}
      for (const [packagePath, version] of Object.entries(manifest)) {
        if (typeof version === 'string') {
          newManifest[packagePath] = {
            latest: version,
            main: version
          }
        } else {
          newManifest[packagePath] = version as PackageTargetVersions
        }
      }

      return newManifest
    } catch (error) {
      core.warning(`Failed to get manifest from main: ${error}`)
      return {}
    }
  }

  async wasManifestUpdatedInLastCommit(
    manifestFile: string,
    releaseTarget: string,
    rootDir: string = '.'
  ): Promise<boolean> {
    core.debug(`Checking if manifest was updated in last commit`)
    try {
      const filePath =
        rootDir === '.' ? manifestFile : path.join(rootDir, manifestFile)

      const patch = git.getLastCommitDiffForFile(filePath, 'HEAD')
      const manifestUpdated = patch.includes(`"${releaseTarget}":`)

      core.debug(`Manifest updated: ${manifestUpdated}`)
      return manifestUpdated
    } catch (error) {
      core.warning(`Failed to check if manifest was updated: ${error}`)
      return false
    }
  }

  async updateManifest(
    manifest: PackageManifest,
    changes: PackageChanges[],
    releaseTarget: string
  ): Promise<void> {
    for (const change of changes) {
      if (!manifest[change.path]) {
        manifest[change.path] = {
          latest: change.newVersion,
          [releaseTarget]: change.newVersion
        }
      } else {
        manifest[change.path].latest = change.newVersion
        manifest[change.path][releaseTarget] = change.newVersion
      }
    }
  }

  getReleaseTargetToLatestChanges(
    manifest: PackageManifest,
    releaseTarget: string
  ): PackageChanges[] {
    const changes: PackageChanges[] = []
    for (const [path, versions] of Object.entries(manifest)) {
      if (versions[releaseTarget] !== versions.latest) {
        changes.push({
          name: basename(path),
          path,
          currentVersion: versions[releaseTarget],
          newVersion: versions.latest,
          commits: [],
          changelog: `Bumped ${releaseTarget} to ${versions.latest}`,
          releaseTarget: releaseTarget
        })
      }
    }
    return changes
  }

  /**
   * Filter the provided commits for those that touch the given packagePath.
   * If commits are not provided, fetches all since last release.
   */
  async getCommitsSinceLastRelease(
    packagePath: string,
    allCommits?: Commit[]
  ): Promise<string[]> {
    const isSubPackage = packagePath !== '.'

    // If allCommits is not provided, fetch them
    if (!allCommits) {
      allCommits = await this.getAllCommitsSinceLastRelease(isSubPackage)
    }

    // If there are no commits, return early
    if (!allCommits || allCommits.length === 0) {
      return []
    }

    // For root package ('.'), return all commit messages
    if (!isSubPackage) {
      return allCommits.map((commit) => commit.commit.message)
    }

    // For subpackages, filter commits that touch files in the package path
    const filteredCommits = allCommits.filter((commit) => {
      // Check if any files in the commit are within the package path
      core.info(
        `Checking ${commit.files?.length ?? '(no files)'} files in commit ${commit.commit.message}`
      )
      return commit.files?.some((file: CommitFile) => {
        core.debug(
          `Checking commit ${commit.sha} for ${packagePath} in ${file.filename}`
        )
        return file.filename.startsWith(packagePath)
      })
    })

    return filteredCommits.map((commit) => commit.commit.message)
  }

  /**
   * Returns the SHA the action is currently running against (from
   * GITHUB_SHA), used by createRelease for tagging and exposed so
   * src/main.ts no longer needs to import @actions/github's context.
   */
  getContextSha(): string {
    return this.releaseContext.sha
  }
}
