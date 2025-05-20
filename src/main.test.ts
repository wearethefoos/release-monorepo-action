import { describe, it, expect, beforeAll, beforeEach, vi, Mock } from 'vitest'
import * as core from '../__fixtures__/core.js'
import * as fs from 'fs'

// Mock dependencies
vi.mock('@actions/core', () => core)
vi.mock('fs', () => ({
  readFileSync: vi.fn()
}))

// --- GitHubService mock setup ---
const githubServiceMock = {
  getPullRequestLabels: vi.fn(),
  getCommitsSinceLastRelease: vi.fn(),
  updatePackageVersion: vi.fn(),
  createRelease: vi.fn(),
  createReleasePullRequest: vi.fn()
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
    core.getInput.mockImplementation((name: string) => {
      switch (name) {
        case 'token':
          return 'test-token'
        case 'manifest-file':
          return '.release-manifest.json'
        case 'create-pre-releases':
          return 'false'
        case 'pre-release-label':
          return 'Pre-Release'
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
    githubServiceMock.getCommitsSinceLastRelease.mockResolvedValue([])
    await run()
    expect(core.info).toHaveBeenCalledWith(
      'No changes requiring version updates found'
    )
  })

  it('should handle pre-release PRs correctly', async () => {
    const mockCommits = ['feat(core): add new feature', 'fix(utils): fix bug']
    githubServiceMock.getPullRequestLabels.mockResolvedValue(['Pre-Release'])
    githubServiceMock.getCommitsSinceLastRelease.mockResolvedValue(mockCommits)
    githubServiceMock.createReleasePullRequest.mockResolvedValue(undefined)
    githubServiceMock.updatePackageVersion.mockResolvedValue(undefined)
    githubServiceMock.createRelease.mockResolvedValue(undefined)
    core.getInput.mockImplementation((name: string) => {
      if (name === 'create-pre-releases') return 'true'
      if (name === 'pre-release-label') return 'Pre-Release'
      return ''
    })
    await run()
    console.log('Changes:', mockCommits)
    console.log(
      'createReleasePullRequest result:',
      await githubServiceMock.createReleasePullRequest()
    )
    expect(core.setOutput).toHaveBeenCalledWith('version', expect.any(String))
    expect(core.setOutput).toHaveBeenCalledWith('pre-release', true)
  })

  it('should handle regular releases correctly', async () => {
    const mockCommits = ['feat(core): add new feature', 'fix(utils): fix bug']
    githubServiceMock.getPullRequestLabels.mockResolvedValue([])
    githubServiceMock.getCommitsSinceLastRelease.mockResolvedValue(mockCommits)
    githubServiceMock.createRelease.mockResolvedValue(undefined)
    githubServiceMock.updatePackageVersion.mockResolvedValue(undefined)
    githubServiceMock.createReleasePullRequest.mockResolvedValue(undefined)
    await run()
    expect(core.setOutput).toHaveBeenCalledWith('version', expect.any(String))
    expect(core.setOutput).toHaveBeenCalledWith('pre-release', false)
  })

  it('should handle errors gracefully', async () => {
    githubServiceMock.getPullRequestLabels.mockRejectedValue(
      new Error('API Error')
    )
    githubServiceMock.getCommitsSinceLastRelease.mockResolvedValue([])
    githubServiceMock.updatePackageVersion.mockResolvedValue(undefined)
    githubServiceMock.createRelease.mockResolvedValue(undefined)
    githubServiceMock.createReleasePullRequest.mockResolvedValue(undefined)
    await run()
    expect(core.setFailed).toHaveBeenCalledWith('API Error')
  })

  it('should skip if PR is labeled with release-me', async () => {
    githubServiceMock.getPullRequestLabels.mockResolvedValue(['release-me'])
    githubServiceMock.getCommitsSinceLastRelease.mockResolvedValue([])
    githubServiceMock.updatePackageVersion.mockResolvedValue(undefined)
    githubServiceMock.createRelease.mockResolvedValue(undefined)
    githubServiceMock.createReleasePullRequest.mockResolvedValue(undefined)
    await run()
    expect(core.info).toHaveBeenCalledWith(
      'This is a release PR, skipping version calculation'
    )
  })

  it('should skip if pre-releases are disabled and PR is labeled as pre-release', async () => {
    githubServiceMock.getPullRequestLabels.mockResolvedValue(['Pre-Release'])
    core.getInput.mockImplementation((name: string) => {
      if (name === 'create-pre-releases') return 'false'
      if (name === 'pre-release-label') return 'Pre-Release'
      return ''
    })
    await run()
    expect(core.info).toHaveBeenCalledWith(
      'Pre-releases are disabled and this is a pre-release PR, skipping'
    )
  })

  it('should skip packages with no commits', async () => {
    githubServiceMock.getPullRequestLabels.mockResolvedValue([])
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
    githubServiceMock.getCommitsSinceLastRelease.mockResolvedValue([])
    core.getInput.mockImplementation((name: string) => {
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
