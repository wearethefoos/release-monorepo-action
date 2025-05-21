import * as core from '@actions/core'
import * as fs from 'fs'
import { GitHubService } from './github.js'
import {
  parseConventionalCommit,
  determineVersionBump,
  calculateNewVersion,
  generateChangelog
} from './version.js'
import { PackageManifest, ConventionalCommit, PackageChanges } from './types.js'
import path from 'path'

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
    if (labels.includes('release-me')) {
      core.info('This is a release PR, skipping version calculation')
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

    const changes: PackageChanges[] = []

    // Process each package in the manifest
    for (const [packagePath, currentVersion] of Object.entries(manifest)) {
      // Get commits for this package
      const commitMessages = await github.getCommitsSinceLastRelease(
        path.join(rootDir, packagePath).replace(/^\.\//, '')
      )
      if (commitMessages.length === 0) {
        continue
      }

      // Parse conventional commits
      const commits: ConventionalCommit[] = commitMessages.map((message) => ({
        ...parseConventionalCommit(message),
        hash: '' // We don't need the hash for version calculation
      }))

      // Determine version bump
      const bump = determineVersionBump(commits)
      if (bump === 'none') {
        continue
      }

      // Calculate new version
      const newVersion = calculateNewVersion(currentVersion, bump, isPreRelease)

      // Generate changelog
      const changelog = generateChangelog(commits)

      changes.push({
        path: path.join(rootDir, packagePath).replace(/^\.\//, ''),
        currentVersion,
        newVersion,
        commits,
        changelog
      })
    }

    if (changes.length === 0) {
      core.info('No changes requiring version updates found')
      return
    }

    // Update package versions and create PR if needed
    for (const change of changes) {
      await github.updatePackageVersion(change.path, change.newVersion)
    }

    if (isPreRelease) {
      await github.createReleasePullRequest(changes)
    } else {
      await github.createRelease(changes)
    }

    // Set outputs
    core.setOutput('version', changes[0].newVersion)
    core.setOutput('prerelease', isPreRelease)
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message)
    } else {
      core.setFailed('An unknown error occurred')
    }
  }
}

run()
