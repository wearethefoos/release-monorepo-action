import { context } from '@actions/github'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { GitHubService } from './github.js'
import { PackageChanges } from './types.js'
import * as fs from 'fs'
import * as path from 'path'

// Mock @actions/core
vi.mock('@actions/core', () => ({
  info: vi.fn(),
  debug: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn()
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
    getContent: vi.fn()
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
    addLabels: vi.fn()
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

      await githubService.createReleasePullRequest(changes, 'release-me')
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

      // Mock fs.existsSync and fs.readFileSync for package.json and changelog
      const packageJsonPath = 'packages/core/package.json'
      const changelogPath = 'packages/core/CHANGELOG.md'
      vi.mocked(fs.existsSync).mockImplementation(
        (p) => p === packageJsonPath || p === changelogPath
      )
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (p === packageJsonPath)
          return JSON.stringify({ name: 'core', version: '1.0.0' })
        if (p === changelogPath) return '## 1.0.0\n\n- Initial release\n' // No level 1 heading
        return ''
      })

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

      await githubService.createReleasePullRequest(changes, 'release-me')
      expect(mockOctokit.repos.getBranch).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        branch: 'main'
      })
      expect(mockOctokit.git.createRef).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        ref: expect.stringMatching(
          /^refs\/heads\/release-1\.1\.0-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/
        ),
        sha: 'main-sha'
      })
      expect(mockOctokit.git.createBlob).toHaveBeenCalledTimes(2) // Once for package.json, once for changelog
      expect(mockOctokit.git.createTree).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        base_tree: 'branch-sha',
        tree: [
          {
            path: packageJsonPath,
            mode: '100644',
            type: 'blob',
            sha: 'blob-sha'
          },
          {
            path: changelogPath,
            mode: '100644',
            type: 'blob',
            sha: 'blob-sha'
          }
        ]
      })
      expect(mockOctokit.git.createCommit).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        message: 'chore: update versions to 1.1.0',
        tree: 'tree-sha',
        parents: ['branch-sha']
      })
      expect(mockOctokit.git.updateRef).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        ref: expect.stringMatching(
          /^heads\/release-1\.1\.0-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/
        ),
        sha: 'commit-sha'
      })
      expect(mockOctokit.pulls.create).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        title: 'Release packages/core@1.1.0',
        body: expect.stringContaining('## Changes'),
        head: expect.stringMatching(
          /^release-1\.1\.0-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/
        ),
        base: 'main'
      })
      expect(mockOctokit.issues.addLabels).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        issue_number: 456,
        labels: ['release-me']
      })

      // Verify the changelog blob was created with the correct heading
      expect(mockOctokit.git.createBlob).toHaveBeenCalledTimes(2)
      const changelogBlobCall = mockOctokit.git.createBlob.mock.calls.find(
        (call) => call[0].content.includes('packages/core Changelog')
      )
      expect(changelogBlobCall).toBeDefined()
      expect(changelogBlobCall![0].content).toMatch(
        /^# packages\/core Changelog\n\n## 1\.1\.0/
      )
    })

    it('should handle API errors', async () => {
      // Mock GitHub context to simulate a push to main
      vi.mocked(context).payload.pull_request = undefined
      githubService = new GitHubService('test-token')

      // Mock finding no existing release PRs
      mockOctokit.pulls.list.mockResolvedValue({
        data: []
      })

      mockOctokit.repos.getBranch.mockRejectedValue(new Error('API Error'))

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

    it('should update an existing release PR when found', async () => {
      // Mock GitHub context to simulate a push to main
      vi.mocked(context).payload.pull_request = undefined
      githubService = new GitHubService('test-token')

      // Mock finding an existing release PR
      mockOctokit.pulls.list.mockResolvedValue({
        data: [
          {
            number: 789,
            title: 'Release packages/core@1.0.0',
            body: 'Old changelog',
            labels: [{ name: 'release-me' }]
          }
        ]
      })

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

      await githubService.createReleasePullRequest(changes, 'release-me')

      expect(mockOctokit.pulls.list).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        state: 'open',
        labels: ['release-me']
      })
      expect(mockOctokit.pulls.update).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        pull_number: 789,
        title: 'Release packages/core@1.1.0',
        body: expect.stringContaining('## Changes')
      })
      // Should not create a new branch or PR
      expect(mockOctokit.git.createRef).not.toHaveBeenCalled()
      expect(mockOctokit.pulls.create).not.toHaveBeenCalled()
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

      // Mock fs.existsSync and fs.readFileSync for package.json and changelog
      const packageJsonPath = 'packages/core/package.json'
      const changelogPath = 'packages/core/CHANGELOG.md'
      vi.mocked(fs.existsSync).mockImplementation(
        (p) => p === packageJsonPath || p === changelogPath
      )
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (p === packageJsonPath)
          return JSON.stringify({ name: 'core', version: '1.0.0' })
        if (p === changelogPath)
          return '# Changelog\n\n## 1.0.0\n\n- Initial release\n'
        return ''
      })

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

      await githubService.createReleasePullRequest(changes, 'release-me')

      expect(mockOctokit.pulls.list).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        state: 'open',
        labels: ['release-me']
      })
      // Should create a new branch and PR
      expect(mockOctokit.git.createRef).toHaveBeenCalled()
      expect(mockOctokit.pulls.create).toHaveBeenCalled()
    })
  })

  describe('addLabel', () => {
    it('should add a label to the PR', async () => {
      // Ensure context is a PR
      vi.mocked(context).payload.pull_request = {
        number: 123,
        base: { ref: 'test-base' },
        head: { ref: 'test-head' }
      }
      githubService = new GitHubService('test-token')
      mockOctokit.issues.addLabels.mockResolvedValue({})
      await githubService.addLabel('released')
      expect(mockOctokit.issues.addLabels).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        issue_number: 123,
        labels: ['released']
      })
    })

    it('should handle API errors', async () => {
      // Ensure context is a PR
      vi.mocked(context).payload.pull_request = {
        number: 123,
        base: { ref: 'test-base' },
        head: { ref: 'test-head' }
      }
      githubService = new GitHubService('test-token')
      mockOctokit.issues.addLabels.mockRejectedValue(new Error('API Error'))
      await expect(githubService.addLabel('released')).rejects.toThrow(
        'API Error'
      )
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
})
