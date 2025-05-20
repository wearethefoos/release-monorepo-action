import { describe, it, expect, beforeEach, vi } from 'vitest'
import { GitHubService } from './github.js'
import * as core from '../__fixtures__/core.js'
import { PackageChanges, ConventionalCommit } from './types.js'

// Mock dependencies
vi.mock('@actions/core', () => core)
vi.mock('@actions/github', () => ({
  context: {
    repo: {
      owner: 'test-owner',
      repo: 'test-repo'
    },
    payload: {
      pull_request: {
        number: 123,
        base: {
          ref: 'main'
        },
        head: {
          ref: 'feature-branch'
        }
      },
      ref: 'refs/heads/main'
    },
    ref: 'refs/heads/main'
  },
  getOctokit: vi.fn()
}))

describe('GitHubService', () => {
  let githubService: GitHubService
  const mockOctokit = {
    pulls: {
      get: vi.fn(),
      update: vi.fn()
    },
    issues: {
      addLabels: vi.fn(),
      listLabelsOnIssue: vi.fn(),
      createComment: vi.fn()
    },
    repos: {
      compareCommits: vi.fn(),
      createRelease: vi.fn(),
      createPullRequest: vi.fn()
    },
    git: {
      createRef: vi.fn(),
      updateRef: vi.fn()
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    githubService = new GitHubService('test-token')
    ;(githubService as any).octokit = mockOctokit
  })

  describe('getPullRequestLabels', () => {
    it('should return labels from PR', async () => {
      const mockLabels = [{ name: 'bug' }, { name: 'enhancement' }]
      mockOctokit.pulls.get.mockResolvedValue({
        data: { number: 123, labels: mockLabels }
      })

      const labels = await githubService.getPullRequestLabels()
      expect(labels).toEqual(['bug', 'enhancement'])
    })

    it('should handle API errors', async () => {
      mockOctokit.pulls.get.mockRejectedValue(new Error('API Error'))
      await expect(githubService.getPullRequestLabels()).rejects.toThrow(
        'API Error'
      )
    })
  })

  describe('getCommitsSinceLastRelease', () => {
    it('should return commits since last release', async () => {
      const mockCommits = {
        data: {
          commits: [
            {
              commit: { message: 'feat: add feature' },
              files: [{ filename: 'packages/core/src/index.ts' }]
            },
            {
              commit: { message: 'fix: fix bug' },
              files: [{ filename: 'packages/core/src/utils.ts' }]
            }
          ]
        }
      }
      mockOctokit.repos.compareCommits.mockResolvedValue(mockCommits)

      const commits =
        await githubService.getCommitsSinceLastRelease('packages/core')
      expect(commits).toEqual(['feat: add feature', 'fix: fix bug'])
    })

    it('should handle no commits found', async () => {
      mockOctokit.repos.compareCommits.mockResolvedValue({
        data: { commits: [] }
      })
      const commits =
        await githubService.getCommitsSinceLastRelease('packages/core')
      expect(commits).toEqual([])
    })

    it('should handle API errors', async () => {
      mockOctokit.repos.compareCommits.mockRejectedValue(new Error('API Error'))
      await expect(
        githubService.getCommitsSinceLastRelease('packages/core')
      ).rejects.toThrow('API Error')
    })
  })

  describe('createRelease', () => {
    it('should create a release', async () => {
      const mockRelease = {
        data: { html_url: 'https://github.com/test/release' }
      }
      mockOctokit.repos.createRelease.mockResolvedValue(mockRelease)
      const changes: PackageChanges[] = [
        {
          path: 'packages/core',
          currentVersion: '1.0.0',
          newVersion: '1.1.0',
          commits: [
            {
              type: 'feat',
              scope: 'core',
              breaking: false,
              message: 'feat(core): add feature',
              hash: 'abc123'
            }
          ],
          changelog: '## Changes\n\n- feat(core): add feature'
        }
      ]

      await githubService.createRelease(changes)
      expect(mockOctokit.repos.createRelease).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        tag_name: 'packages/core-v1.1.0',
        name: 'packages/core v1.1.0',
        body: '## Changes\n\n- feat(core): add feature',
        draft: false,
        prerelease: false
      })
    })

    it('should handle API errors', async () => {
      mockOctokit.repos.createRelease.mockRejectedValue(new Error('API Error'))
      const changes: PackageChanges[] = [
        {
          path: 'packages/core',
          currentVersion: '1.0.0',
          newVersion: '1.1.0',
          commits: [
            {
              type: 'feat',
              scope: 'core',
              breaking: false,
              message: 'feat(core): add feature',
              hash: 'abc123'
            }
          ],
          changelog: '## Changes\n\n- feat(core): add feature'
        }
      ]
      await expect(githubService.createRelease(changes)).rejects.toThrow(
        'API Error'
      )
    })
  })

  describe('createReleasePullRequest', () => {
    it('should create a release PR', async () => {
      const mockPR = {
        data: { number: 123, html_url: 'https://github.com/test/pull/1' }
      }
      mockOctokit.pulls.update.mockResolvedValue(mockPR)
      mockOctokit.issues.addLabels.mockResolvedValue({})
      const changes: PackageChanges[] = [
        {
          path: 'packages/core',
          currentVersion: '1.0.0',
          newVersion: '1.1.0',
          commits: [
            {
              type: 'feat',
              scope: 'core',
              breaking: false,
              message: 'feat(core): add feature',
              hash: 'abc123'
            }
          ],
          changelog: '## Changes\n\n- feat(core): add feature'
        }
      ]

      await githubService.createReleasePullRequest(changes)
      expect(mockOctokit.pulls.update).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        pull_number: 123,
        title: 'Release packages/core@1.1.0',
        body: expect.stringContaining('## Changes')
      })
      expect(mockOctokit.issues.addLabels).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        issue_number: 123,
        labels: ['release-me']
      })
    })

    it('should handle API errors', async () => {
      mockOctokit.pulls.update.mockRejectedValue(new Error('API Error'))
      const changes: PackageChanges[] = [
        {
          path: 'packages/core',
          currentVersion: '1.0.0',
          newVersion: '1.1.0',
          commits: [
            {
              type: 'feat',
              scope: 'core',
              breaking: false,
              message: 'feat(core): add feature',
              hash: 'abc123'
            }
          ],
          changelog: '## Changes\n\n- feat(core): add feature'
        }
      ]
      await expect(
        githubService.createReleasePullRequest(changes)
      ).rejects.toThrow('API Error')
    })
  })

  describe('updatePackageVersion', () => {
    it('should log update message', async () => {
      const consoleSpy = vi.spyOn(console, 'log')
      await githubService.updatePackageVersion('packages/core', '1.0.0')
      expect(consoleSpy).toHaveBeenCalledWith(
        'Would update packages/core to version 1.0.0'
      )
    })
  })
})
