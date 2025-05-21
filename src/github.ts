import { Octokit } from '@octokit/rest'
import { context } from '@actions/github'
import * as core from '@actions/core'
import { ReleaseContext, PackageChanges } from './types.js'
import * as fs from 'fs'
import * as path from 'path'
import * as toml from '@iarna/toml'

export class GitHubService {
  private octokit: Octokit
  private releaseContext: ReleaseContext

  constructor(token: string) {
    this.octokit = new Octokit({ auth: token })
    this.releaseContext = this.getReleaseContext()
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

  async createReleasePullRequest(changes: PackageChanges[]): Promise<void> {
    if (
      !this.releaseContext.isPullRequest ||
      !this.releaseContext.pullRequestNumber
    ) {
      return
    }

    const title = `Release ${changes.map((change) => `${change.path}@${change.newVersion}`).join(', ')}`
    const body = this.generatePullRequestBody(changes)

    await this.octokit.pulls.update({
      owner: this.releaseContext.owner,
      repo: this.releaseContext.repo,
      pull_number: this.releaseContext.pullRequestNumber,
      title,
      body
    })

    await this.octokit.issues.addLabels({
      owner: this.releaseContext.owner,
      repo: this.releaseContext.repo,
      issue_number: this.releaseContext.pullRequestNumber,
      labels: ['release-me']
    })
  }

  private generatePullRequestBody(changes: PackageChanges[]): string {
    return changes
      .map((change) => {
        return `## ${change.path} (${change.currentVersion} -> ${change.newVersion})\n\n${change.changelog}`
      })
      .join('\n\n')
  }

  async createRelease(changes: PackageChanges[]): Promise<void> {
    // Set outputs based on number of packages
    if (changes.length === 1) {
      const change = changes[0]
      core.setOutput('version', change.newVersion)
      core.setOutput('prerelease', change.newVersion.includes('-rc.'))
    } else {
      const versions = changes.map((change) => ({
        path: change.path,
        version: change.newVersion,
        prerelease: change.newVersion.includes('-rc.')
      }))
      core.setOutput('versions', JSON.stringify(versions))
    }

    for (const change of changes) {
      const tagName = `${change.path}-v${change.newVersion}`
      const releaseName = `${change.path} v${change.newVersion}`

      // Create tag
      await this.octokit.git.createRef({
        owner: this.releaseContext.owner,
        repo: this.releaseContext.repo,
        ref: `refs/tags/${tagName}`,
        sha: context.sha
      })

      // Create release
      await this.octokit.repos.createRelease({
        owner: this.releaseContext.owner,
        repo: this.releaseContext.repo,
        tag_name: tagName,
        name: releaseName,
        body: change.changelog,
        draft: false,
        prerelease: change.newVersion.includes('-rc.')
      })
    }
  }

  async getCommitsSinceLastRelease(packagePath: string): Promise<string[]> {
    // Get all releases for the repository
    const { data: releases } = await this.octokit.repos.listReleases({
      owner: this.releaseContext.owner,
      repo: this.releaseContext.repo
    })

    // Find the last release for this package
    const packageTagPrefix = `${packagePath}-v`
    const lastRelease = releases.find(
      (release) =>
        release.tag_name.startsWith(packageTagPrefix) && !release.prerelease
    )

    // If no release found, get commits since the beginning
    let base: string
    if (lastRelease) {
      base = lastRelease.tag_name
    } else {
      // Get total commit count and use that to look back
      const totalCommits = await this.getCommitCount()
      const lookbackCount = Math.min(50, totalCommits - 1)
      base = `HEAD~${lookbackCount}`
    }

    core.info(
      `Getting commits on ${this.releaseContext.owner}/${this.releaseContext.repo} since last release for "${packagePath}" with base ${base} and head ${this.releaseContext.headRef}...`
    )

    const { data: commits } =
      await this.octokit.repos.compareCommitsWithBasehead({
        owner: this.releaseContext.owner,
        repo: this.releaseContext.repo,
        basehead: `${base}...${this.releaseContext.headRef}`
      })

    return commits.commits
      .filter((commit) => {
        // Check if any files in the commit are within the package path
        return commit.files?.some((file) =>
          file.filename.startsWith(packagePath)
        )
      })
      .map((commit) => commit.commit.message)
  }

  async updatePackageVersion(
    packagePath: string,
    newVersion: string
  ): Promise<void> {
    const packageJsonPath = path.join(packagePath, 'package.json')
    const cargoTomlPath = path.join(packagePath, 'Cargo.toml')
    const versionTxtPath = path.join(packagePath, 'version.txt')

    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))
      packageJson.version = newVersion
      fs.writeFileSync(
        packageJsonPath,
        JSON.stringify(packageJson, null, 2) + '\n'
      )
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
}
