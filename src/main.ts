import * as core from '@actions/core'
import * as fs from 'fs'
import { GitHubService } from './github.js'
import { PackageManifest, ConventionalCommit, PackageChanges } from './types.js'
import path from 'path'
import {
  parseConventionalCommit,
  determineVersionBump,
  calculateNewVersion,
  generateChangelog
} from './version.js'

/**
 * The main function for the action.
 *
 * @returns Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    const token = core.getInput('token', { required: true })
    const rootDir = core.getInput('root-dir', { required: false })
    const manifestFile = core.getInput('manifest-file', { required: true })
    const createPreRelease = core.getInput('create-prerelease') === 'true'
    const prereleaseLabel = core.getInput('prerelease-label')

    const github = new GitHubService(token)
    const labels = await github.getPullRequestLabels()

    // Check if this is a release PR
    if (labels.includes('released')) {
      core.info('This PR has already been released, skipping')
      return
    }

    // Check if this is a prerelease PR
    const isPreRelease = labels.includes(prereleaseLabel)
    if (!createPreRelease && isPreRelease) {
      core.info(
        'prereleases are disabled and this is a prerelease PR, skipping'
      )
      return
    }

    // Read and parse the manifest file
    const manifestContent = fs.readFileSync(
      path.join(rootDir, manifestFile),
      'utf-8'
    )
    const manifest: PackageManifest = JSON.parse(manifestContent)

    // Get commits for each package
    const allCommits = await github.getAllCommitsSinceLastRelease(true)
    if (!allCommits || allCommits.length === 0) {
      core.info('No changes requiring version updates found')
      return
    }

    const packageChanges: PackageChanges[] = []
    for (const [packagePath, currentVersion] of Object.entries(manifest)) {
      // Pass allCommits to avoid duplicate API calls
      const commits = await github.getCommitsSinceLastRelease(
        packagePath,
        allCommits
      )
      if (commits.length === 0) {
        continue
      }
      const conventionalCommits: ConventionalCommit[] = commits.map(
        (message) => ({
          ...parseConventionalCommit(message),
          hash: '' // We don't need the hash for version calculation
        })
      )
      const bump = determineVersionBump(conventionalCommits)
      if (bump === 'none') {
        continue
      }
      const newVersion = calculateNewVersion(currentVersion, bump, isPreRelease)
      const changelog = generateChangelog(conventionalCommits)
      packageChanges.push({
        path: packagePath,
        currentVersion,
        newVersion,
        commits: conventionalCommits,
        changelog
      })
    }

    if (packageChanges.length === 0) {
      core.info('No changes requiring version updates found')
      return
    }

    // If this is a PR with release-me tag, create the release
    if (labels.includes('release-me')) {
      // Update package versions
      for (const change of packageChanges) {
        await github.updatePackageVersion(change.path, change.newVersion)
      }

      // Create the release
      await github.createRelease(packageChanges)

      // Add released tag to the PR
      await github.addLabel('released')

      // Set outputs
      core.setOutput('version', packageChanges[0].newVersion)
      core.setOutput('prerelease', isPreRelease)
    } else {
      // This is a push to main, create a PR with the changes
      await github.createReleasePullRequest(packageChanges, 'release-me')
    }
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message)
    } else {
      core.setFailed('An unknown error occurred')
    }
  }
}
