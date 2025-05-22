import { describe, it, expect, beforeEach, vi, beforeAll } from 'vitest'
import * as core from '@actions/core'
import * as fs from 'fs'
import type { Mock } from 'vitest'

vi.mock('@actions/core', () => ({
  info: vi.fn(),
  debug: vi.fn(),
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
  wasReleasePR: vi.fn()
}
vi.mock('./github.js', () => ({
  GitHubService: vi.fn(() => githubServiceMock)
}))

let run: () => Promise<void>
const mockManifest = {
  'packages/core': '1.0.0',
  'packages/utils': '2.1.0'
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
        case 'create-prerelease':
          return 'false'
        case 'prerelease-label':
          return 'Prerelease'
        case 'root-dir':
          return '.'
        default:
          return ''
      }
    })
    // Mock fs.readFileSync
    ;(fs.readFileSync as unknown as Mock).mockReturnValue(
      JSON.stringify(mockManifest)
    )
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
    githubServiceMock.createReleasePullRequest.mockResolvedValue(undefined)
    ;(core.getInput as Mock).mockImplementation((name: string) => {
      if (name === 'create-prerelease') return 'true'
      if (name === 'prerelease-label') return 'Prerelease'
      return ''
    })
    await run()
    expect(githubServiceMock.createReleasePullRequest).toHaveBeenCalledWith(
      expect.any(Array),
      'release-me'
    )
  })

  it('should handle regular releases correctly', async () => {
    const mockCommits = ['feat(core): add new feature', 'fix(utils): fix bug']
    githubServiceMock.getPullRequestLabels.mockResolvedValue([])
    githubServiceMock.getAllCommitsSinceLastRelease.mockResolvedValue(
      mockCommits
    )
    githubServiceMock.getCommitsSinceLastRelease.mockResolvedValue(mockCommits)
    githubServiceMock.createReleasePullRequest.mockResolvedValue(undefined)
    await run()
    expect(githubServiceMock.createReleasePullRequest).toHaveBeenCalledWith(
      expect.any(Array),
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
    githubServiceMock.getPullRequestLabels.mockResolvedValue([])
    githubServiceMock.getAllCommitsSinceLastRelease.mockResolvedValue(
      mockCommits
    )
    githubServiceMock.getCommitsSinceLastRelease.mockResolvedValue([
      'feat(core): add new feature'
    ])
    githubServiceMock.updatePackageVersion.mockResolvedValue(undefined)
    githubServiceMock.createRelease.mockResolvedValue(undefined)
    githubServiceMock.getPullRequestFromCommit.mockResolvedValue(123)
    githubServiceMock.wasReleasePR.mockResolvedValue(true)
    githubServiceMock.addLabel.mockResolvedValue(undefined)
    await run()
    expect(githubServiceMock.updatePackageVersion).toHaveBeenCalled()
    expect(githubServiceMock.createRelease).toHaveBeenCalled()
    expect(githubServiceMock.addLabel).toHaveBeenCalledWith('released')
    expect(core.setOutput).toHaveBeenCalledWith('version', expect.any(String))
    expect(core.setOutput).toHaveBeenCalledWith('prerelease', false)
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
    await run()
    expect(githubServiceMock.createReleasePullRequest).toHaveBeenCalledWith(
      expect.any(Array),
      'release-me'
    )
  })

  it('should skip if prereleases are disabled and PR is labeled as prerelease', async () => {
    githubServiceMock.getPullRequestLabels.mockResolvedValue(['Prerelease'])
    ;(core.getInput as Mock).mockImplementation((name: string) => {
      if (name === 'create-prerelease') return 'false'
      if (name === 'prerelease-label') return 'Prerelease'
      return ''
    })
    await run()
    expect(core.info).toHaveBeenCalledWith(
      'prereleases are disabled and this is a prerelease PR, skipping'
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
      return ''
    })
    ;(fs.readFileSync as unknown as Mock).mockReturnValue(
      JSON.stringify({
        'packages/core': '1.0.0',
        'packages/utils': '2.1.0'
      })
    )
    await run()
    expect(core.info).toHaveBeenCalledWith(
      'No changes requiring version updates found'
    )
  })
})
