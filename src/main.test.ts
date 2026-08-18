import { describe, it, expect, beforeEach, vi, beforeAll } from 'vitest'
import * as core from '@actions/core'
import * as fs from 'fs'
import type { Mock } from 'vitest'

vi.mock('@actions/core', () => ({
  info: vi.fn().mockImplementation((...args: unknown[]) => {
    console.log('[core.info]', ...args)
  }),
  warning: vi.fn().mockImplementation((...args: unknown[]) => {
    console.log('[core.warning]', ...args)
  }),
  debug: vi.fn().mockImplementation((...args: unknown[]) => {
    console.log('[core.debug]', ...args)
  }),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  getInput: vi.fn()
}))

vi.mock('fs', () => ({
  readFileSync: vi.fn()
}))

// --- GitHubService mock setup ---
const githubServiceMock = {
  getPullRequestLabels: vi.fn(),
  getAllCommitsSinceLastRelease: vi.fn(),
  getCommitsSinceLastRelease: vi.fn(),
  updatePackageVersion: vi.fn(),
  createRelease: vi.fn(),
  createReleasePullRequest: vi.fn(),
  addLabel: vi.fn(),
  getPullRequestFromCommit: vi.fn(),
  wasReleasePR: vi.fn(),
  getManifestFromMain: vi.fn(),
  wasManifestUpdatedInLastCommit: vi.fn(),
  getLastReleaseVersion: vi.fn(),
  getChangelogForPackage: vi.fn(),
  findReleasePRByVersions: vi.fn(),
  isDeletedReleaseBranch: vi.fn(),
  getLatestRcVersion: vi.fn(),
  createComment: vi.fn(),
  onMainBranch: vi.fn(),
  isPullRequestMerged: vi.fn(),
  getPullRequestNumberFromContext: vi.fn(),
  getReleaseTargetToLatestChanges: vi.fn(),
  createVersionBumpPullRequest: vi.fn(),
  getContextSha: vi.fn()
}
vi.mock('./github.js', () => ({
  GitHubService: vi.fn(function () {
    return githubServiceMock
  })
}))

let run: () => Promise<void>
const mockManifest = {
  'packages/core': {
    latest: '1.0.0',
    main: '1.0.0',
    canary: '1.0.0'
  },
  'packages/utils': {
    latest: '2.1.0',
    main: '2.1.0',
    canary: '2.1.0'
  }
}

describe('main.ts', () => {
  beforeAll(async () => {
    run = (await import('./main.js')).run
  })

  beforeEach(() => {
    vi.clearAllMocks()
    // Mock core.getInput
    ;(core.getInput as Mock).mockImplementation((name: string) => {
      switch (name) {
        case 'token':
          return 'test-token'
        case 'manifest-file':
          return '.release-manifest.json'
        case 'create-prereleases':
          return 'false'
        case 'prerelease-label':
          return 'Prerelease'
        case 'root-dir':
          return '.'
        case 'release-target':
          return 'main'
        default:
          return ''
      }
    })
    // Mock getManifestFromMain
    githubServiceMock.getManifestFromMain.mockResolvedValue(mockManifest)
    githubServiceMock.isDeletedReleaseBranch.mockResolvedValue(false)
    githubServiceMock.getReleaseTargetToLatestChanges.mockReturnValue([])
    githubServiceMock.getPullRequestNumberFromContext.mockReturnValue(null)
    githubServiceMock.getContextSha.mockReturnValue('abc123sha')
  })

  it('should exit early if no changes requiring version updates are found', async () => {
    githubServiceMock.getPullRequestLabels.mockResolvedValue([])
    githubServiceMock.getAllCommitsSinceLastRelease.mockResolvedValue([])
    await run()
    expect(core.info).toHaveBeenCalledWith(
      'No changes requiring version updates found'
    )
  })

  it('should handle prerelease PRs correctly', async () => {
    const mockCommits = ['feat(core): add new feature', 'fix(utils): fix bug']
    githubServiceMock.getPullRequestLabels.mockResolvedValue([
      'Prerelease',
      'release-target:canary'
    ])
    githubServiceMock.getAllCommitsSinceLastRelease.mockResolvedValue(
      mockCommits
    )
    githubServiceMock.getCommitsSinceLastRelease.mockResolvedValue(mockCommits)
    githubServiceMock.getLatestRcVersion.mockResolvedValue(1)
    githubServiceMock.createReleasePullRequest.mockResolvedValue(undefined)
    ;(core.getInput as Mock).mockImplementation((name: string) => {
      if (name === 'create-prereleases') return 'true'
      if (name === 'prerelease-label') return 'Prerelease'
      if (name === 'release-target') return 'canary'
      return ''
    })
    await run()
    expect(githubServiceMock.createReleasePullRequest).not.toHaveBeenCalled()
    expect(core.setOutput).toHaveBeenCalledWith('prerelease', true)
  })

  it('should handle regular releases correctly', async () => {
    const mockCommits = ['feat(core): add new feature', 'fix(utils): fix bug']
    githubServiceMock.getPullRequestLabels.mockResolvedValue([])
    githubServiceMock.getAllCommitsSinceLastRelease.mockResolvedValue(
      mockCommits
    )
    githubServiceMock.getCommitsSinceLastRelease.mockResolvedValue(mockCommits)
    githubServiceMock.createReleasePullRequest.mockResolvedValue(undefined)
    githubServiceMock.onMainBranch.mockResolvedValue(true)
    ;(core.getInput as Mock).mockImplementation((name: string) => {
      if (name === 'release-target') return 'canary'
      return ''
    })
    await run()
    expect(githubServiceMock.createReleasePullRequest).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          releaseTarget: 'canary'
        })
      ]),
      'release-me'
    )
  })

  it('should handle errors gracefully', async () => {
    githubServiceMock.getPullRequestLabels.mockRejectedValue(
      new Error('API Error')
    )
    githubServiceMock.getAllCommitsSinceLastRelease.mockResolvedValue([])
    githubServiceMock.getCommitsSinceLastRelease.mockResolvedValue([])
    githubServiceMock.updatePackageVersion.mockResolvedValue(undefined)
    githubServiceMock.createRelease.mockResolvedValue(undefined)
    githubServiceMock.createReleasePullRequest.mockResolvedValue(undefined)
    await run()
    expect(core.setFailed).toHaveBeenCalledWith('API Error')
  })

  it('should add released label on a deleted release branch when a PR number is available', async () => {
    githubServiceMock.getPullRequestLabels.mockResolvedValue([
      'release-me',
      'release-target:main'
    ])
    githubServiceMock.isDeletedReleaseBranch.mockResolvedValue(true)
    githubServiceMock.getPullRequestNumberFromContext.mockReturnValue(789)
    await run()
    expect(githubServiceMock.addLabel).toHaveBeenCalledWith('released', 789)
  })

  it('should skip adding released label on a deleted release branch when no PR number is available', async () => {
    githubServiceMock.getPullRequestLabels.mockResolvedValue([
      'release-me',
      'release-target:main'
    ])
    githubServiceMock.isDeletedReleaseBranch.mockResolvedValue(true)
    githubServiceMock.getPullRequestNumberFromContext.mockReturnValue(null)
    await run()
    expect(githubServiceMock.addLabel).not.toHaveBeenCalled()
    expect(core.info).toHaveBeenCalledWith(
      'Seems we are on an old release branch that does not exist anymore, nothing else to do here'
    )
  })

  it('should skip if PR is labeled with released', async () => {
    githubServiceMock.getPullRequestLabels.mockResolvedValue([
      'released',
      'release-target:main'
    ])
    githubServiceMock.getAllCommitsSinceLastRelease.mockResolvedValue([])
    githubServiceMock.getCommitsSinceLastRelease.mockResolvedValue([])
    githubServiceMock.updatePackageVersion.mockResolvedValue(undefined)
    githubServiceMock.createRelease.mockResolvedValue(undefined)
    githubServiceMock.createReleasePullRequest.mockResolvedValue(undefined)
    githubServiceMock.onMainBranch.mockResolvedValue(false)
    await run()
    expect(core.info).toHaveBeenCalledWith(
      'This PR has already been released, skipping'
    )
  })

  it('should create release when PR has release-me tag', async () => {
    const mockCommits = [
      {
        commit: {
          message: 'chore: release core@1.1.0'
        },
        sha: 'abc123'
      }
    ]
    githubServiceMock.onMainBranch.mockResolvedValue(false)
    githubServiceMock.isPullRequestMerged.mockResolvedValue(true)
    githubServiceMock.getPullRequestNumberFromContext.mockReturnValue(123)
    githubServiceMock.getPullRequestLabels.mockResolvedValue([
      'release-me',
      'release-target:canary'
    ])
    githubServiceMock.getAllCommitsSinceLastRelease.mockResolvedValue(
      mockCommits
    )
    githubServiceMock.getCommitsSinceLastRelease.mockResolvedValue([
      'feat(core): add new feature'
    ])
    githubServiceMock.createRelease.mockResolvedValue(undefined)
    githubServiceMock.getPullRequestFromCommit.mockResolvedValue(123)
    githubServiceMock.wasReleasePR.mockResolvedValue(true)
    githubServiceMock.getLastReleaseVersion.mockResolvedValue('1.0.0')
    githubServiceMock.getChangelogForPackage.mockResolvedValue(
      '## 1.1.0\n\n- New feature'
    )
    githubServiceMock.addLabel.mockResolvedValue(undefined)
    ;(core.getInput as Mock).mockImplementation((name: string) => {
      if (name === 'release-target') return 'canary'
      return ''
    })
    await run()
    expect(githubServiceMock.createRelease).toHaveBeenCalled()
    expect(githubServiceMock.addLabel).toHaveBeenCalledWith('released', 123)
    expect(core.setOutput).toHaveBeenCalledWith('prerelease', false)
    expect(core.setOutput).toHaveBeenCalledWith(
      'versions',
      JSON.stringify([
        {
          name: 'core',
          path: 'packages/core',
          target: 'canary',
          version: '1.1.0'
        },
        {
          name: 'utils',
          path: 'packages/utils',
          target: 'canary',
          version: '2.2.0'
        }
      ])
    )
  })

  it('should create PR with release-me tag when pushing to main', async () => {
    const mockCommits = ['feat(core): add new feature']
    githubServiceMock.getPullRequestLabels.mockResolvedValue([])
    githubServiceMock.getAllCommitsSinceLastRelease.mockResolvedValue([
      { commit: { message: 'feat: new feature' } }
    ])
    githubServiceMock.getCommitsSinceLastRelease.mockResolvedValue(mockCommits)
    githubServiceMock.getPullRequestFromCommit.mockResolvedValue(null)
    githubServiceMock.wasReleasePR.mockResolvedValue(false)
    githubServiceMock.createReleasePullRequest.mockResolvedValue(undefined)
    githubServiceMock.onMainBranch.mockResolvedValue(true)
    ;(core.getInput as Mock).mockImplementation((name: string) => {
      if (name === 'release-target') return 'canary'
      return ''
    })
    await run()
    expect(githubServiceMock.createReleasePullRequest).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          releaseTarget: 'canary'
        })
      ]),
      'release-me'
    )
  })

  it('should skip if prereleases are disabled and PR is labeled as prerelease', async () => {
    githubServiceMock.getPullRequestLabels.mockResolvedValue(['Prerelease'])
    ;(core.getInput as Mock).mockImplementation((name: string) => {
      if (name === 'create-prereleases') return 'false'
      if (name === 'prerelease-label') return 'Prerelease'
      if (name === 'release-target') return 'main'
      return ''
    })
    await run()
    expect(githubServiceMock.createComment).toHaveBeenCalledWith(
      expect.stringContaining('⚠️ Prereleases are currently disabled')
    )
  })

  it('should skip packages with no commits', async () => {
    githubServiceMock.getPullRequestLabels.mockResolvedValue([])
    githubServiceMock.getAllCommitsSinceLastRelease.mockResolvedValue([])
    githubServiceMock.getCommitsSinceLastRelease.mockResolvedValue([])
    await run()
    expect(core.info).toHaveBeenCalledWith(
      'No changes requiring version updates found'
    )
  })

  it('should handle unknown errors', async () => {
    githubServiceMock.getPullRequestLabels.mockRejectedValue('string error')
    await run()
    expect(core.setFailed).toHaveBeenCalledWith('An unknown error occurred')
  })

  it('should handle empty commits array for a specific package', async () => {
    githubServiceMock.getPullRequestLabels.mockResolvedValue([])
    githubServiceMock.getAllCommitsSinceLastRelease.mockResolvedValue([])
    githubServiceMock.getCommitsSinceLastRelease.mockResolvedValue([])
    ;(core.getInput as Mock).mockImplementation((name: string) => {
      if (name === 'manifest-file') return '.release-manifest.json'
      if (name === 'release-target') return 'canary'
      return ''
    })
    ;(fs.readFileSync as unknown as Mock).mockReturnValue(
      JSON.stringify({
        'packages/core': {
          latest: '1.0.0',
          main: '1.0.0',
          canary: '1.0.0'
        },
        'packages/utils': {
          latest: '2.1.0',
          main: '2.1.0',
          canary: '2.1.0'
        }
      })
    )
    await run()
    expect(core.info).toHaveBeenCalledWith(
      'No changes requiring version updates found'
    )
  })

  it('should create release when manifest was updated in last commit', async () => {
    const mockCommits = [
      {
        commit: {
          message: 'chore: release core@1.1.0'
        },
        sha: 'abc123'
      }
    ]
    githubServiceMock.getPullRequestLabels.mockResolvedValue([])
    githubServiceMock.getAllCommitsSinceLastRelease.mockResolvedValue(
      mockCommits
    )
    githubServiceMock.getCommitsSinceLastRelease.mockResolvedValue([
      'feat(core): add new feature'
    ])
    githubServiceMock.createRelease.mockResolvedValue(undefined)
    githubServiceMock.getPullRequestFromCommit.mockResolvedValue(null) // No PR found (squashed merge)
    githubServiceMock.wasManifestUpdatedInLastCommit.mockResolvedValue(true) // Manifest was updated
    githubServiceMock.getLastReleaseVersion.mockResolvedValue('1.0.0')
    githubServiceMock.getChangelogForPackage.mockResolvedValue(
      '## 1.1.0\n\n- New feature'
    )
    githubServiceMock.addLabel.mockResolvedValue(undefined)
    ;(core.getInput as Mock).mockImplementation((name: string) => {
      if (name === 'release-target') return 'canary'
      return ''
    })
    await run()
    expect(githubServiceMock.createRelease).toHaveBeenCalled()
    expect(core.setOutput).toHaveBeenCalledWith('prerelease', false)
    expect(core.setOutput).toHaveBeenCalledWith(
      'versions',
      JSON.stringify([
        {
          name: 'core',
          path: 'packages/core',
          target: 'canary',
          version: '1.1.0'
        },
        {
          name: 'utils',
          path: 'packages/utils',
          target: 'canary',
          version: '2.2.0'
        }
      ])
    )
  })

  it('threads the overwrite-existing-tags input through to createRelease', async () => {
    const mockCommits = [
      {
        commit: {
          message: 'chore: release core@1.1.0'
        },
        sha: 'abc123'
      }
    ]
    githubServiceMock.getPullRequestLabels.mockResolvedValue([])
    githubServiceMock.getAllCommitsSinceLastRelease.mockResolvedValue(
      mockCommits
    )
    githubServiceMock.getCommitsSinceLastRelease.mockResolvedValue([
      'feat(core): add new feature'
    ])
    githubServiceMock.createRelease.mockResolvedValue(undefined)
    githubServiceMock.getPullRequestFromCommit.mockResolvedValue(null)
    githubServiceMock.wasManifestUpdatedInLastCommit.mockResolvedValue(true)
    githubServiceMock.getLastReleaseVersion.mockResolvedValue('1.0.0')
    githubServiceMock.getChangelogForPackage.mockResolvedValue(
      '## 1.1.0\n\n- New feature'
    )
    githubServiceMock.addLabel.mockResolvedValue(undefined)
    ;(core.getInput as Mock).mockImplementation((name: string) => {
      if (name === 'release-target') return 'canary'
      if (name === 'overwrite-existing-tags') return 'true'
      return ''
    })

    await run()

    expect(githubServiceMock.createRelease).toHaveBeenCalledWith(
      expect.any(Array),
      false,
      true
    )
  })

  // Regression coverage for the tag-collision behavior decision: a
  // colliding tag is a hard failure (createRelease throws), and main's
  // top-level try/catch must turn that into core.setFailed like any other
  // real error, not a swallowed/partial success.
  it('fails the run via core.setFailed when createRelease throws on a tag collision', async () => {
    const mockCommits = [
      {
        commit: {
          message: 'chore: release core@1.1.0'
        },
        sha: 'abc123'
      }
    ]
    githubServiceMock.getPullRequestLabels.mockResolvedValue([])
    githubServiceMock.getAllCommitsSinceLastRelease.mockResolvedValue(
      mockCommits
    )
    githubServiceMock.getCommitsSinceLastRelease.mockResolvedValue([
      'feat(core): add new feature'
    ])
    githubServiceMock.createRelease.mockRejectedValue(
      new Error(
        'Tag core-v1.1.0 already exists. Refusing to overwrite it. Set the "overwrite-existing-tags" input to "true" to allow force-moving existing tags to the current commit.'
      )
    )
    githubServiceMock.getPullRequestFromCommit.mockResolvedValue(null)
    githubServiceMock.wasManifestUpdatedInLastCommit.mockResolvedValue(true)
    githubServiceMock.getLastReleaseVersion.mockResolvedValue('1.0.0')
    githubServiceMock.getChangelogForPackage.mockResolvedValue(
      '## 1.1.0\n\n- New feature'
    )
    ;(core.getInput as Mock).mockImplementation((name: string) => {
      if (name === 'release-target') return 'canary'
      return ''
    })

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('Tag core-v1.1.0 already exists')
    )
    expect(core.setOutput).not.toHaveBeenCalledWith('releases-created', true)
  })

  // Deprecated default: overwrite-existing-tags currently defaults to true
  // (matching pre-2.x force-move behavior) so this isn't a breaking change.
  // core.getInput() returns '' rather than action.yml's default outside a
  // real Actions runtime, so "unset" here must resolve to true too.
  it('defaults overwrite-existing-tags to true when unset, and warns about the deprecated default', async () => {
    const mockCommits = [
      {
        commit: {
          message: 'chore: release core@1.1.0'
        },
        sha: 'abc123'
      }
    ]
    githubServiceMock.getPullRequestLabels.mockResolvedValue([])
    githubServiceMock.getAllCommitsSinceLastRelease.mockResolvedValue(
      mockCommits
    )
    githubServiceMock.getCommitsSinceLastRelease.mockResolvedValue([
      'feat(core): add new feature'
    ])
    githubServiceMock.createRelease.mockResolvedValue(undefined)
    githubServiceMock.getPullRequestFromCommit.mockResolvedValue(null)
    githubServiceMock.wasManifestUpdatedInLastCommit.mockResolvedValue(true)
    githubServiceMock.getLastReleaseVersion.mockResolvedValue('1.0.0')
    githubServiceMock.getChangelogForPackage.mockResolvedValue(
      '## 1.1.0\n\n- New feature'
    )
    githubServiceMock.addLabel.mockResolvedValue(undefined)
    ;(core.getInput as Mock).mockImplementation((name: string) => {
      if (name === 'release-target') return 'canary'
      return ''
    })

    await run()

    expect(githubServiceMock.createRelease).toHaveBeenCalledWith(
      expect.any(Array),
      false,
      true
    )
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        '"overwrite-existing-tags" input currently defaults to "true"'
      )
    )
  })

  it('honors an explicit overwrite-existing-tags: "false" without warning', async () => {
    const mockCommits = [
      {
        commit: {
          message: 'chore: release core@1.1.0'
        },
        sha: 'abc123'
      }
    ]
    githubServiceMock.getPullRequestLabels.mockResolvedValue([])
    githubServiceMock.getAllCommitsSinceLastRelease.mockResolvedValue(
      mockCommits
    )
    githubServiceMock.getCommitsSinceLastRelease.mockResolvedValue([
      'feat(core): add new feature'
    ])
    githubServiceMock.createRelease.mockResolvedValue(undefined)
    githubServiceMock.getPullRequestFromCommit.mockResolvedValue(null)
    githubServiceMock.wasManifestUpdatedInLastCommit.mockResolvedValue(true)
    githubServiceMock.getLastReleaseVersion.mockResolvedValue('1.0.0')
    githubServiceMock.getChangelogForPackage.mockResolvedValue(
      '## 1.1.0\n\n- New feature'
    )
    githubServiceMock.addLabel.mockResolvedValue(undefined)
    ;(core.getInput as Mock).mockImplementation((name: string) => {
      if (name === 'release-target') return 'canary'
      if (name === 'overwrite-existing-tags') return 'false'
      return ''
    })

    await run()

    expect(githubServiceMock.createRelease).toHaveBeenCalledWith(
      expect.any(Array),
      false,
      false
    )
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining(
        '"overwrite-existing-tags" input currently defaults to "true"'
      )
    )
  })

  it('should find release PR by versions when commit lookup fails', async () => {
    const mockCommits = [
      {
        commit: {
          message: 'chore: release core@1.1.0'
        },
        sha: 'abc456'
      }
    ]
    githubServiceMock.getPullRequestLabels.mockResolvedValue([
      'release-me',
      'release-target:canary'
    ])
    githubServiceMock.getAllCommitsSinceLastRelease.mockResolvedValue(
      mockCommits
    )
    githubServiceMock.getCommitsSinceLastRelease.mockResolvedValue([
      'feat(core): add new feature'
    ])
    githubServiceMock.createRelease.mockResolvedValue(undefined)
    githubServiceMock.getPullRequestFromCommit.mockResolvedValue(null) // No PR found from commit
    githubServiceMock.findReleasePRByVersions.mockImplementation(() =>
      Promise.resolve(456)
    )
    githubServiceMock.wasReleasePR.mockResolvedValue(true)
    githubServiceMock.getLastReleaseVersion.mockResolvedValue('1.0.0')
    githubServiceMock.getChangelogForPackage.mockResolvedValue(
      '## 1.1.0\n\n- New feature'
    )
    githubServiceMock.addLabel.mockResolvedValue(undefined)
    githubServiceMock.wasManifestUpdatedInLastCommit.mockResolvedValue(false)
    ;(core.getInput as Mock).mockImplementation((name: string) => {
      if (name === 'release-target') return 'canary'
      return ''
    })
    await run()
    expect(githubServiceMock.createRelease).toHaveBeenCalled()
    expect(githubServiceMock.addLabel).toHaveBeenCalledWith('released', 456)
    expect(core.setOutput).toHaveBeenCalledWith('prerelease', false)
    expect(core.setOutput).toHaveBeenCalledWith(
      'versions',
      JSON.stringify([
        {
          name: 'core',
          path: 'packages/core',
          target: 'canary',
          version: '1.1.0'
        },
        {
          name: 'utils',
          path: 'packages/utils',
          target: 'canary',
          version: '2.2.0'
        }
      ])
    )
  })

  it('should handle prerelease PRs with RC versions', async () => {
    const mockCommits = ['feat(core): add new feature', 'fix(utils): fix bug']
    githubServiceMock.getPullRequestLabels.mockResolvedValue([
      'Prerelease',
      'release-target:canary'
    ])
    githubServiceMock.getAllCommitsSinceLastRelease.mockResolvedValue(
      mockCommits
    )
    githubServiceMock.getCommitsSinceLastRelease.mockResolvedValue(mockCommits)
    githubServiceMock.getLatestRcVersion.mockResolvedValue(2)
    githubServiceMock.createReleasePullRequest.mockResolvedValue(undefined)
    ;(core.getInput as Mock).mockImplementation((name: string) => {
      if (name === 'create-prereleases') return 'true'
      if (name === 'prerelease-label') return 'Prerelease'
      if (name === 'release-target') return 'canary'
      return ''
    })
    githubServiceMock.wasManifestUpdatedInLastCommit.mockResolvedValue(false)
    await run()
    expect(githubServiceMock.createReleasePullRequest).not.toHaveBeenCalled()
    expect(core.setOutput).toHaveBeenCalledWith('prerelease', true)
  })

  it('should create a version bump PR when release target lags behind latest', async () => {
    githubServiceMock.getPullRequestLabels.mockResolvedValue([])
    githubServiceMock.getAllCommitsSinceLastRelease.mockResolvedValue([])
    const changesToLatest = [
      {
        name: 'core',
        path: 'packages/core',
        currentVersion: '0.9.0',
        newVersion: '1.0.0',
        commits: [],
        changelog: 'Bumped canary to 1.0.0',
        releaseTarget: 'canary'
      }
    ]
    githubServiceMock.getReleaseTargetToLatestChanges.mockReturnValue(
      changesToLatest
    )
    githubServiceMock.createVersionBumpPullRequest.mockResolvedValue(undefined)
    ;(core.getInput as Mock).mockImplementation((name: string) => {
      if (name === 'release-target') return 'canary'
      return ''
    })
    await run()
    expect(githubServiceMock.createVersionBumpPullRequest).toHaveBeenCalledWith(
      changesToLatest,
      'release-me'
    )
    expect(core.setOutput).toHaveBeenCalledWith('releases-created', true)
    expect(core.setOutput).toHaveBeenCalledWith('version', '1.0.0')
  })

  it('should warn if release-target is "latest"', async () => {
    ;(core.getInput as Mock).mockImplementation((name: string) => {
      if (name === 'release-target') return 'latest'
      return ''
    })
    await run()
    expect(core.warning).toHaveBeenCalledWith(
      'Setting release-target to "latest" will only update the latest release version'
    )
  })
})
