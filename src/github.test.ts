import { describe, it, expect, beforeEach, vi } from 'vitest'
import { GitHubService } from './github.js'
import { PackageChanges } from './types.js'
import * as fs from 'fs'
import * as path from 'path'

// Mock @actions/core
vi.mock('@actions/core', () => ({
  info: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn()
}))

// Mock Octokit
const mockOctokit = {
  repos: {
    compareCommits: vi.fn(),
    createRelease: vi.fn(),
    createPullRequest: vi.fn(),
    listReleases: vi.fn()
  },
  git: {
    createRef: vi.fn()
  },
  pulls: {
    update: vi.fn(),
    get: vi.fn()
  },
  issues: {
    addLabels: vi.fn()
  }
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
      mockOctokit.repos.listReleases.mockResolvedValue(mockReleases)
      mockOctokit.repos.compareCommits.mockResolvedValue(mockCommits)

      const commits =
        await githubService.getCommitsSinceLastRelease('packages/core')
      expect(commits).toEqual(['feat: add feature', 'fix: fix bug'])
      expect(mockOctokit.repos.compareCommits).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        base: 'packages/core-v1.0.0',
        head: 'test-head'
      })
    })

    it('should handle no previous release', async () => {
      const mockReleases = {
        data: []
      }
      const mockCommits = {
        data: {
          commits: [
            {
              commit: { message: 'feat: add feature' },
              files: [{ filename: 'packages/core/src/index.ts' }]
            }
          ]
        }
      }
      mockOctokit.repos.listReleases.mockResolvedValue(mockReleases)
      mockOctokit.repos.compareCommits.mockResolvedValue(mockCommits)

      const commits =
        await githubService.getCommitsSinceLastRelease('packages/core')
      expect(commits).toEqual(['feat: add feature'])
      expect(mockOctokit.repos.compareCommits).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        base: 'HEAD~1000',
        head: 'test-head'
      })
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
      const mockCommits = {
        data: {
          commits: [
            {
              commit: { message: 'feat: add feature' },
              files: [{ filename: 'packages/core/src/index.ts' }]
            }
          ]
        }
      }
      mockOctokit.repos.listReleases.mockResolvedValue(mockReleases)
      mockOctokit.repos.compareCommits.mockResolvedValue(mockCommits)

      const commits =
        await githubService.getCommitsSinceLastRelease('packages/core')
      expect(commits).toEqual(['feat: add feature'])
      expect(mockOctokit.repos.compareCommits).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        base: 'packages/core-v1.0.0',
        head: 'test-head'
      })
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
      mockOctokit.repos.compareCommits.mockResolvedValue({
        data: { commits: [] }
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
