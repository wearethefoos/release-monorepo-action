import { describe, it, expect, beforeEach, vi, beforeAll } from 'vitest'
import * as core from '@actions/core'
import * as fs from 'fs'
import type { Mock } from 'vitest'

vi.mock('@actions/core', () => ({
  info: vi.fn(),
  debug: (...args: unknown[]) => {
    console.log('[core.debug]', ...args)
  },
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
  createComment: vi.fn()
}
vi.mock('./github.js', () => ({
  GitHubService: vi.fn(() => githubServiceMock)
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
    githubServiceMock.getPullRequestLabels.mockResolvedValue(['Prerelease'])
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

  it('should skip if PR is labeled with released', async () => {
    githubServiceMock.getPullRequestLabels.mockResolvedValue(['released'])
    githubServiceMock.getAllCommitsSinceLastRelease.mockResolvedValue([])
    githubServiceMock.getCommitsSinceLastRelease.mockResolvedValue([])
    githubServiceMock.updatePackageVersion.mockResolvedValue(undefined)
    githubServiceMock.createRelease.mockResolvedValue(undefined)
    githubServiceMock.createReleasePullRequest.mockResolvedValue(undefined)
    await run()
    expect(core.info).toHaveBeenCalledWith(
      'This PR has already been released, skipping'
    )
  })

  it('should create release when PR has release-me tag', async () => {
    const mockCommits = [
      {
        commit: {
          message: 'chore: release packages/core@1.1.0'
        },
        sha: 'abc123'
      }
    ]
    githubServiceMock.getPullRequestLabels.mockResolvedValue(['release-me'])
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
          path: 'packages/core',
          target: 'canary',
          version: '1.1.0'
        },
        {
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
          message: 'chore: release packages/core@1.1.0'
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
          path: 'packages/core',
          target: 'canary',
          version: '1.1.0'
        },
        {
          path: 'packages/utils',
          target: 'canary',
          version: '2.2.0'
        }
      ])
    )
  })

  it('should find release PR by versions when commit lookup fails', async () => {
    const mockCommits = [
      {
        commit: {
          message: 'chore: release packages/core@1.1.0'
        },
        sha: 'abc123'
      }
    ]
    githubServiceMock.getPullRequestLabels.mockResolvedValue(['release-me'])
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
          path: 'packages/core',
          target: 'canary',
          version: '1.1.0'
        },
        {
          path: 'packages/utils',
          target: 'canary',
          version: '2.2.0'
        }
      ])
    )
  })

  it('should handle prerelease PRs with RC versions', async () => {
    const mockCommits = ['feat(core): add new feature', 'fix(utils): fix bug']
    githubServiceMock.getPullRequestLabels.mockResolvedValue(['Prerelease'])
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

  it('should throw error if release-target is "latest"', async () => {
    ;(core.getInput as Mock).mockImplementation((name: string) => {
      if (name === 'release-target') return 'latest'
      return ''
    })
    await run()
    expect(core.setFailed).toHaveBeenCalledWith(
      'release-target cannot be "latest", because it is reserved for the latest release'
    )
  })
})
