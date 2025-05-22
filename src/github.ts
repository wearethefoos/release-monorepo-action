import { Octokit } from '@octokit/rest'
import { context } from '@actions/github'
import * as core from '@actions/core'
import { ReleaseContext, PackageChanges } from './types.js'
import * as fs from 'fs'
import * as path from 'path'
import * as toml from '@iarna/toml'
import { determineVersionBump, parseConventionalCommit } from './version.js'

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

  async createReleasePullRequest(
    changes: PackageChanges[],
    label: string = 'release-me'
  ): Promise<void> {
    // Determine PR title and commit message
    let title: string
    if (changes.length === 1) {
      const change = changes[0]
      if (change.path === '.') {
        title = `chore: release ${change.newVersion}`
      } else {
        title = `chore: release ${change.path}@${change.newVersion}`
      }
    } else {
      title = 'chore: release main'
    }
    const commitMessage = title
    const body = this.generatePullRequestBody(changes)

    if (
      this.releaseContext.isPullRequest &&
      this.releaseContext.pullRequestNumber
    ) {
      // Update existing PR
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
        labels: [label]
      })
    } else {
      // Check for existing release PRs
      const { data: existingPRs } = await this.octokit.pulls.list({
        owner: this.releaseContext.owner,
        repo: this.releaseContext.repo,
        state: 'open',
        labels: [label]
      })

      if (existingPRs.length > 0) {
        core.info(`Updating existing release PR ${existingPRs[0].number}`)
        // Update the most recent release PR
        const existingPR = existingPRs[0]

        // Get the branch name from the PR
        const branchName = existingPR.head.ref

        // Get the main branch SHA to base our new commit on
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
            change.path === '.' ? 'Changelog' : `${change.path} Changelog`
          if (!changelogContent.startsWith('# ')) {
            changelogContent = `# ${packageName}\n\n${changelogContent}`
          }

          // Add the new version section after the level 1 heading
          const newVersionSection = `## ${change.newVersion} (${new Date().toISOString().split('T')[0]})\n\n${change.changelog}\n\n`
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

        // Create a tree with the updated files
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

        // Update the branch reference to point to the new commit, replacing all history
        await this.octokit.git.updateRef({
          owner: this.releaseContext.owner,
          repo: this.releaseContext.repo,
          ref: `heads/${branchName}`,
          sha: commit.sha,
          force: true // Force update to replace existing commits
        })

        // Update the PR
        await this.octokit.pulls.update({
          owner: this.releaseContext.owner,
          repo: this.releaseContext.repo,
          pull_number: existingPR.number,
          title,
          body
        })
        return
      }

      // Create a new branch with the format 'release-main'
      const branchName = `release-main`

      // Create the branch from main
      await this.octokit.git.createRef({
        owner: this.releaseContext.owner,
        repo: this.releaseContext.repo,
        ref: `refs/heads/${branchName}`,
        sha: await this.getMainSha()
      })

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
          change.path === '.' ? 'Changelog' : `${change.path} Changelog`
        if (!changelogContent.startsWith('# ')) {
          changelogContent = `# ${packageName}\n\n${changelogContent}`
        }

        // Add the new version section after the level 1 heading
        const newVersionSection = `## ${change.newVersion} (${new Date().toISOString().split('T')[0]})\n\n${change.changelog}`
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

      // Create a tree with the updated files
      const { data: tree } = await this.octokit.git.createTree({
        owner: this.releaseContext.owner,
        repo: this.releaseContext.repo,
        base_tree: (
          await this.octokit.git.getRef({
            owner: this.releaseContext.owner,
            repo: this.releaseContext.repo,
            ref: `heads/${branchName}`
          })
        ).data.object.sha,
        tree: treeItems
      })

      // Create a commit with the tree
      const { data: commit } = await this.octokit.git.createCommit({
        owner: this.releaseContext.owner,
        repo: this.releaseContext.repo,
        message: commitMessage,
        tree: tree.sha,
        parents: [
          (
            await this.octokit.git.getRef({
              owner: this.releaseContext.owner,
              repo: this.releaseContext.repo,
              ref: `heads/${branchName}`
            })
          ).data.object.sha
        ]
      })

      // Update the branch reference to point to the new commit
      await this.octokit.git.updateRef({
        owner: this.releaseContext.owner,
        repo: this.releaseContext.repo,
        ref: `heads/${branchName}`,
        sha: commit.sha
      })

      // Create the PR from the new branch
      const { data: pr } = await this.octokit.pulls.create({
        owner: this.releaseContext.owner,
        repo: this.releaseContext.repo,
        title,
        body,
        head: branchName,
        base: 'main'
      })

      await this.octokit.issues.addLabels({
        owner: this.releaseContext.owner,
        repo: this.releaseContext.repo,
        issue_number: pr.number,
        labels: [label]
      })
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

  async addLabel(label: string): Promise<void> {
    if (
      !this.releaseContext.isPullRequest ||
      !this.releaseContext.pullRequestNumber
    ) {
      return
    }

    await this.octokit.issues.addLabels({
      owner: this.releaseContext.owner,
      repo: this.releaseContext.repo,
      issue_number: this.releaseContext.pullRequestNumber,
      labels: [label]
    })
  }

  private generatePullRequestBody(changes: PackageChanges[]): string {
    return changes
      .map((change) => {
        return `## ${change.path === '.' ? 'Changelog' : `${change.path} Changelog`} (${change.currentVersion} -> ${change.newVersion})\n\n${change.changelog}`
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
      const versionBase = `v${change.newVersion}`
      const tagName =
        change.path === '.' ? versionBase : `${change.path}-${versionBase}`
      const releaseName =
        change.path === '.' ? versionBase : `${change.path} ${versionBase}`

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
      repo: this.releaseContext.repo
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
