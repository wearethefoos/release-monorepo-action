import * as core from '@actions/core'
import { context } from '@actions/github'
import { GitHubService } from './github.js'
import { PackageChanges } from './types.js'
import {
  parseConventionalCommit,
  determineVersionBump,
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
    const releaseTarget = core.getInput('release-target')

    if (releaseTarget === 'latest') {
      throw new Error('release-target cannot be "latest"')
    }

    const github = new GitHubService(token)
    const isDeletedReleaseBranch =
      await github.isDeletedReleaseBranch(releaseTarget)

    if (isDeletedReleaseBranch) {
      core.info(
        'Seems we are on an old release branch that does not exist anymore, nothing to do'
      )
      core.debug('Returning early: isDeletedReleaseBranch')
      return
    }

    const labels = await github.getPullRequestLabels()

    // Check if this is a release PR
    if (labels.includes('released')) {
      core.info('This PR has already been released, skipping')
      core.debug('Returning early: PR already released')
      return
    }

    // Check if this is a prerelease PR
    const isPrerelease = labels.includes(prereleaseLabel)
    if (isPrerelease && !createPreRelease) {
      core.info(
        'prereleases are disabled and this is a prerelease PR, skipping'
      )
      try {
        await github.createComment(
          `⚠️ Prereleases are currently disabled. To enable prereleases, set the input "create-prerelease" to true in your workflow.`
        )
      } catch (error) {
        core.warning(`Failed to create PR comment: ${error}`)
      }
      core.debug('Returning early: prerelease PR but prereleases disabled')
      return
    }

    // Read and parse the manifest file from main branch
    const manifest = await github.getManifestFromMain(manifestFile, rootDir)
    if (Object.keys(manifest).length === 0) {
      core.warning(
        `No manifest found in main branch at ${manifestFile} with root dir ${rootDir}`
      )
      core.debug('Returning early: manifest is empty')
      return
    }

    // Get all commits since last release
    const allCommits = await github.getAllCommitsSinceLastRelease()
    if (allCommits.length === 0) {
      core.info('No changes requiring version updates found')
      core.debug('Returning early: no commits since last release')
      return
    }

    // Calculate version changes for each package
    const changes: PackageChanges[] = []
    for (const [packagePath, targetVersions] of Object.entries(manifest)) {
      const commits = await github.getCommitsSinceLastRelease(
        packagePath,
        allCommits
      )
      if (commits.length === 0) continue

      const parsedCommits = commits.map(parseConventionalCommit)
      const versionBump = determineVersionBump(parsedCommits)
      if (!versionBump) continue

      const currentVersion = targetVersions.latest
      let newVersion = currentVersion
      if (versionBump === 'major') {
        newVersion = `${parseInt(currentVersion.split('.')[0]) + 1}.0.0`
      } else if (versionBump === 'minor') {
        const [major, minor] = currentVersion.split('.')
        newVersion = `${major}.${parseInt(minor) + 1}.0`
      } else if (versionBump === 'patch') {
        const [major, minor, patch] = currentVersion.split('.')
        newVersion = `${major}.${minor}.${parseInt(patch) + 1}`
      }

      // Set prerelease flag in output
      core.setOutput('prerelease', isPrerelease)

      // If this is a prerelease, append rc.<number>
      if (isPrerelease) {
        const rcNumber = await github.getLatestRcVersion(
          packagePath,
          newVersion
        )
        newVersion = `${newVersion}-rc.${rcNumber}`
        core.info('Skipping creating release PR for prerelease.')
        core.setOutput('version', newVersion)
        core.debug('Returning early: prerelease')
        return
      }

      changes.push({
        path: packagePath,
        currentVersion,
        newVersion,
        commits: parsedCommits,
        changelog: generateChangelog(parsedCommits),
        releaseTarget
      })
    }

    if (changes.length === 0) {
      core.info('No changes requiring version updates found')
      core.debug('Returning early: no version changes for any package')
      return
    }

    // Check if this is a release PR with release-me tag
    if (labels.includes('release-me')) {
      // Get the PR number from the commit or by versions
      let prNumber = await github.getPullRequestFromCommit(context.sha)
      if (!prNumber) {
        // Try to find PR by versions if commit lookup fails
        prNumber = await github.findReleasePRByVersions(manifest)
      }

      if (prNumber) {
        core.debug(`Creating release and adding label to PR #${prNumber}`)
        // Create release and add released label
        await github.createRelease(changes)
        await github.addLabel('released', prNumber)
        core.setOutput('version', changes[0].newVersion)
        core.debug('Returning after createRelease and addLabel')
        return
      }
    }

    // Check if manifest was updated in last commit
    if (await github.wasManifestUpdatedInLastCommit(manifestFile, rootDir)) {
      core.debug('Creating release for squashed merge')
      // Create release for squashed merge
      await github.createRelease(changes)
      core.setOutput('version', changes[0].newVersion)
      core.debug('Returning after createRelease for squashed merge')
      return
    }

    // Create release PR
    core.debug('Creating release PR (default branch)')
    await github.createReleasePullRequest(changes, 'release-me')
    core.debug('Returning after createReleasePullRequest (default branch)')
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message)
    } else {
      core.setFailed('An unknown error occurred')
    }
  }
}
