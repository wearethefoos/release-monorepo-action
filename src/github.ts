import { context } from '@actions/github'
import * as core from '@actions/core'
import { Octokit } from '@octokit/rest'
import {
  ReleaseContext,
  PackageChanges,
  PackageManifest,
  PackageTargetVersions
} from './types.js'
import * as fs from 'fs'
import * as path from 'path'
import * as toml from '@iarna/toml'
import { determineVersionBump, parseConventionalCommit } from './version.js'
import { basename } from 'path'

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

export class GitHubService {
  private octokit: Octokit
  private releaseContext: ReleaseContext

  constructor(token: string) {
    this.octokit = new Octokit({ auth: token })
    this.releaseContext = this.getReleaseContext()
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

    try {
      await this.octokit.repos.getBranch({
        owner: this.releaseContext.owner,
        repo: this.releaseContext.repo,
        branch: `release-${target}`
      })
      return false // Branch exists
    } catch {
      return true // Branch does not exist
    }
  }

  private getReleaseContext(): ReleaseContext {
    const { payload, ref, repo } = context
    const isPullRequest = payload.pull_request !== undefined
    const pullRequestNumber = isPullRequest
      ? payload.pull_request?.number
      : undefined
    const baseRef = isPullRequest ? payload.pull_request?.base.ref : ref
    const headRef = isPullRequest ? payload.pull_request?.head.ref : ref

    return {
      isPullRequest,
      isPreRelease: false, // Will be set by the action
      shouldRelease: false, // Will be set by the action
      pullRequestNumber,
      baseRef,
      headRef,
      owner: repo.owner,
      repo: repo.repo
    }
  }

  async getCommitCount(ref: string = 'HEAD'): Promise<number> {
    const { data: commits } = await this.octokit.repos.listCommits({
      owner: this.releaseContext.owner,
      repo: this.releaseContext.repo,
      sha: ref,
      per_page: 1
    })

    // Get the total count from the Link header
    const response = await this.octokit.request(
      'GET /repos/{owner}/{repo}/commits',
      {
        owner: this.releaseContext.owner,
        repo: this.releaseContext.repo,
        sha: ref,
        per_page: 1
      }
    )

    // Extract the total count from the Link header
    const linkHeader = response.headers.link
    if (!linkHeader) {
      return commits.length
    }

    // Parse the Link header to get the last page number
    const lastPageMatch = linkHeader.match(/page=(\d+)>; rel="last"/)
    if (lastPageMatch) {
      return parseInt(lastPageMatch[1], 10)
    }

    return commits.length
  }

  async getPullRequestLabels(): Promise<string[]> {
    if (
      !this.releaseContext.isPullRequest ||
      !this.releaseContext.pullRequestNumber
    ) {
      return []
    }

    const { data: pr } = await this.octokit.pulls.get({
      owner: this.releaseContext.owner,
      repo: this.releaseContext.repo,
      pull_number: this.releaseContext.pullRequestNumber
    })

    return pr.labels.map((label) => label.name)
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

    const { data: pr } = await this.octokit.pulls.get({
      owner: this.releaseContext.owner,
      repo: this.releaseContext.repo,
      pull_number: this.releaseContext.pullRequestNumber
    })

    return pr.merged
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

    // Get the current main branch SHA
    const mainSha = await this.getMainSha()

    // Update package versions and changelogs locally
    const treeItems = []
    for (const change of changes) {
      await this.updatePackageVersion(change.path, change.newVersion)

      // Add the updated package.json to the tree
      const packageJsonPath = path.join(change.path, 'package.json')
      if (fs.existsSync(packageJsonPath)) {
        const content = fs.readFileSync(packageJsonPath, 'utf-8')
        const { data: blob } = await this.octokit.git.createBlob({
          owner: this.releaseContext.owner,
          repo: this.releaseContext.repo,
          content,
          encoding: 'utf-8'
        })
        treeItems.push({
          path: packageJsonPath,
          mode: '100644' as const,
          type: 'blob' as const,
          sha: blob.sha
        })
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

      // Create blob for the changelog
      const { data: changelogBlob } = await this.octokit.git.createBlob({
        owner: this.releaseContext.owner,
        repo: this.releaseContext.repo,
        content: changelogContent.trimEnd() + '\n',
        encoding: 'utf-8'
      })
      treeItems.push({
        path: changelogPath,
        mode: '100644' as const,
        type: 'blob' as const,
        sha: changelogBlob.sha
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
    const updatedManifestContent = formattedManifestJSON
    const { data: manifestBlob } = await this.octokit.git.createBlob({
      owner: this.releaseContext.owner,
      repo: this.releaseContext.repo,
      content: updatedManifestContent,
      encoding: 'utf-8'
    })
    treeItems.push({
      path: manifestPath,
      mode: '100644' as const,
      type: 'blob' as const,
      sha: manifestBlob.sha
    })

    // Create a tree with the updated files, based on main
    const { data: tree } = await this.octokit.git.createTree({
      owner: this.releaseContext.owner,
      repo: this.releaseContext.repo,
      base_tree: mainSha,
      tree: treeItems
    })

    // Create a commit with the tree, based on main
    const { data: commit } = await this.octokit.git.createCommit({
      owner: this.releaseContext.owner,
      repo: this.releaseContext.repo,
      message: commitMessage,
      tree: tree.sha,
      parents: [mainSha]
    })

    // Create or update the branch reference
    try {
      await this.octokit.git.createRef({
        owner: this.releaseContext.owner,
        repo: this.releaseContext.repo,
        ref: `refs/heads/${branchName}`,
        sha: commit.sha
      })
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes('Reference already exists')
      ) {
        // Update existing branch
        await this.octokit.git.updateRef({
          owner: this.releaseContext.owner,
          repo: this.releaseContext.repo,
          ref: `heads/${branchName}`,
          sha: commit.sha,
          force: true
        })
      } else {
        throw error
      }
    }

    // Create or update the PR
    const { data: existingPRs } = await this.octokit.pulls.list({
      owner: this.releaseContext.owner,
      repo: this.releaseContext.repo,
      state: 'open',
      labels: [`release-target:${changes[0].releaseTarget}`],
      head: `${this.releaseContext.owner}:${branchName}`
    })

    const body = this.generatePullRequestBody(changes)

    if (existingPRs.length > 0) {
      // Update existing PR
      await this.octokit.pulls.update({
        owner: this.releaseContext.owner,
        repo: this.releaseContext.repo,
        pull_number: existingPRs[0].number,
        title,
        body
      })

      if (!existingPRs[0].labels.map((label) => label.name).includes(label)) {
        await this.addLabel(label, existingPRs[0].number)
        await this.addLabel(
          `release-target:${changes[0].releaseTarget}`,
          existingPRs[0].number
        )
      }
    } else {
      // Create new PR
      const newPr = await this.octokit.pulls.create({
        owner: this.releaseContext.owner,
        repo: this.releaseContext.repo,
        title,
        labels: [label, `release-target:${changes[0].releaseTarget}`],
        body,
        head: branchName,
        base: 'main'
      })

      await this.addLabel(label, newPr.data.number)
      await this.addLabel(
        `release-target:${changes[0].releaseTarget}`,
        newPr.data.number
      )
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

    // Get the current main branch SHA
    const mainSha = await this.getMainSha()

    // Update package versions and changelogs locally
    const treeItems = []

    // Update the release manifest
    const manifestPath = manifestFile

    const manifest = await this.getManifestFromMain(
      manifestFile,
      core.getInput('root-dir') ?? '.'
    )
    await this.updateManifest(manifest, changes, changes[0].releaseTarget)
    const updatedManifestContent = JSON.stringify(manifest, null, 2) + '\n'
    const { data: manifestBlob } = await this.octokit.git.createBlob({
      owner: this.releaseContext.owner,
      repo: this.releaseContext.repo,
      content: updatedManifestContent,
      encoding: 'utf-8'
    })
    treeItems.push({
      path: manifestPath,
      mode: '100644' as const,
      type: 'blob' as const,
      sha: manifestBlob.sha
    })

    // Create a tree with the updated files, based on main
    const { data: tree } = await this.octokit.git.createTree({
      owner: this.releaseContext.owner,
      repo: this.releaseContext.repo,
      base_tree: mainSha,
      tree: treeItems
    })

    // Create a commit with the tree, based on main
    const { data: commit } = await this.octokit.git.createCommit({
      owner: this.releaseContext.owner,
      repo: this.releaseContext.repo,
      message: commitMessage,
      tree: tree.sha,
      parents: [mainSha]
    })

    // Create or update the branch reference
    try {
      await this.octokit.git.createRef({
        owner: this.releaseContext.owner,
        repo: this.releaseContext.repo,
        ref: `refs/heads/${branchName}`,
        sha: commit.sha
      })
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes('Reference already exists')
      ) {
        // Update existing branch
        await this.octokit.git.updateRef({
          owner: this.releaseContext.owner,
          repo: this.releaseContext.repo,
          ref: `heads/${branchName}`,
          sha: commit.sha,
          force: true
        })
      } else {
        throw error
      }
    }

    // Create or update the PR
    const { data: existingPRs } = await this.octokit.pulls.list({
      owner: this.releaseContext.owner,
      repo: this.releaseContext.repo,
      state: 'open',
      labels: [`release-target:${changes[0].releaseTarget}`],
      head: `${this.releaseContext.owner}:${branchName}`
    })

    const body = this.generatePullRequestBody(changes)

    if (existingPRs.length > 0) {
      // Update existing PR
      await this.octokit.pulls.update({
        owner: this.releaseContext.owner,
        repo: this.releaseContext.repo,
        pull_number: existingPRs[0].number,
        title,
        body
      })

      if (!existingPRs[0].labels.map((label) => label.name).includes(label)) {
        await this.addLabel(label, existingPRs[0].number)
        await this.addLabel(
          `release-target:${changes[0].releaseTarget}`,
          existingPRs[0].number
        )
      }
    } else {
      // Create new PR
      const newPr = await this.octokit.pulls.create({
        owner: this.releaseContext.owner,
        repo: this.releaseContext.repo,
        title,
        labels: [label, `release-target:${changes[0].releaseTarget}`],
        body,
        head: branchName,
        base: 'main'
      })

      await this.addLabel(label, newPr.data.number)
      await this.addLabel(
        `release-target:${changes[0].releaseTarget}`,
        newPr.data.number
      )
    }
  }

  private async getMainSha(): Promise<string> {
    const { data } = await this.octokit.repos.getBranch({
      owner: this.releaseContext.owner,
      repo: this.releaseContext.repo,
      branch: 'main'
    })
    return data.commit.sha
  }

  async removeLabel(label: string, prNumber: number): Promise<void> {
    await this.octokit.issues.removeLabel({
      owner: this.releaseContext.owner,
      repo: this.releaseContext.repo,
      issue_number: prNumber,
      name: label
    })
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

    await this.octokit.issues.addLabels({
      owner: this.releaseContext.owner,
      repo: this.releaseContext.repo,
      issue_number: prNumber,
      labels: [label]
    })
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
    prerelease: boolean = false
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

      // Create tag
      try {
        await this.octokit.git.createRef({
          owner: this.releaseContext.owner,
          repo: this.releaseContext.repo,
          ref: `refs/tags/${tagName}`,
          sha: context.sha,
          force: true
        })
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes('Reference already exists')
        ) {
          core.warning(`Tag ${tagName} already exists, skipping`)
        } else {
          core.setFailed('Failed to create tag')
          throw error
        }
      }

      // Create release
      core.info(`Creating release ${releaseName}`)

      try {
        await this.octokit.repos.createRelease({
          owner: this.releaseContext.owner,
          repo: this.releaseContext.repo,
          tag_name: tagName,
          name: releaseName,
          body: change.changelog,
          draft: false,
          prerelease: !!prerelease
        })
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes('already_exists')
        ) {
          core.warning(`Release ${releaseName} already exists, skipping`)
        } else {
          core.setFailed('Failed to create release')
          throw error
        }
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
   * Fetch all commits (with files) since the last release (or fallback) for the repo.
   * Returns the array of commits (with files) for further filtering.
   */
  async getAllCommitsSinceLastRelease(
    checkPaths: boolean = true
  ): Promise<Commit[]> {
    // Get all releases for the repository
    const { data: releases } = await this.octokit.repos.listReleases({
      owner: this.releaseContext.owner,
      repo: this.releaseContext.repo,
      sort: 'created',
      direction: 'desc'
    })

    // Find the most recent non-prerelease release (for any package)
    const lastRelease = releases.find((release) => !release.prerelease)

    // If no release found, get commits since the beginning
    let base: string
    if (lastRelease) {
      base = lastRelease.tag_name
    } else {
      // Get total commit count and use that to look back
      const totalCommits = await this.getCommitCount()
      const lookbackCount = Math.min(50, totalCommits)
      base = `HEAD~${lookbackCount - 1}`
    }

    core.info(
      `Getting all commits since last release with base ${base} and head ${this.releaseContext.headRef}...`
    )

    let allCommits: Commit[] = []
    let page = 1
    let hasMorePages = true

    while (hasMorePages) {
      core.info(`Fetching page ${page} of commits...`)
      const response = await this.octokit.request(
        'GET /repos/{owner}/{repo}/compare/{basehead}',
        {
          owner: this.releaseContext.owner,
          repo: this.releaseContext.repo,
          basehead: `${base}...${this.releaseContext.headRef}`,
          mediaType: {
            format: 'json'
          },
          per_page: 100,
          page
        }
      )

      // If there are no commits in the response, break early
      if (!response.data.commits || response.data.commits.length === 0) {
        break
      }

      // filter commits to only include those that would be relevant for a version bump
      const commits = response.data.commits.filter((commit) => {
        core.debug(commit.commit.message.split('\n')[0])

        const conventionalCommit = parseConventionalCommit(
          commit.commit.message
        )

        return determineVersionBump([conventionalCommit]) !== 'none'
      })

      core.info(
        `Considering ${commits.length}/${response.data.commits.length} relevant commits on page ${page}`
      )

      // If there are no relevant commits, break early
      if (commits.length === 0) {
        break
      }

      // Fetch commit details for each commit to get files
      if (checkPaths) {
        for (const commit of commits) {
          const commitResponse = await this.octokit.request(
            'GET /repos/{owner}/{repo}/commits/{ref}',
            {
              owner: this.releaseContext.owner,
              repo: this.releaseContext.repo,
              ref: commit.sha
              // No mediaType needed; default is JSON and includes files
            }
          )
          commit.files = commitResponse.data.files
        }
      }

      allCommits = allCommits.concat(commits)

      // Check if we have more pages
      const linkHeader = response.headers.link
      hasMorePages = linkHeader?.includes('rel="next"') ?? false
      page++
    }

    core.info(`Total commits found: ${allCommits.length}`)
    return allCommits
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

  async updatePackageVersion(
    packagePath: string,
    newVersion: string
  ): Promise<void> {
    const packageJsonPath = path.join(packagePath, 'package.json')
    const cargoTomlPath = path.join(packagePath, 'Cargo.toml')
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
      const cargoToml = toml.parse(fs.readFileSync(cargoTomlPath, 'utf-8'))
      if (cargoToml.package) {
        ;(cargoToml.package as unknown as { version: string }).version =
          newVersion
        fs.writeFileSync(cargoTomlPath, toml.stringify(cargoToml))
      }
    } else if (fs.existsSync(versionTxtPath)) {
      // For version.txt, we just write the version number directly
      fs.writeFileSync(versionTxtPath, newVersion + '\n')
    } else {
      throw new Error(
        `No package.json, Cargo.toml, or version.txt found in ${packagePath}`
      )
    }
  }

  async getPullRequestFromCommit(sha: string): Promise<number | null> {
    try {
      const { data: prs } =
        await this.octokit.repos.listPullRequestsAssociatedWithCommit({
          owner: this.releaseContext.owner,
          repo: this.releaseContext.repo,
          commit_sha: sha
        })

      // Find the most recently merged PR
      const mergedPRs = prs.filter((pr) => pr.merged_at !== null)
      if (mergedPRs.length === 0) return null

      // Sort by merged_at date in descending order
      mergedPRs.sort((a, b) => {
        const dateA = new Date(a.merged_at as string).getTime()
        const dateB = new Date(b.merged_at as string).getTime()
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
      const { data: pr } = await this.octokit.pulls.get({
        owner: this.releaseContext.owner,
        repo: this.releaseContext.repo,
        pull_number: prNumber
      })
      return pr.labels.some((label) => label.name === 'release-me')
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
      const { data } = await this.octokit.repos.getContent({
        owner: this.releaseContext.owner,
        repo: this.releaseContext.repo,
        path: filePath,
        ref: 'main'
      })

      if (!('content' in data)) {
        throw new Error(
          `Manifest file ${manifestFile} not found in main branch`
        )
      }

      const content = Buffer.from(data.content, 'base64').toString('utf-8')
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
      const { data: commits } = await this.octokit.repos.listCommits({
        owner: this.releaseContext.owner,
        repo: this.releaseContext.repo,
        branch: this.releaseContext.headRef,
        per_page: 1
      })

      if (commits.length === 0) {
        core.debug('No commits found with the manifest file')
        return false
      }

      const latestCommit = commits[0]
      const { data: commit } = await this.octokit.repos.getCommit({
        owner: this.releaseContext.owner,
        repo: this.releaseContext.repo,
        ref: latestCommit.sha
      })

      const manifestUpdated =
        commit.files?.some(
          (file) =>
            file.filename === filePath &&
            file.patch?.includes(`"${releaseTarget}":`)
        ) ?? false

      core.debug(`Manifest updated: ${manifestUpdated}`)
      return manifestUpdated
    } catch (error) {
      core.warning(`Failed to check if manifest was updated: ${error}`)
      return false
    }
  }

  async getLastReleaseVersion(packagePath: string): Promise<string | null> {
    try {
      const { data: releases } = await this.octokit.repos.listReleases({
        owner: this.releaseContext.owner,
        repo: this.releaseContext.repo
      })

      // Find the most recent non-prerelease release for this package
      const lastRelease = releases.find((release) => {
        if (release.prerelease) return false
        const tagName = release.tag_name
        if (packagePath === '.') {
          return tagName.startsWith('v')
        }
        return tagName.startsWith(`${packagePath}-v`)
      })

      if (!lastRelease) return null

      // Extract version from tag name
      const tagName = lastRelease.tag_name
      if (packagePath === '.') {
        return tagName.substring(1) // Remove 'v' prefix
      }
      return tagName.substring(packagePath.length + 2) // Remove 'packagePath-v' prefix
    } catch (error) {
      core.warning(
        `Failed to get last release version for ${packagePath}: ${error}`
      )
      return null
    }
  }

  async getChangelogForPackage(packagePath: string): Promise<string> {
    try {
      const changelogPath = path.join(packagePath, 'CHANGELOG.md')
      const { data } = await this.octokit.repos.getContent({
        owner: this.releaseContext.owner,
        repo: this.releaseContext.repo,
        path: changelogPath,
        ref: 'main'
      })

      if (!('content' in data)) {
        return ''
      }

      const content = Buffer.from(data.content, 'base64').toString('utf-8')
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
      // Get all closed PRs with release-me label
      const { data: prs } = await this.octokit.pulls.list({
        owner: this.releaseContext.owner,
        repo: this.releaseContext.repo,
        state: 'closed',
        labels: ['release-me', `release-target:${releaseTarget}`],
        sort: 'updated',
        direction: 'desc',
        per_page: 10 // Look at the 10 most recent ones
      })

      // Convert manifest to PackageChanges format
      const changes: PackageChanges[] = Object.entries(manifest).map(
        ([path, newVersion]) => ({
          name: basename(path),
          path,
          currentVersion: '', // We don't need this for title matching
          newVersion: newVersion.latest,
          commits: [], // We don't need this for title matching
          changelog: '', // We don't need this for title matching
          releaseTarget: 'main'
        })
      )

      // Generate the expected title
      const expectedTitle = this.generateReleasePRTitle(changes)

      // Find the first PR that matches our title
      const matchingPR = prs.find((pr) => pr.title === expectedTitle)
      return matchingPR ? matchingPR.number : null
    } catch (error) {
      core.warning(`Failed to find release PR: ${error}`)
      return null
    }
  }

  async createComment(body: string): Promise<void> {
    if (!this.releaseContext.pullRequestNumber) {
      return
    }
    await this.octokit.issues.createComment({
      owner: this.releaseContext.owner,
      repo: this.releaseContext.repo,
      issue_number: this.releaseContext.pullRequestNumber,
      body
    })
  }

  async getLatestRcVersion(
    packagePath: string,
    baseVersion: string
  ): Promise<number> {
    try {
      const { data: releases } = await this.octokit.repos.listReleases({
        owner: this.releaseContext.owner,
        repo: this.releaseContext.repo
      })

      // Find the latest RC version for this package
      const rcRegex = new RegExp(`${packagePath}-v${baseVersion}-rc\\.(\\d+)`)
      const latestRc = releases
        .filter((release) => rcRegex.test(release.tag_name))
        .sort((a, b) => {
          const aMatch = a.tag_name.match(rcRegex)
          const bMatch = b.tag_name.match(rcRegex)
          if (!aMatch || !bMatch) return 0
          return parseInt(bMatch[1]) - parseInt(aMatch[1])
        })[0]

      // Return the next RC number
      return latestRc ? parseInt(latestRc.tag_name.match(rcRegex)![1]) + 1 : 1
    } catch (error) {
      core.warning(`Failed to get latest RC version: ${error}`)
      return 1
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
}
