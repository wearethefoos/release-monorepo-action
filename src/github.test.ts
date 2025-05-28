import { context } from '@actions/github'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { GitHubService } from './github'
import { PackageChanges } from './types.js'
import * as fs from 'fs'
import * as path from 'path'
import * as core from '@actions/core'

// Mock @actions/core
vi.mock('@actions/core', () => ({
  info: vi.fn(),
  debug: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  warning: vi.fn()
}))

// Mock Octokit
const mockOctokit = {
  repos: {
    compareCommitsWithBasehead: vi.fn(),
    createRelease: vi.fn(),
    createPullRequest: vi.fn(),
    listReleases: vi.fn(),
    listCommits: vi.fn(),
    getBranch: vi.fn(),
    createOrUpdateFileContents: vi.fn(),
    getContent: vi.fn(),
    listPullRequestsAssociatedWithCommit: vi.fn(),
    getCommit: vi.fn()
  },
  git: {
    createRef: vi.fn(),
    getRef: vi.fn(),
    createBlob: vi.fn(),
    createTree: vi.fn(),
    createCommit: vi.fn(),
    updateRef: vi.fn()
  },
  pulls: {
    update: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    list: vi.fn()
  },
  issues: {
    addLabels: vi.fn(),
    removeLabel: vi.fn(),
    createComment: vi.fn()
  },
  request: vi.fn()
}

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn(() => mockOctokit)
}))

// Mock GitHub context
vi.mock('@actions/github', () => ({
  context: {
    payload: {
      pull_request: {
        number: 123,
        base: { ref: 'test-base' },
        head: { ref: 'test-head' }
      }
    },
    ref: 'test-ref',
    repo: {
      owner: 'test-owner',
      repo: 'test-repo'
    },
    sha: 'test-sha'
  }
}))

// Mock fs module
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn()
}))

describe('GitHubService', () => {
  let githubService: GitHubService

  beforeEach(() => {
    vi.clearAllMocks()
    githubService = new GitHubService('test-token')
    githubService.isDeletedReleaseBranch = vi.fn().mockResolvedValue(false)
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

  describe('getCommitCount', () => {
    it('should return commit count from Link header', async () => {
      const mockResponse = {
        headers: {
          link: '<https://api.github.com/repos/test-owner/test-repo/commits?page=2>; rel="next", <https://api.github.com/repos/test-owner/test-repo/commits?page=50>; rel="last"'
        }
      }

      mockOctokit.repos.listCommits.mockResolvedValue({
        data: [{ sha: 'test-sha' }]
      })

      mockOctokit.request.mockResolvedValue(mockResponse)

      const count = await githubService.getCommitCount()
      expect(count).toBe(50)
      expect(mockOctokit.repos.listCommits).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        sha: 'HEAD',
        per_page: 1
      })
    })

    it('should return 1 when no Link header is present', async () => {
      const mockResponse = {
        headers: {}
      }

      mockOctokit.repos.listCommits.mockResolvedValue({
        data: [{ sha: 'test-sha' }]
      })

      mockOctokit.request.mockResolvedValue(mockResponse)

      const count = await githubService.getCommitCount()
      expect(count).toBe(1)
    })

    it('should use provided ref', async () => {
      const mockResponse = {
        headers: {
          link: '<https://api.github.com/repos/test-owner/test-repo/commits?page=2>; rel="next", <https://api.github.com/repos/test-owner/test-repo/commits?page=50>; rel="last"'
        }
      }

      mockOctokit.repos.listCommits.mockResolvedValue({
        data: [{ sha: 'test-sha' }]
      })

      mockOctokit.request.mockResolvedValue(mockResponse)

      const count = await githubService.getCommitCount('main')
      expect(count).toBe(50)
      expect(mockOctokit.repos.listCommits).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        sha: 'main',
        per_page: 1
      })
    })
  })

  describe('getCommitsSinceLastRelease', () => {
    it('should return commits since last release', async () => {
      const mockReleases = {
        data: [
          {
            tag_name: 'packages/core-v1.0.0',
            prerelease: false
          }
        ]
      }
      mockOctokit.repos.listReleases.mockResolvedValue(mockReleases)
      mockOctokit.request
        .mockResolvedValueOnce({
          data: {
            commits: [
              { sha: 'abc123', commit: { message: 'feat: add feature' } },
              { sha: 'def456', commit: { message: 'fix: fix bug' } }
            ]
          },
          headers: {}
        })
        .mockResolvedValueOnce({
          data: {
            files: [{ filename: 'packages/core/src/index.ts' }]
          }
        })
        .mockResolvedValueOnce({
          data: {
            files: [{ filename: 'packages/core/src/utils.ts' }]
          }
        })

      const commits =
        await githubService.getCommitsSinceLastRelease('packages/core')
      expect(commits).toEqual(['feat: add feature', 'fix: fix bug'])
      expect(mockOctokit.request).toHaveBeenNthCalledWith(
        1,
        'GET /repos/{owner}/{repo}/compare/{basehead}',
        {
          owner: 'test-owner',
          repo: 'test-repo',
          basehead: 'packages/core-v1.0.0...test-head',
          mediaType: {
            format: 'json'
          },
          per_page: 100,
          page: 1
        }
      )
      expect(mockOctokit.request).toHaveBeenNthCalledWith(
        2,
        'GET /repos/{owner}/{repo}/commits/{ref}',
        {
          owner: 'test-owner',
          repo: 'test-repo',
          ref: 'abc123'
        }
      )
      expect(mockOctokit.request).toHaveBeenNthCalledWith(
        3,
        'GET /repos/{owner}/{repo}/commits/{ref}',
        {
          owner: 'test-owner',
          repo: 'test-repo',
          ref: 'def456'
        }
      )
    })

    it('should handle no previous release', async () => {
      const mockReleases = {
        data: []
      }
      const mockResponse = {
        headers: {
          link: '<https://api.github.com/repos/test-owner/test-repo/commits?page=2>; rel="next", <https://api.github.com/repos/test-owner/test-repo/commits?page=50>; rel="last"'
        }
      }

      mockOctokit.repos.listReleases.mockResolvedValue(mockReleases)
      mockOctokit.repos.listCommits.mockResolvedValue({
        data: [{ sha: 'test-sha' }]
      })
      mockOctokit.request
        .mockResolvedValueOnce(mockResponse) // For getCommitCount
        .mockResolvedValueOnce({
          data: {
            commits: [
              { sha: 'abc123', commit: { message: 'feat: add feature' } }
            ]
          },
          headers: {}
        })
        .mockResolvedValueOnce({
          data: {
            files: [{ filename: 'packages/core/src/index.ts' }]
          }
        })

      const commits =
        await githubService.getCommitsSinceLastRelease('packages/core')
      expect(commits).toEqual(['feat: add feature'])
      expect(mockOctokit.request).toHaveBeenNthCalledWith(
        1,
        'GET /repos/{owner}/{repo}/commits',
        {
          owner: 'test-owner',
          repo: 'test-repo',
          sha: 'HEAD',
          per_page: 1
        }
      )
      expect(mockOctokit.request).toHaveBeenNthCalledWith(
        2,
        'GET /repos/{owner}/{repo}/compare/{basehead}',
        {
          owner: 'test-owner',
          repo: 'test-repo',
          basehead: 'HEAD~49...test-head',
          mediaType: {
            format: 'json'
          },
          per_page: 100,
          page: 1
        }
      )
      expect(mockOctokit.request).toHaveBeenNthCalledWith(
        3,
        'GET /repos/{owner}/{repo}/commits/{ref}',
        {
          owner: 'test-owner',
          repo: 'test-repo',
          ref: 'abc123'
        }
      )
    })

    it('should ignore prereleases when finding last release', async () => {
      const mockReleases = {
        data: [
          {
            tag_name: 'packages/core-v1.1.0-rc.1',
            prerelease: true
          },
          {
            tag_name: 'packages/core-v1.0.0',
            prerelease: false
          }
        ]
      }
      mockOctokit.repos.listReleases.mockResolvedValue(mockReleases)
      mockOctokit.request
        .mockResolvedValueOnce({
          data: {
            commits: [
              { sha: 'abc123', commit: { message: 'feat: add feature' } }
            ]
          },
          headers: {}
        })
        .mockResolvedValueOnce({
          data: {
            files: [{ filename: 'packages/core/src/index.ts' }]
          }
        })

      const commits =
        await githubService.getCommitsSinceLastRelease('packages/core')
      expect(commits).toEqual(['feat: add feature'])
      expect(mockOctokit.request).toHaveBeenNthCalledWith(
        1,
        'GET /repos/{owner}/{repo}/compare/{basehead}',
        {
          owner: 'test-owner',
          repo: 'test-repo',
          basehead: 'packages/core-v1.0.0...test-head',
          mediaType: {
            format: 'json'
          },
          per_page: 100,
          page: 1
        }
      )
      expect(mockOctokit.request).toHaveBeenNthCalledWith(
        2,
        'GET /repos/{owner}/{repo}/commits/{ref}',
        {
          owner: 'test-owner',
          repo: 'test-repo',
          ref: 'abc123'
        }
      )
    })

    it('should handle no commits found', async () => {
      const mockReleases = {
        data: [
          {
            tag_name: 'packages/core-v1.0.0',
            prerelease: false
          }
        ]
      }
      mockOctokit.repos.listReleases.mockResolvedValue(mockReleases)
      mockOctokit.request.mockResolvedValue({
        data: {
          commits: []
        },
        headers: {}
      })

      const commits =
        await githubService.getCommitsSinceLastRelease('packages/core')
      expect(commits).toEqual([])
    })

    it('should handle API errors', async () => {
      mockOctokit.repos.listReleases.mockRejectedValue(new Error('API Error'))
      await expect(
        githubService.getCommitsSinceLastRelease('packages/core')
      ).rejects.toThrow('API Error')
    })

    it('should use commit count for fallback when no release exists', async () => {
      const mockReleases = {
        data: []
      }
      const mockResponse = {
        headers: {
          link: '<https://api.github.com/repos/test-owner/test-repo/commits?page=2>; rel="next", <https://api.github.com/repos/test-owner/test-repo/commits?page=50>; rel="last"'
        }
      }

      mockOctokit.repos.listReleases.mockResolvedValue(mockReleases)
      mockOctokit.repos.listCommits.mockResolvedValue({
        data: [{ sha: 'test-sha' }]
      })
      mockOctokit.request
        .mockResolvedValueOnce(mockResponse) // For getCommitCount
        .mockResolvedValueOnce({
          data: {
            commits: [
              { sha: 'abc123', commit: { message: 'feat: add feature' } }
            ]
          },
          headers: {}
        })
        .mockResolvedValueOnce({
          data: {
            files: [{ filename: 'packages/core/src/index.ts' }]
          }
        })

      const commits =
        await githubService.getCommitsSinceLastRelease('packages/core')
      expect(commits).toEqual(['feat: add feature'])
      expect(mockOctokit.request).toHaveBeenNthCalledWith(
        1,
        'GET /repos/{owner}/{repo}/commits',
        {
          owner: 'test-owner',
          repo: 'test-repo',
          sha: 'HEAD',
          per_page: 1
        }
      )
      expect(mockOctokit.request).toHaveBeenNthCalledWith(
        2,
        'GET /repos/{owner}/{repo}/compare/{basehead}',
        {
          owner: 'test-owner',
          repo: 'test-repo',
          basehead: 'HEAD~49...test-head',
          mediaType: {
            format: 'json'
          },
          per_page: 100,
          page: 1
        }
      )
      expect(mockOctokit.request).toHaveBeenNthCalledWith(
        3,
        'GET /repos/{owner}/{repo}/commits/{ref}',
        {
          owner: 'test-owner',
          repo: 'test-repo',
          ref: 'abc123'
        }
      )
    })

    it('should limit fallback to 50 commits', async () => {
      const mockReleases = {
        data: []
      }
      const mockResponse = {
        headers: {
          link: '<https://api.github.com/repos/test-owner/test-repo/commits?page=2>; rel="next", <https://api.github.com/repos/test-owner/test-repo/commits?page=2000>; rel="last"'
        }
      }

      mockOctokit.repos.listReleases.mockResolvedValue(mockReleases)
      mockOctokit.repos.listCommits.mockResolvedValue({
        data: [{ sha: 'test-sha' }]
      })
      mockOctokit.request
        .mockResolvedValueOnce(mockResponse) // For getCommitCount
        .mockResolvedValueOnce({
          data: {
            commits: [
              { sha: 'abc123', commit: { message: 'feat: add feature' } }
            ]
          },
          headers: {}
        })
        .mockResolvedValueOnce({
          data: {
            files: [{ filename: 'packages/core/src/index.ts' }]
          }
        })

      const commits =
        await githubService.getCommitsSinceLastRelease('packages/core')
      expect(commits).toEqual(['feat: add feature'])
      expect(mockOctokit.request).toHaveBeenNthCalledWith(
        2,
        'GET /repos/{owner}/{repo}/compare/{basehead}',
        {
          owner: 'test-owner',
          repo: 'test-repo',
          basehead: 'HEAD~49...test-head',
          mediaType: {
            format: 'json'
          },
          per_page: 100,
          page: 1
        }
      )
      expect(mockOctokit.request).toHaveBeenNthCalledWith(
        3,
        'GET /repos/{owner}/{repo}/commits/{ref}',
        {
          owner: 'test-owner',
          repo: 'test-repo',
          ref: 'abc123'
        }
      )
    })
  })

  describe('createRelease', () => {
    it('should create a release for a single package', async () => {
      const mockRelease = {
        data: { html_url: 'https://github.com/test/release' }
      }
      mockOctokit.repos.createRelease.mockResolvedValue(mockRelease)
      const changes: PackageChanges[] = [
        {
          releaseTarget: 'main',
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

    it('should create releases for multiple packages', async () => {
      const mockRelease = {
        data: { html_url: 'https://github.com/test/release' }
      }
      mockOctokit.repos.createRelease.mockResolvedValue(mockRelease)
      const changes: PackageChanges[] = [
        {
          releaseTarget: 'main',
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
        },
        {
          releaseTarget: 'main',
          path: 'packages/utils',
          currentVersion: '2.0.0',
          newVersion: '2.1.0-rc.1',
          commits: [
            {
              type: 'feat',
              scope: 'utils',
              breaking: false,
              message: 'feat(utils): add utility',
              hash: 'def456'
            }
          ],
          changelog: '## Changes\n\n- feat(utils): add utility'
        }
      ]

      await githubService.createRelease(changes)

      // Verify both releases were created
      expect(mockOctokit.repos.createRelease).toHaveBeenCalledTimes(2)
      expect(mockOctokit.repos.createRelease).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        tag_name: 'packages/core-v1.1.0',
        name: 'packages/core v1.1.0',
        body: '## Changes\n\n- feat(core): add feature',
        draft: false,
        prerelease: false
      })
      expect(mockOctokit.repos.createRelease).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        tag_name: 'packages/utils-v2.1.0-rc.1',
        name: 'packages/utils v2.1.0-rc.1',
        body: '## Changes\n\n- feat(utils): add utility',
        draft: false,
        prerelease: true
      })
    })

    it('should handle API errors', async () => {
      mockOctokit.repos.createRelease.mockRejectedValue(new Error('API Error'))
      const changes: PackageChanges[] = [
        {
          releaseTarget: 'main',
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
    it('should update an existing PR', async () => {
      const mockPR = {
        data: { number: 123, html_url: 'https://github.com/test/pull/1' }
      }
      mockOctokit.pulls.update.mockResolvedValue(mockPR)
      mockOctokit.repos.getBranch.mockResolvedValue({
        data: { commit: { sha: 'main-sha' } }
      })
      mockOctokit.git.createBlob.mockResolvedValue({
        data: { sha: 'blob-sha' }
      })
      mockOctokit.git.getRef.mockResolvedValue({
        data: { object: { sha: 'branch-sha' } }
      })
      mockOctokit.git.createTree.mockResolvedValue({
        data: { sha: 'tree-sha' }
      })
      mockOctokit.git.createCommit.mockResolvedValue({
        data: { sha: 'commit-sha' }
      })
      mockOctokit.pulls.list.mockResolvedValue({
        data: [
          {
            number: 123,
            title: 'chore: release packages/core@1.0.0',
            body: 'Old changelog',
            labels: [{ name: 'release-me' }],
            head: { ref: 'release-1.0.0-2024-01-01' }
          }
        ]
      })
      const packageJsonPath = 'packages/core/package.json'
      const changelogPath = 'packages/core/CHANGELOG.md'
      const manifestPath = '.release-manifest.json'
      vi.mocked(fs.existsSync).mockImplementation(
        (p) =>
          p === packageJsonPath || p === changelogPath || p === manifestPath
      )
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (p === packageJsonPath)
          return JSON.stringify({ name: 'core', version: '1.0.0' })
        if (p === changelogPath) return '## 1.0.0\n\n- Initial release\n'
        if (p === manifestPath)
          return JSON.stringify({
            'packages/core': { latest: '1.0.0', main: '1.0.0' }
          })
        return ''
      })
      const changes: PackageChanges[] = [
        {
          releaseTarget: 'main',
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
      await githubService.createReleasePullRequest(changes, 'release-me')
      expect(mockOctokit.pulls.update).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        pull_number: 123,
        title: 'chore: release packages/core@1.1.0',
        body: expect.stringContaining('## Changes')
      })
    })

    it('should create a new PR when not in a PR context', async () => {
      // Mock GitHub context to simulate a push to main
      vi.mocked(context).payload.pull_request = undefined
      githubService = new GitHubService('test-token')

      // Mock finding no existing release PRs
      mockOctokit.pulls.list.mockResolvedValue({
        data: []
      })

      const mockPR = {
        data: { number: 456, html_url: 'https://github.com/test/pull/2' }
      }
      mockOctokit.repos.getBranch.mockResolvedValue({
        data: { commit: { sha: 'main-sha' } }
      })
      mockOctokit.git.createRef.mockResolvedValue({})
      mockOctokit.git.getRef.mockResolvedValue({
        data: { object: { sha: 'branch-sha' } }
      })
      mockOctokit.git.createBlob.mockResolvedValue({
        data: { sha: 'blob-sha' }
      })
      mockOctokit.git.createTree.mockResolvedValue({
        data: { sha: 'tree-sha' }
      })
      mockOctokit.git.createCommit.mockResolvedValue({
        data: { sha: 'commit-sha' }
      })
      mockOctokit.git.updateRef.mockResolvedValue({})
      mockOctokit.pulls.create.mockResolvedValue(mockPR)
      mockOctokit.issues.addLabels.mockResolvedValue({})

      // Mock fs.existsSync and fs.readFileSync for package.json and changelog and manifest
      const packageJsonPath = 'packages/core/package.json'
      const changelogPath = 'packages/core/CHANGELOG.md'
      const manifestPath = '.release-manifest.json'
      vi.mocked(fs.existsSync).mockImplementation(
        (p) =>
          p === packageJsonPath || p === changelogPath || p === manifestPath
      )
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (p === packageJsonPath)
          return JSON.stringify({ name: 'core', version: '1.0.0' })
        if (p === changelogPath)
          return '# Changelog\n\n## 1.0.0\n\n- Initial release\n'
        if (p === manifestPath)
          return JSON.stringify({
            'packages/core': { latest: '1.0.0', main: '1.0.0' }
          })
        return ''
      })

      const changes: PackageChanges[] = [
        {
          releaseTarget: 'main',
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

      await githubService.createReleasePullRequest(changes, 'release-me')
      expect(mockOctokit.pulls.create).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        title: 'chore: release packages/core@1.1.0',
        body: '## packages/core Changelog (1.0.0 -> 1.1.0)\n\n## Changes\n\n- feat(core): add feature',
        head: 'release-main',
        base: 'main',
        labels: ['release-me']
      })
    })

    it('should update an existing release PR when found', async () => {
      // Mock GitHub context to simulate a push to main
      vi.mocked(context).payload.pull_request = undefined
      githubService = new GitHubService('test-token')

      // Mock finding an existing release PR
      mockOctokit.pulls.list.mockResolvedValue({
        data: [
          {
            number: 789,
            title: 'chore: release packages/core@1.0.0',
            body: 'Old changelog',
            labels: [{ name: 'release-me' }],
            head: { ref: 'release-1.0.0-2024-01-01' }
          }
        ]
      })

      // Mock getting main branch SHA
      mockOctokit.repos.getBranch.mockResolvedValue({
        data: { commit: { sha: 'main-sha' } }
      })

      // Mock fs.existsSync and fs.readFileSync for package.json and changelog
      const packageJsonPath = 'packages/core/package.json'
      const changelogPath = 'packages/core/CHANGELOG.md'
      const manifestPath = '.release-manifest.json'
      vi.mocked(fs.existsSync).mockImplementation(
        (p) =>
          p === packageJsonPath || p === changelogPath || p === manifestPath
      )
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (p === packageJsonPath)
          return JSON.stringify({ name: 'core', version: '1.0.0' })
        if (p === changelogPath) return '## 1.0.0\n\n- Initial release\n'
        if (p === manifestPath)
          return JSON.stringify({
            'packages/core': { latest: '1.0.0', main: '1.0.0' }
          })
        return ''
      })

      const changes: PackageChanges[] = [
        {
          releaseTarget: 'main',
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

      await githubService.createReleasePullRequest(changes, 'release-me')

      expect(mockOctokit.pulls.list).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        state: 'open',
        head: 'test-owner:release-main'
      })
    })

    it('should create a new PR when no existing release PR is found', async () => {
      // Mock GitHub context to simulate a push to main
      vi.mocked(context).payload.pull_request = undefined
      githubService = new GitHubService('test-token')

      // Mock finding no existing release PRs
      mockOctokit.pulls.list.mockResolvedValue({
        data: []
      })

      const mockPR = {
        data: { number: 456, html_url: 'https://github.com/test/pull/2' }
      }
      mockOctokit.repos.getBranch.mockResolvedValue({
        data: { commit: { sha: 'main-sha' } }
      })
      mockOctokit.git.createRef.mockResolvedValue({})
      mockOctokit.git.getRef.mockResolvedValue({
        data: { object: { sha: 'branch-sha' } }
      })
      mockOctokit.git.createBlob.mockResolvedValue({
        data: { sha: 'blob-sha' }
      })
      mockOctokit.git.createTree.mockResolvedValue({
        data: { sha: 'tree-sha' }
      })
      mockOctokit.git.createCommit.mockResolvedValue({
        data: { sha: 'commit-sha' }
      })
      mockOctokit.git.updateRef.mockResolvedValue({})
      mockOctokit.pulls.create.mockResolvedValue(mockPR)
      mockOctokit.issues.addLabels.mockResolvedValue({})

      // Mock fs.existsSync and fs.readFileSync for package.json and changelog and manifest
      const packageJsonPath = 'packages/core/package.json'
      const changelogPath = 'packages/core/CHANGELOG.md'
      const manifestPath = '.release-manifest.json'
      vi.mocked(fs.existsSync).mockImplementation(
        (p) =>
          p === packageJsonPath || p === changelogPath || p === manifestPath
      )
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (p === packageJsonPath)
          return JSON.stringify({ name: 'core', version: '1.0.0' })
        if (p === changelogPath)
          return '# Changelog\n\n## 1.0.0\n\n- Initial release\n'
        if (p === manifestPath)
          return JSON.stringify({
            'packages/core': { latest: '1.0.0', main: '1.0.0' }
          })
        return ''
      })

      const changes: PackageChanges[] = [
        {
          releaseTarget: 'main',
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

      await githubService.createReleasePullRequest(changes, 'release-me')
      expect(mockOctokit.pulls.create).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        title: 'chore: release packages/core@1.1.0',
        body: '## packages/core Changelog (1.0.0 -> 1.1.0)\n\n## Changes\n\n- feat(core): add feature',
        head: 'release-main',
        base: 'main',
        labels: ['release-me']
      })
    })

    it('should create a PR with correct body format for root package', async () => {
      // Mock GitHub context to simulate a push to main
      vi.mocked(context).payload.pull_request = undefined
      githubService = new GitHubService('test-token')

      // Mock finding no existing release PRs
      mockOctokit.pulls.list.mockResolvedValue({
        data: []
      })

      const mockPR = {
        data: { number: 456, html_url: 'https://github.com/test/pull/2' }
      }
      mockOctokit.repos.getBranch.mockResolvedValue({
        data: { commit: { sha: 'main-sha' } }
      })
      mockOctokit.git.createRef.mockResolvedValue({})
      mockOctokit.git.getRef.mockResolvedValue({
        data: { object: { sha: 'branch-sha' } }
      })
      mockOctokit.git.createBlob.mockResolvedValue({
        data: { sha: 'blob-sha' }
      })
      mockOctokit.git.createTree.mockResolvedValue({
        data: { sha: 'tree-sha' }
      })
      mockOctokit.git.createCommit.mockResolvedValue({
        data: { sha: 'commit-sha' }
      })
      mockOctokit.git.updateRef.mockResolvedValue({})
      mockOctokit.pulls.create.mockResolvedValue(mockPR)
      mockOctokit.issues.addLabels.mockResolvedValue({})

      // Mock fs.existsSync and fs.readFileSync for package.json, changelog, and manifest
      const packageJsonPath = 'package.json'
      const changelogPath = 'CHANGELOG.md'
      const manifestPath = '.release-manifest.json'
      vi.mocked(fs.existsSync).mockImplementation(
        (p) =>
          p === packageJsonPath || p === changelogPath || p === manifestPath
      )
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (p === packageJsonPath)
          return JSON.stringify({ name: 'root', version: '1.0.0' })
        if (p === changelogPath) return '## 1.0.0\n\n- Initial release\n'
        if (p === manifestPath)
          return JSON.stringify({ '.': { latest: '1.0.0', main: '1.0.0' } })
        return ''
      })

      const changes: PackageChanges[] = [
        {
          releaseTarget: 'main',
          path: '.',
          currentVersion: '1.0.0',
          newVersion: '1.1.0',
          commits: [
            {
              type: 'feat',
              scope: 'root',
              breaking: false,
              message: 'feat: add feature',
              hash: 'abc123'
            }
          ],
          changelog: '## Changes\n\n- feat: add feature'
        }
      ]

      // Mock Date.now() to return a fixed timestamp
      const mockDate = new Date('2024-01-01T12:00:00.000Z')
      vi.spyOn(global, 'Date').mockImplementation(
        () => mockDate as unknown as string
      )

      await githubService.createReleasePullRequest(changes, 'release-me')

      expect(mockOctokit.pulls.create).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        title: 'chore: release .@1.1.0',
        body: '## Changelog (1.0.0 -> 1.1.0)\n\n## Changes\n\n- feat: add feature',
        head: 'release-main',
        base: 'main',
        labels: ['release-me']
      })

      // Verify manifest blob was created
      expect(mockOctokit.git.createBlob).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        content:
          JSON.stringify({ '.': { latest: '1.1.0', main: '1.1.0' } }, null, 2) +
          '\n',
        encoding: 'utf-8'
      })
    })

    it('should create a PR with correct body format for subpackage', async () => {
      // Mock GitHub context to simulate a push to main
      vi.mocked(context).payload.pull_request = undefined
      githubService = new GitHubService('test-token')

      // Mock finding no existing release PRs
      mockOctokit.pulls.list.mockResolvedValue({
        data: []
      })

      const mockPR = {
        data: { number: 456, html_url: 'https://github.com/test/pull/2' }
      }
      mockOctokit.repos.getBranch.mockResolvedValue({
        data: { commit: { sha: 'main-sha' } }
      })
      mockOctokit.git.createRef.mockResolvedValue({})
      mockOctokit.git.getRef.mockResolvedValue({
        data: { object: { sha: 'branch-sha' } }
      })
      mockOctokit.git.createBlob.mockResolvedValue({
        data: { sha: 'blob-sha' }
      })
      mockOctokit.git.createTree.mockResolvedValue({
        data: { sha: 'tree-sha' }
      })
      mockOctokit.git.createCommit.mockResolvedValue({
        data: { sha: 'commit-sha' }
      })
      mockOctokit.git.updateRef.mockResolvedValue({})
      mockOctokit.pulls.create.mockResolvedValue(mockPR)
      mockOctokit.issues.addLabels.mockResolvedValue({})

      // Mock fs.existsSync and fs.readFileSync for package.json, changelog, and manifest
      const packageJsonPath = 'packages/core/package.json'
      const changelogPath = 'packages/core/CHANGELOG.md'
      const manifestPath = '.release-manifest.json'
      vi.mocked(fs.existsSync).mockImplementation(
        (p) =>
          p === packageJsonPath || p === changelogPath || p === manifestPath
      )
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (p === packageJsonPath)
          return JSON.stringify({ name: 'core', version: '1.0.0' })
        if (p === changelogPath) return '## 1.0.0\n\n- Initial release\n'
        if (p === manifestPath)
          return JSON.stringify({
            'packages/core': { latest: '1.0.0', main: '1.0.0' }
          })
        return ''
      })

      const changes: PackageChanges[] = [
        {
          releaseTarget: 'main',
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

      // Mock Date.now() to return a fixed timestamp
      const mockDate = new Date('2024-01-01T12:00:00.000Z')
      vi.spyOn(global, 'Date').mockImplementation(
        () => mockDate as unknown as string
      )

      await githubService.createReleasePullRequest(changes, 'release-me')

      expect(mockOctokit.pulls.create).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        title: 'chore: release packages/core@1.1.0',
        body: '## packages/core Changelog (1.0.0 -> 1.1.0)\n\n## Changes\n\n- feat(core): add feature',
        head: 'release-main',
        labels: ['release-me'],
        base: 'main'
      })

      // Verify manifest blob was created
      expect(mockOctokit.git.createBlob).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        content:
          JSON.stringify(
            {
              'packages/core': {
                latest: '1.1.0',
                main: '1.1.0'
              }
            },
            null,
            2
          ) + '\n',
        encoding: 'utf-8'
      })
    })

    it('should create a PR with correct body format for multiple packages', async () => {
      // Mock GitHub context to simulate a push to main
      vi.mocked(context).payload.pull_request = undefined
      githubService = new GitHubService('test-token')

      // Mock finding no existing release PRs
      mockOctokit.pulls.list.mockResolvedValue({
        data: []
      })

      const mockPR = {
        data: { number: 456, html_url: 'https://github.com/test/pull/2' }
      }
      mockOctokit.repos.getBranch.mockResolvedValue({
        data: { commit: { sha: 'main-sha' } }
      })
      mockOctokit.git.createRef.mockResolvedValue({})
      mockOctokit.git.getRef.mockResolvedValue({
        data: { object: { sha: 'branch-sha' } }
      })
      mockOctokit.git.createBlob.mockResolvedValue({
        data: { sha: 'blob-sha' }
      })
      mockOctokit.git.createTree.mockResolvedValue({
        data: { sha: 'tree-sha' }
      })
      mockOctokit.git.createCommit.mockResolvedValue({
        data: { sha: 'commit-sha' }
      })
      mockOctokit.git.updateRef.mockResolvedValue({})
      mockOctokit.pulls.create.mockResolvedValue(mockPR)
      mockOctokit.issues.addLabels.mockResolvedValue({})

      // Mock fs.existsSync and fs.readFileSync for package.json, changelog, and manifest
      const corePackageJsonPath = 'packages/core/package.json'
      const coreChangelogPath = 'packages/core/CHANGELOG.md'
      const utilsPackageJsonPath = 'packages/utils/package.json'
      const utilsChangelogPath = 'packages/utils/CHANGELOG.md'
      const manifestPath = '.release-manifest.json'
      vi.mocked(fs.existsSync).mockImplementation(
        (p) =>
          p === corePackageJsonPath ||
          p === coreChangelogPath ||
          p === utilsPackageJsonPath ||
          p === utilsChangelogPath ||
          p === manifestPath
      )
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (p === corePackageJsonPath)
          return JSON.stringify({ name: 'core', version: '1.0.0' })
        if (p === coreChangelogPath) return '## 1.0.0\n\n- Initial release\n'
        if (p === utilsPackageJsonPath)
          return JSON.stringify({ name: 'utils', version: '2.0.0' })
        if (p === utilsChangelogPath) return '## 2.0.0\n\n- Initial release\n'
        if (p === manifestPath)
          return JSON.stringify({
            'packages/core': { latest: '1.0.0', main: '1.0.0' },
            'packages/utils': { latest: '2.0.0', main: '2.0.0' }
          })
        return ''
      })

      const changes: PackageChanges[] = [
        {
          releaseTarget: 'main',
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
        },
        {
          releaseTarget: 'main',
          path: 'packages/utils',
          currentVersion: '2.0.0',
          newVersion: '2.1.0',
          commits: [
            {
              type: 'feat',
              scope: 'utils',
              breaking: false,
              message: 'feat(utils): add utility',
              hash: 'def456'
            }
          ],
          changelog: '## Changes\n\n- feat(utils): add utility'
        }
      ]

      await githubService.createReleasePullRequest(changes, 'release-me')

      // Verify manifest blob was created with both package versions
      expect(mockOctokit.git.createBlob).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        content:
          JSON.stringify(
            {
              'packages/core': { latest: '1.1.0', main: '1.1.0' },
              'packages/utils': { latest: '2.1.0', main: '2.1.0' }
            },
            null,
            2
          ) + '\n',
        encoding: 'utf-8'
      })
    })
  })

  describe('removeLabel', () => {
    it('should remove label from PR', async () => {
      await githubService.removeLabel('test-label', 123)
      expect(mockOctokit.issues.removeLabel).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        issue_number: 123,
        name: 'test-label'
      })
    })

    it('should handle API errors', async () => {
      mockOctokit.issues.removeLabel.mockRejectedValue(new Error('API Error'))
      await expect(
        githubService.removeLabel('test-label', 123)
      ).rejects.toThrow('API Error')
    })
  })

  describe('addLabel', () => {
    it('should add label to PR', async () => {
      await githubService.addLabel('test-label', 123)
      expect(mockOctokit.issues.addLabels).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        issue_number: 123,
        labels: ['test-label']
      })
    })

    it('should remove release-me label when adding released label', async () => {
      await githubService.addLabel('released', 123)
      expect(mockOctokit.issues.removeLabel).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        issue_number: 123,
        name: 'release-me'
      })
      expect(mockOctokit.issues.addLabels).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        issue_number: 123,
        labels: ['released']
      })
    })

    it('should handle error when removing release-me label', async () => {
      mockOctokit.issues.removeLabel.mockRejectedValue(new Error('API Error'))
      await githubService.addLabel('released', 123)
      expect(core.warning).toHaveBeenCalledWith(
        'Failed to remove release-me label: Error: API Error'
      )
      expect(mockOctokit.issues.addLabels).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        issue_number: 123,
        labels: ['released']
      })
    })
  })

  describe('updatePackageVersion', () => {
    it('should update package.json version', async () => {
      const packagePath = 'packages/core'
      const newVersion = '1.0.0'
      const packageJsonPath = path.join(packagePath, 'package.json')
      const packageJson = { name: 'core', version: '0.1.0' }

      vi.mocked(fs.existsSync).mockImplementation(
        (path) => path === packageJsonPath
      )
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(packageJson))
      vi.mocked(fs.writeFileSync).mockImplementation(() => {})

      await githubService.updatePackageVersion(packagePath, newVersion)

      expect(fs.readFileSync).toHaveBeenCalledWith(packageJsonPath, 'utf-8')
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        packageJsonPath,
        JSON.stringify({ ...packageJson, version: newVersion }, null, 2) + '\n'
      )
    })

    it('should update Cargo.toml version', async () => {
      const packagePath = 'packages/core'
      const newVersion = '1.0.0'
      const cargoTomlPath = path.join(packagePath, 'Cargo.toml')
      const cargoToml = '[package]\nname = "core"\nversion = "0.1.0"'

      vi.mocked(fs.existsSync).mockImplementation(
        (path) => path === cargoTomlPath
      )
      vi.mocked(fs.readFileSync).mockReturnValue(cargoToml)
      vi.mocked(fs.writeFileSync).mockImplementation(() => {})

      await githubService.updatePackageVersion(packagePath, newVersion)

      expect(fs.readFileSync).toHaveBeenCalledWith(cargoTomlPath, 'utf-8')
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        cargoTomlPath,
        expect.stringContaining(`version = "${newVersion}"`)
      )
    })

    it('should update version.txt version', async () => {
      const packagePath = 'packages/core'
      const newVersion = '1.0.0'
      const versionTxtPath = path.join(packagePath, 'version.txt')

      vi.mocked(fs.existsSync).mockImplementation(
        (path) => path === versionTxtPath
      )
      vi.mocked(fs.writeFileSync).mockImplementation(() => {})

      await githubService.updatePackageVersion(packagePath, newVersion)

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        versionTxtPath,
        newVersion + '\n'
      )
    })

    it('should throw error if no package file found', async () => {
      const packagePath = 'packages/core'
      const newVersion = '1.0.0'

      vi.mocked(fs.existsSync).mockReturnValue(false)

      await expect(
        githubService.updatePackageVersion(packagePath, newVersion)
      ).rejects.toThrow(
        `No package.json, Cargo.toml, or version.txt found in ${packagePath}`
      )
    })
  })

  describe('getPullRequestFromCommit', () => {
    it('should return PR number from commit', async () => {
      // Mock data with PR #456 having a later merged_at date
      mockOctokit.repos.listPullRequestsAssociatedWithCommit.mockResolvedValue({
        data: [
          { number: 456, merged_at: '2024-01-02T12:00:00Z' },
          { number: 123, merged_at: '2024-01-01T12:00:00Z' }
        ]
      })

      const prNumber = await githubService.getPullRequestFromCommit('abc123')
      expect(prNumber).toBe(456) // Should return the most recently merged PR
    })

    it('should return null if no merged PRs found', async () => {
      mockOctokit.repos.listPullRequestsAssociatedWithCommit.mockResolvedValue({
        data: [
          { number: 123, merged_at: null },
          { number: 456, merged_at: null }
        ]
      })

      const prNumber = await githubService.getPullRequestFromCommit('abc123')
      expect(prNumber).toBeNull()
    })

    it('should handle API errors', async () => {
      mockOctokit.repos.listPullRequestsAssociatedWithCommit.mockRejectedValue(
        new Error('API Error')
      )

      const prNumber = await githubService.getPullRequestFromCommit('abc123')
      expect(prNumber).toBeNull()
    })
  })

  describe('wasReleasePR', () => {
    it('should return true if PR has release-me label', async () => {
      mockOctokit.pulls.get.mockResolvedValue({
        data: {
          number: 123,
          labels: [{ name: 'release-me' }, { name: 'other' }]
        }
      })

      const isReleasePR = await githubService.wasReleasePR(123)
      expect(isReleasePR).toBe(true)
    })

    it('should return false if PR does not have release-me label', async () => {
      mockOctokit.pulls.get.mockResolvedValue({
        data: {
          number: 123,
          labels: [{ name: 'other' }]
        }
      })

      const isReleasePR = await githubService.wasReleasePR(123)
      expect(isReleasePR).toBe(false)
    })

    it('should handle API errors', async () => {
      mockOctokit.pulls.get.mockRejectedValue(new Error('API Error'))

      const isReleasePR = await githubService.wasReleasePR(123)
      expect(isReleasePR).toBe(false)
    })
  })

  describe('getManifestFromMain', () => {
    it('should return manifest content from main branch', async () => {
      const manifest = { 'packages/core': { latest: '1.0.0', main: '1.0.0' } }
      mockOctokit.repos.getContent.mockResolvedValue({
        data: {
          content: Buffer.from(JSON.stringify(manifest)).toString('base64')
        }
      })

      const result = await githubService.getManifestFromMain(
        '.release-manifest.json'
      )
      expect(result).toEqual(manifest)
    })

    it('should handle missing manifest file', async () => {
      mockOctokit.repos.getContent.mockResolvedValue({
        data: {
          content: null
        }
      })

      const result = await githubService.getManifestFromMain(
        '.release-manifest.json'
      )
      expect(result).toEqual({})
    })

    it('should handle API errors', async () => {
      mockOctokit.repos.getContent.mockRejectedValue(new Error('API Error'))

      const result = await githubService.getManifestFromMain(
        '.release-manifest.json'
      )
      expect(result).toEqual({})
    })

    it('should handle custom root directory', async () => {
      const manifest = { 'packages/core': '1.0.0' }
      mockOctokit.repos.getContent.mockResolvedValue({
        data: {
          content: Buffer.from(JSON.stringify(manifest)).toString('base64')
        }
      })

      await githubService.getManifestFromMain(
        '.release-manifest.json',
        'packages/core'
      )
      expect(mockOctokit.repos.getContent).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        path: 'packages/core/.release-manifest.json',
        ref: 'main'
      })
    })
  })

  describe('wasManifestUpdatedInLastCommit', () => {
    it('should return true if manifest was updated', async () => {
      mockOctokit.repos.listCommits.mockResolvedValue({
        data: [{ sha: 'abc123' }]
      })
      mockOctokit.repos.getCommit.mockResolvedValue({
        data: {
          files: [{ filename: '.release-manifest.json' }]
        }
      })

      const result = await githubService.wasManifestUpdatedInLastCommit(
        '.release-manifest.json'
      )
      expect(result).toBe(true)
    })

    it('should return false if manifest was not updated', async () => {
      mockOctokit.repos.listCommits.mockResolvedValue({
        data: [{ sha: 'abc123' }]
      })
      mockOctokit.repos.getCommit.mockResolvedValue({
        data: {
          files: [{ filename: 'other.txt' }]
        }
      })

      const result = await githubService.wasManifestUpdatedInLastCommit(
        '.release-manifest.json'
      )
      expect(result).toBe(false)
    })

    it('should handle no commits', async () => {
      mockOctokit.repos.listCommits.mockResolvedValue({
        data: []
      })

      const result = await githubService.wasManifestUpdatedInLastCommit(
        '.release-manifest.json'
      )
      expect(result).toBe(false)
    })

    it('should handle API errors', async () => {
      mockOctokit.repos.listCommits.mockRejectedValue(new Error('API Error'))

      const result = await githubService.wasManifestUpdatedInLastCommit(
        '.release-manifest.json'
      )
      expect(result).toBe(false)
    })

    it('should handle custom root directory', async () => {
      mockOctokit.repos.listCommits.mockResolvedValue({
        data: [{ sha: 'abc123' }]
      })
      mockOctokit.repos.getCommit.mockResolvedValue({
        data: {
          files: [{ filename: 'packages/core/.release-manifest.json' }]
        }
      })

      const result = await githubService.wasManifestUpdatedInLastCommit(
        '.release-manifest.json',
        'packages/core'
      )
      expect(result).toBe(true)
    })
  })

  describe('getLastReleaseVersion', () => {
    it('should return version for root package', async () => {
      mockOctokit.repos.listReleases.mockResolvedValue({
        data: [
          { tag_name: 'v1.0.0', prerelease: false },
          { tag_name: 'v0.9.0', prerelease: false }
        ]
      })

      const version = await githubService.getLastReleaseVersion('.')
      expect(version).toBe('1.0.0')
    })

    it('should return version for subpackage', async () => {
      mockOctokit.repos.listReleases.mockResolvedValue({
        data: [
          { tag_name: 'packages/core-v1.0.0', prerelease: false },
          { tag_name: 'packages/core-v0.9.0', prerelease: false }
        ]
      })

      const version = await githubService.getLastReleaseVersion('packages/core')
      expect(version).toBe('1.0.0')
    })

    it('should ignore prereleases', async () => {
      mockOctokit.repos.listReleases.mockResolvedValue({
        data: [
          { tag_name: 'v1.0.0-rc.1', prerelease: true },
          { tag_name: 'v0.9.0', prerelease: false }
        ]
      })

      const version = await githubService.getLastReleaseVersion('.')
      expect(version).toBe('0.9.0')
    })

    it('should return null if no releases found', async () => {
      mockOctokit.repos.listReleases.mockResolvedValue({
        data: []
      })

      const version = await githubService.getLastReleaseVersion('.')
      expect(version).toBeNull()
    })

    it('should handle API errors', async () => {
      mockOctokit.repos.listReleases.mockRejectedValue(new Error('API Error'))

      const version = await githubService.getLastReleaseVersion('.')
      expect(version).toBeNull()
    })
  })

  describe('getChangelogForPackage', () => {
    it('should return changelog content', async () => {
      const changelog =
        '## 1.0.0\n\n- Initial release\n\n## 0.9.0\n\n- Old release'
      mockOctokit.repos.getContent.mockResolvedValue({
        data: {
          content: Buffer.from(changelog).toString('base64')
        }
      })

      const result = await githubService.getChangelogForPackage('packages/core')
      expect(result).toBe('## 1.0.0\n\n- Initial release')
    })

    it('should handle missing changelog file', async () => {
      mockOctokit.repos.getContent.mockResolvedValue({
        data: {
          content: null
        }
      })

      const result = await githubService.getChangelogForPackage('packages/core')
      expect(result).toBe('')
    })

    it('should handle no version sections', async () => {
      const changelog = 'No version sections here'
      mockOctokit.repos.getContent.mockResolvedValue({
        data: {
          content: Buffer.from(changelog).toString('base64')
        }
      })

      const result = await githubService.getChangelogForPackage('packages/core')
      expect(result).toBe('')
    })

    it('should handle API errors', async () => {
      mockOctokit.repos.getContent.mockRejectedValue(new Error('API Error'))

      const result = await githubService.getChangelogForPackage('packages/core')
      expect(result).toBe('')
    })
  })

  describe('findReleasePRByVersions', () => {
    it('should return PR number if title matches generated title', async () => {
      mockOctokit.pulls.list.mockResolvedValue({
        data: [
          {
            number: 42,
            title: 'chore: release packages/core@1.2.3',
            labels: [{ name: 'release-me' }]
          }
        ]
      })
      const manifest = { 'packages/core': { latest: '1.2.3', main: '1.2.3' } }
      const prNumber = await githubService.findReleasePRByVersions(manifest)
      expect(prNumber).toBe(42)
    })

    it('should return null if no PR matches', async () => {
      mockOctokit.pulls.list.mockResolvedValue({
        data: [
          {
            number: 42,
            title: 'chore: release unrelated@1.2.3',
            labels: [{ name: 'release-me' }]
          }
        ]
      })
      const manifest = { 'packages/core': { latest: '1.2.3', main: '1.2.3' } }
      const prNumber = await githubService.findReleasePRByVersions(manifest)
      expect(prNumber).toBeNull()
    })
  })

  describe('generateReleasePRTitle', () => {
    it('should generate correct title for single root package', () => {
      // @ts-expect-error: access private method for test
      const title = githubService.generateReleasePRTitle([
        {
          path: '.',
          currentVersion: '1.0.0',
          newVersion: '1.1.0',
          commits: [],
          changelog: '',
          releaseTarget: 'main'
        }
      ])
      expect(title).toBe('chore: release 1.1.0')
    })
    it('should generate correct title for single subpackage', () => {
      // @ts-expect-error: access private method for test
      const title = githubService.generateReleasePRTitle([
        {
          path: 'packages/core',
          currentVersion: '1.0.0',
          newVersion: '1.1.0',
          commits: [],
          changelog: '',
          releaseTarget: 'main'
        }
      ])
      expect(title).toBe('chore: release packages/core@1.1.0')
    })
    it('should generate correct title for multi-package', () => {
      // @ts-expect-error: access private method for test
      const title = githubService.generateReleasePRTitle([
        {
          path: 'packages/core',
          currentVersion: '1.0.0',
          newVersion: '1.1.0',
          commits: [],
          changelog: '',
          releaseTarget: 'main'
        },
        {
          path: 'packages/utils',
          currentVersion: '2.0.0',
          newVersion: '2.1.0',
          commits: [],
          changelog: '',
          releaseTarget: 'main'
        }
      ])
      expect(title).toBe('chore: release main')
    })
  })

  describe('createComment', () => {
    it('should create a comment on the PR', async () => {
      // Mock GitHub context to ensure we're in a PR context
      vi.mocked(context).payload.pull_request = {
        number: 123,
        base: { ref: 'test-base' },
        head: { ref: 'test-head' }
      }
      githubService = new GitHubService('test-token')

      const comment = 'Test comment'
      await githubService.createComment(comment)
      expect(mockOctokit.issues.createComment).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        issue_number: 123,
        body: comment
      })
    })

    it('should not create a comment if not in a PR context', async () => {
      // Mock GitHub context to simulate not being in a PR
      vi.mocked(context).payload.pull_request = undefined
      githubService = new GitHubService('test-token')

      const comment = 'Test comment'
      await githubService.createComment(comment)
      expect(mockOctokit.issues.createComment).not.toHaveBeenCalled()
    })
  })

  describe('getLatestRcVersion', () => {
    it('should return next RC number when previous RCs exist', async () => {
      const mockReleases = {
        data: [
          { tag_name: 'packages/core-v1.0.0-rc.2', prerelease: true },
          { tag_name: 'packages/core-v1.0.0-rc.1', prerelease: true }
        ]
      }
      mockOctokit.repos.listReleases.mockResolvedValue(mockReleases)

      const rcNumber = await githubService.getLatestRcVersion(
        'packages/core',
        '1.0.0'
      )
      expect(rcNumber).toBe(3)
    })

    it('should return 1 when no previous RCs exist', async () => {
      const mockReleases = {
        data: []
      }
      mockOctokit.repos.listReleases.mockResolvedValue(mockReleases)

      const rcNumber = await githubService.getLatestRcVersion(
        'packages/core',
        '1.0.0'
      )
      expect(rcNumber).toBe(1)
    })

    it('should handle API errors', async () => {
      mockOctokit.repos.listReleases.mockRejectedValue(new Error('API Error'))
      const rcNumber = await githubService.getLatestRcVersion(
        'packages/core',
        '1.0.0'
      )
      expect(rcNumber).toBe(1) // Should return 1 as fallback
      expect(core.warning).toHaveBeenCalledWith(
        'Failed to get latest RC version: Error: API Error'
      )
    })
  })
})
