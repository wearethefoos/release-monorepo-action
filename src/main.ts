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
    const createPreReleases = core.getInput('create-prereleases') === 'true'
    const prereleaseLabel = core.getInput('prerelease-label')
    const releaseTarget = core.getInput('release-target')

    if (releaseTarget === 'latest') {
      throw new Error(
        'release-target cannot be "latest", because it is reserved for the latest release'
      )
    }

    const github = new GitHubService(token)
    const labels = await github.getPullRequestLabels()

    const isDeletedReleaseBranch =
      await github.isDeletedReleaseBranch(releaseTarget)

    if (isDeletedReleaseBranch) {
      if (labels.includes('release-me')) {
        core.debug('Adding released label to PR')
        await github.addLabel('released', context.issue.number)
      }

      core.info(
        'Seems we are on an old release branch that does not exist anymore, nothing else to do here'
      )

      core.debug('Returning early: isDeletedReleaseBranch')
      return
    }

    // Check if this is an already released PR
    if (labels.includes('released')) {
      core.info('This PR has already been released, skipping')
      core.debug('Returning early: PR already released')
      return
    }

    // Check if this is a prerelease PR
    const isPrerelease = labels.includes(prereleaseLabel)

    if (isPrerelease && !createPreReleases) {
      try {
        await github.createComment(
          '⚠️ Prereleases are currently disabled. To enable prereleases, set the input "create-prereleases" to true in your workflow.'
        )
      } catch (error) {
        core.warning(
          '⚠️ Prereleases are currently disabled. To enable prereleases, set the input "create-prereleases" to true in your workflow.'
        )
        core.info(`Failed to create PR comment: ${error}`)
      }
      core.debug('Returning early: prerelease PR but prereleases disabled')
      return
    }

    // Set prerelease flag in output
    core.setOutput('prerelease', isPrerelease)

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
    const prereleaseVersionCommentLines: string[] = isPrerelease
      ? ['ℹ️ Created prereleases for the following packages:', '']
      : []

    for (const [packagePath, targetVersions] of Object.entries(manifest)) {
      const commits = await github.getCommitsSinceLastRelease(
        packagePath,
        allCommits
      )

      if (commits.length === 0) {
        core.debug(`No commits found for ${packagePath}`)
        continue
      }

      const parsedCommits = commits.map(parseConventionalCommit)
      const versionBump = determineVersionBump(parsedCommits)
      if (!versionBump) {
        core.debug(
          `No version bump found for ${packagePath}, skipping version update`
        )
        continue
      }

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

      // If this is a prerelease, append rc.<number>
      if (isPrerelease) {
        core.debug(`Getting latest RC version for ${packagePath}`)
        const rcNumber = await github.getLatestRcVersion(
          packagePath,
          newVersion
        )
        core.debug(`Latest RC version for ${packagePath} is ${rcNumber}`)
        newVersion = `${newVersion}-rc.${rcNumber}`
        prereleaseVersionCommentLines.push(`- ${newVersion} for ${packagePath}`)
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

    core.debug(`Setting output for ${changes.length} packages`)

    if (changes.length === 1) {
      core.setOutput('version', changes[0].newVersion)
    } else {
      core.setOutput(
        'versions',
        JSON.stringify(
          changes.map((c) => {
            return {
              path: c.path,
              target: c.releaseTarget,
              version: c.newVersion
            }
          })
        )
      )
    }

    if (isPrerelease) {
      core.info('Skipping creating release PR for prerelease.')

      try {
        await github.createComment(prereleaseVersionCommentLines.join('\n'))
      } catch (error) {
        core.warning(prereleaseVersionCommentLines.join('\n'))
        core.info(`Failed to create PR comment: ${error}`)
      }
      core.debug('Creating release for prerelease')
      await github.createRelease(changes, true)
      core.debug('Returning early: prerelease')
      return
    }

    // Check if this is a release PR with release-me tag
    core.debug('Checking if this is a merged release PR with release-me tag')
    if (labels.includes('release-me') && (await github.isPullRequestMerged())) {
      core.debug('This is a merged release PR with release-me tag')
      let prNumber = github.getPullRequestNumberFromContext()
      core.debug(`PR number from context: ${prNumber}`)

      if (!prNumber) {
        prNumber = await github.getPullRequestFromCommit(context.sha)
      }

      if (!prNumber) {
        core.debug('No PR number found, trying to find PR by versions')
        prNumber = await github.findReleasePRByVersions(manifest)
        core.debug(`Found PR #${prNumber} by versions`)
      }

      core.info(`Creating releases...`)
      await github.createRelease(changes)

      if (prNumber) {
        core.info(`Created releases for PR #${prNumber}`)
        await github.addLabel('released', prNumber)
      }

      core.debug('Returning after creating release for PR')
      return
    }

    core.debug(`On main branch: ${await github.onMainBranch()}`)
    core.debug(`Has release-me label: ${labels.includes('release-me')}`)
    core.debug(`Is pull request merged: ${await github.isPullRequestMerged()}`)
    core.debug(
      `Manifest updated in last commit: ${await github.wasManifestUpdatedInLastCommit(manifestFile, rootDir)}`
    )

    // Check if manifest was updated in last commit
    if (
      (await github.onMainBranch()) &&
      (await github.wasManifestUpdatedInLastCommit(manifestFile, rootDir))
    ) {
      core.info('Creating release for main branch')
      core.debug('Assuming this is a squashed merge of a release PR')
      await github.createRelease(changes)
      core.debug('Returning after createRelease for main branch')
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
