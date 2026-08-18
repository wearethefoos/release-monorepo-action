import { describe, it, expect, beforeEach, vi } from 'vitest'
import { GitHubService } from './github'
import { PackageChanges, PackageManifest, ReleaseContext } from './types'
import * as fs from 'fs'
import * as path from 'path'
import * as core from '@actions/core'
import * as git from './git.js'
import * as gh from './gh.js'
import { getActionContext } from './context.js'
import type { Mock } from 'vitest'

// Mock @actions/core
vi.mock('@actions/core', () => ({
  info: vi.fn(),
  debug: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  warning: vi.fn(),
  getInput: vi.fn()
}))

// GitHubService is now a thin facade over local git operations (src/git.ts)
// and the `gh` CLI (src/gh.ts), plus src/context.ts replacing
// @actions/github's `context`. Mock those three modules (the facade's only
// collaborators) instead of Octokit/@actions/github.
vi.mock('./context.js', () => ({
  getActionContext: vi.fn()
}))

vi.mock('./git.js', () => ({
  fetchTags: vi.fn(),
  configureGitAuth: vi.fn(),
  resolveRef: vi.fn(),
  getCommitCount: vi.fn(),
  getCommitsBetween: vi.fn(),
  listTagsByDateDesc: vi.fn(),
  tagExists: vi.fn(),
  createAnnotatedTag: vi.fn(),
  pushTag: vi.fn(),
  getFileAtRef: vi.fn(),
  remoteBranchExists: vi.fn(),
  getRemoteBranchSha: vi.fn(),
  getLastCommitDiffForFile: vi.fn(),
  commitFilesToBranch: vi.fn()
}))

vi.mock('./gh.js', () => ({
  configureGh: vi.fn(),
  getPullRequest: vi.fn(),
  listOpenPullRequests: vi.fn(),
  listClosedReleasePullRequests: vi.fn(),
  createPullRequest: vi.fn(),
  updatePullRequest: vi.fn(),
  addLabels: vi.fn(),
  removeLabel: vi.fn(),
  createComment: vi.fn(),
  getMergedPullRequestsForCommit: vi.fn()
}))

// Mock fs module
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn()
}))

const mockGetActionContext = vi.mocked(getActionContext)
const mockGit = vi.mocked(git)
const mockGh = vi.mocked(gh)

type Context = ReleaseContext & { sha: string }

const defaultContext: Context = {
  isPullRequest: true,
  isPreRelease: false,
  shouldRelease: false,
  pullRequestNumber: 123,
  baseRef: 'test-base',
  headRef: 'test-head',
  owner: 'test-owner',
  repo: 'test-repo',
  sha: 'test-sha'
}

function makeContext(overrides: Partial<Context> = {}): Context {
  return { ...defaultContext, ...overrides }
}

function mockPr(
  overrides: Partial<gh.PullRequestInfo> = {}
): gh.PullRequestInfo {
  return {
    number: 123,
    title: 'chore: release core@1.0.0',
    labels: [],
    merged: false,
    mergedAt: null,
    ...overrides
  }
}

describe('GitHubService', () => {
  let githubService: GitHubService

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetActionContext.mockReturnValue(makeContext())
    // Sensible defaults for every core.getInput() consumer; individual
    // tests override with a more specific mockImplementation as needed.
    ;(core.getInput as Mock).mockImplementation((name: string) => {
      switch (name) {
        case 'manifest-file':
          return '.release-manifest.json'
        case 'root-dir':
          return '.'
        case 'indentation':
          return '2'
        case 'git-user-name':
          return 'github-actions[bot]'
        case 'git-user-email':
          return 'actions@github.com'
        default:
          return ''
      }
    })
    githubService = new GitHubService('test-token')
  })

  describe('constructor', () => {
    it('configures the gh CLI with the token and owner/repo', () => {
      expect(mockGh.configureGh).toHaveBeenCalledWith(
        'test-token',
        'test-owner/test-repo'
      )
    })

    it('fetches tags defensively', () => {
      expect(mockGit.fetchTags).toHaveBeenCalled()
    })

    it('configures git push auth with the token', () => {
      expect(mockGit.configureGitAuth).toHaveBeenCalledWith('test-token')
    })
  })

  describe('onMainBranch', () => {
    it('returns true when headRef is refs/heads/main', async () => {
      mockGetActionContext.mockReturnValue(
        makeContext({ headRef: 'refs/heads/main' })
      )
      githubService = new GitHubService('test-token')
      await expect(githubService.onMainBranch()).resolves.toBe(true)
    })

    it('returns false for any other branch', async () => {
      mockGetActionContext.mockReturnValue(
        makeContext({ headRef: 'refs/heads/feature-x' })
      )
      githubService = new GitHubService('test-token')
      await expect(githubService.onMainBranch()).resolves.toBe(false)
    })
  })

  describe('isDeletedReleaseBranch', () => {
    it('returns false when not on the release branch', async () => {
      mockGetActionContext.mockReturnValue(
        makeContext({ headRef: 'some-other-branch' })
      )
      githubService = new GitHubService('test-token')
      await expect(githubService.isDeletedReleaseBranch('main')).resolves.toBe(
        false
      )
    })

    it('returns true when on the release branch and it no longer exists on origin', async () => {
      mockGetActionContext.mockReturnValue(
        makeContext({ headRef: 'release-main' })
      )
      githubService = new GitHubService('test-token')
      mockGit.remoteBranchExists.mockReturnValue(false)

      await expect(githubService.isDeletedReleaseBranch('main')).resolves.toBe(
        true
      )
      expect(mockGit.remoteBranchExists).toHaveBeenCalledWith('release-main')
    })

    it('returns false when on the release branch and it still exists on origin', async () => {
      mockGetActionContext.mockReturnValue(
        makeContext({ headRef: 'release-main' })
      )
      githubService = new GitHubService('test-token')
      mockGit.remoteBranchExists.mockReturnValue(true)

      await expect(githubService.isDeletedReleaseBranch('main')).resolves.toBe(
        false
      )
    })
  })

  describe('getPullRequestNumberFromContext', () => {
    it('returns the PR number when in a PR context', () => {
      expect(githubService.getPullRequestNumberFromContext()).toBe(123)
    })

    it('returns null when not in a PR context', () => {
      mockGetActionContext.mockReturnValue(
        makeContext({ isPullRequest: false, pullRequestNumber: undefined })
      )
      githubService = new GitHubService('test-token')
      expect(githubService.getPullRequestNumberFromContext()).toBeNull()
    })
  })

  describe('getPullRequestLabels', () => {
    it('should return labels from PR', async () => {
      mockGh.getPullRequest.mockReturnValue(
        mockPr({ labels: ['bug', 'enhancement'] })
      )

      const labels = await githubService.getPullRequestLabels()
      expect(labels).toEqual(['bug', 'enhancement'])
      expect(mockGh.getPullRequest).toHaveBeenCalledWith(123)
    })

    it('should return an empty array when not in a PR context', async () => {
      mockGetActionContext.mockReturnValue(
        makeContext({ isPullRequest: false, pullRequestNumber: undefined })
      )
      githubService = new GitHubService('test-token')

      const labels = await githubService.getPullRequestLabels()
      expect(labels).toEqual([])
      expect(mockGh.getPullRequest).not.toHaveBeenCalled()
    })

    it('should return an empty array when gh returns no PR', async () => {
      mockGh.getPullRequest.mockReturnValue(null)
      const labels = await githubService.getPullRequestLabels()
      expect(labels).toEqual([])
    })

    it('should propagate errors from the gh CLI', async () => {
      mockGh.getPullRequest.mockImplementation(() => {
        throw new Error('gh CLI Error')
      })
      await expect(githubService.getPullRequestLabels()).rejects.toThrow(
        'gh CLI Error'
      )
    })
  })

  describe('isPullRequestMerged', () => {
    it('returns true when the PR is merged', async () => {
      mockGh.getPullRequest.mockReturnValue(mockPr({ merged: true }))
      await expect(githubService.isPullRequestMerged()).resolves.toBe(true)
    })

    it('returns false when not in a PR context', async () => {
      mockGetActionContext.mockReturnValue(
        makeContext({ isPullRequest: false, pullRequestNumber: undefined })
      )
      githubService = new GitHubService('test-token')
      await expect(githubService.isPullRequestMerged()).resolves.toBe(false)
    })
  })

  describe('getCommitCount', () => {
    it('defaults to HEAD and resolves it via git.resolveRef', async () => {
      mockGit.resolveRef.mockReturnValue('HEAD')
      mockGit.getCommitCount.mockReturnValue(50)

      const count = await githubService.getCommitCount()
      expect(count).toBe(50)
      expect(mockGit.resolveRef).toHaveBeenCalledWith('HEAD')
      expect(mockGit.getCommitCount).toHaveBeenCalledWith('HEAD')
    })

    it('should use the provided ref', async () => {
      mockGit.resolveRef.mockReturnValue('origin/main')
      mockGit.getCommitCount.mockReturnValue(50)

      const count = await githubService.getCommitCount('main')
      expect(count).toBe(50)
      expect(mockGit.resolveRef).toHaveBeenCalledWith('main')
      expect(mockGit.getCommitCount).toHaveBeenCalledWith('origin/main')
    })

    it('falls back to HEAD when the ref cannot be resolved locally', async () => {
      mockGit.resolveRef.mockReturnValue(null)
      mockGit.getCommitCount.mockReturnValue(1)

      const count = await githubService.getCommitCount('nonexistent')
      expect(count).toBe(1)
      expect(mockGit.getCommitCount).toHaveBeenCalledWith('HEAD')
    })
  })

  describe('getAllCommitsSinceLastRelease', () => {
    it('uses the latest non-prerelease tag as the base', async () => {
      mockGit.listTagsByDateDesc.mockReturnValue(['core-v1.0.0'])
      mockGit.resolveRef.mockReturnValue('test-head')
      mockGit.getCommitsBetween.mockReturnValue([
        { sha: 'abc123', message: 'feat: add feature', files: ['a.ts'] },
        { sha: 'def456', message: 'fix: fix bug', files: ['b.ts'] }
      ])

      const commits = await githubService.getAllCommitsSinceLastRelease()

      expect(mockGit.getCommitsBetween).toHaveBeenCalledWith(
        'core-v1.0.0',
        'test-head',
        true
      )
      expect(commits.map((c) => c.commit.message)).toEqual([
        'feat: add feature',
        'fix: fix bug'
      ])
      expect(commits[0].files).toEqual([
        { filename: 'a.ts', status: '', additions: 0, deletions: 0, changes: 0 }
      ])
    })

    it('ignores prerelease tags when finding the last release', async () => {
      mockGit.listTagsByDateDesc.mockReturnValue([
        'core-v1.1.0-rc.1',
        'core-v1.0.0'
      ])
      mockGit.resolveRef.mockReturnValue('test-head')
      mockGit.getCommitsBetween.mockReturnValue([
        { sha: 'abc123', message: 'feat: add feature', files: [] }
      ])

      await githubService.getAllCommitsSinceLastRelease()

      expect(mockGit.getCommitsBetween).toHaveBeenCalledWith(
        'core-v1.0.0',
        'test-head',
        true
      )
    })

    it('falls back to a commit-count lookback when no non-prerelease tag exists', async () => {
      mockGit.listTagsByDateDesc.mockReturnValue(['core-v1.0.0-rc.1'])
      mockGit.resolveRef.mockImplementation((ref: string) =>
        ref === 'HEAD' ? 'HEAD' : 'test-head'
      )
      mockGit.getCommitCount.mockReturnValue(10)
      mockGit.getCommitsBetween.mockReturnValue([])

      await githubService.getAllCommitsSinceLastRelease()

      expect(mockGit.getCommitsBetween).toHaveBeenCalledWith(
        'HEAD~9',
        'test-head',
        true
      )
    })

    it('caps the fallback lookback at 50 commits', async () => {
      mockGit.listTagsByDateDesc.mockReturnValue([])
      mockGit.resolveRef.mockImplementation((ref: string) =>
        ref === 'HEAD' ? 'HEAD' : 'test-head'
      )
      mockGit.getCommitCount.mockReturnValue(2000)
      mockGit.getCommitsBetween.mockReturnValue([])

      await githubService.getAllCommitsSinceLastRelease()

      expect(mockGit.getCommitsBetween).toHaveBeenCalledWith(
        'HEAD~49',
        'test-head',
        true
      )
    })

    it('filters out commits that would not trigger a version bump', async () => {
      mockGit.listTagsByDateDesc.mockReturnValue(['core-v1.0.0'])
      mockGit.resolveRef.mockReturnValue('test-head')
      mockGit.getCommitsBetween.mockReturnValue([
        { sha: 'a', message: 'feat: add feature', files: [] },
        { sha: 'b', message: 'chore: cleanup', files: [] },
        { sha: 'c', message: 'docs: update readme', files: [] },
        { sha: 'd', message: 'fix: fix bug', files: [] }
      ])

      const commits = await githubService.getAllCommitsSinceLastRelease()
      expect(commits.map((c) => c.commit.message)).toEqual([
        'feat: add feature',
        'fix: fix bug'
      ])
    })

    it('returns an empty array when no commits are found', async () => {
      mockGit.listTagsByDateDesc.mockReturnValue(['core-v1.0.0'])
      mockGit.resolveRef.mockReturnValue('test-head')
      mockGit.getCommitsBetween.mockReturnValue([])

      const commits = await githubService.getAllCommitsSinceLastRelease()
      expect(commits).toEqual([])
    })

    it('passes checkPaths through to git.getCommitsBetween', async () => {
      mockGit.listTagsByDateDesc.mockReturnValue(['core-v1.0.0'])
      mockGit.resolveRef.mockReturnValue('test-head')
      mockGit.getCommitsBetween.mockReturnValue([])

      await githubService.getAllCommitsSinceLastRelease(false)

      expect(mockGit.getCommitsBetween).toHaveBeenCalledWith(
        'core-v1.0.0',
        'test-head',
        false
      )
    })
  })

  describe('getCommitsSinceLastRelease', () => {
    it('returns all commit messages for the root package', async () => {
      const allCommits = [
        {
          sha: 'a',
          commit: { message: 'feat: add feature' },
          files: [
            {
              filename: 'packages/core/index.ts',
              status: '',
              additions: 0,
              deletions: 0,
              changes: 0
            }
          ]
        }
      ]

      const commits = await githubService.getCommitsSinceLastRelease(
        '.',
        allCommits
      )
      expect(commits).toEqual(['feat: add feature'])
    })

    it('filters commits by package path for subpackages (monorepo filtering)', async () => {
      const allCommits = [
        {
          sha: 'a',
          commit: { message: 'feat(core): add feature' },
          files: [
            {
              filename: 'packages/core/index.ts',
              status: '',
              additions: 0,
              deletions: 0,
              changes: 0
            }
          ]
        },
        {
          sha: 'b',
          commit: { message: 'feat(utils): add utility' },
          files: [
            {
              filename: 'packages/utils/index.ts',
              status: '',
              additions: 0,
              deletions: 0,
              changes: 0
            }
          ]
        }
      ]

      const commits = await githubService.getCommitsSinceLastRelease(
        'packages/core',
        allCommits
      )
      expect(commits).toEqual(['feat(core): add feature'])
    })

    it('excludes commits with no matching files for a subpackage', async () => {
      const allCommits = [
        {
          sha: 'a',
          commit: { message: 'feat(other): unrelated' },
          files: [
            {
              filename: 'packages/other/index.ts',
              status: '',
              additions: 0,
              deletions: 0,
              changes: 0
            }
          ]
        }
      ]

      const commits = await githubService.getCommitsSinceLastRelease(
        'packages/core',
        allCommits
      )
      expect(commits).toEqual([])
    })

    it('returns an empty array when no commits are provided or found', async () => {
      const commits = await githubService.getCommitsSinceLastRelease(
        'packages/core',
        []
      )
      expect(commits).toEqual([])
    })

    it('fetches commits itself when none are provided', async () => {
      mockGit.listTagsByDateDesc.mockReturnValue(['core-v1.0.0'])
      mockGit.resolveRef.mockReturnValue('test-head')
      mockGit.getCommitsBetween.mockReturnValue([
        {
          sha: 'a',
          message: 'feat(core): add feature',
          files: ['packages/core/index.ts']
        }
      ])

      const commits =
        await githubService.getCommitsSinceLastRelease('packages/core')
      expect(commits).toEqual(['feat(core): add feature'])
    })
  })

  describe('createRelease', () => {
    beforeEach(() => {
      mockGit.tagExists.mockReturnValue(false)
    })

    it('creates a tag for a single root package using the manifest version', async () => {
      mockGit.getFileAtRef.mockReturnValue(
        JSON.stringify({ '.': { latest: '1.0.0', main: '1.0.0' } })
      )

      const changes: PackageChanges[] = [
        {
          name: 'root',
          releaseTarget: 'main',
          path: '.',
          currentVersion: '1.0.0',
          newVersion: '1.1.0',
          commits: [],
          changelog: '## Changes\n\n- feat(core): add feature'
        }
      ]

      await githubService.createRelease(changes)

      expect(mockGit.createAnnotatedTag).toHaveBeenCalledWith(
        'v1.0.0',
        '## Changes\n\n- feat(core): add feature',
        'test-sha'
      )
      expect(mockGit.pushTag).toHaveBeenCalledWith('v1.0.0')
      expect(core.setOutput).toHaveBeenCalledWith('version', '1.0.0')
      expect(core.setOutput).toHaveBeenCalledWith('prerelease', false)
    })

    it('creates tags for multiple packages using basename-prefixed names', async () => {
      mockGit.getFileAtRef.mockReturnValue(
        JSON.stringify({
          'packages/core': { latest: '1.0.0', main: '1.0.0' },
          'packages/utils': { latest: '2.0.0', main: '2.0.0' }
        })
      )

      const changes: PackageChanges[] = [
        {
          name: 'core',
          releaseTarget: 'main',
          path: 'packages/core',
          currentVersion: '1.0.0',
          newVersion: '1.1.0',
          commits: [],
          changelog: '## Changes\n\n- feat(core): add feature'
        },
        {
          name: 'utils',
          releaseTarget: 'main',
          path: 'packages/utils',
          currentVersion: '2.0.0',
          newVersion: '2.1.0',
          commits: [],
          changelog: '## Changes\n\n- feat(utils): add utility'
        }
      ]

      await githubService.createRelease(changes)

      expect(mockGit.createAnnotatedTag).toHaveBeenCalledTimes(2)
      expect(mockGit.createAnnotatedTag).toHaveBeenCalledWith(
        'core-v1.0.0',
        '## Changes\n\n- feat(core): add feature',
        'test-sha'
      )
      expect(mockGit.createAnnotatedTag).toHaveBeenCalledWith(
        'utils-v2.0.0',
        '## Changes\n\n- feat(utils): add utility',
        'test-sha'
      )
      expect(mockGit.pushTag).toHaveBeenCalledWith('core-v1.0.0')
      expect(mockGit.pushTag).toHaveBeenCalledWith('utils-v2.0.0')
    })

    // Behavior decision: a colliding tag is a hard failure by default, not
    // a silent skip -- continuing would either leave the run claiming
    // success (releases-created/version/versions outputs) for a package
    // that was never actually released, or leave a partial/inconsistent
    // set of tags pushed across a multi-package release. The error
    // propagates out of createRelease so main's top-level catch calls
    // core.setFailed, exactly like any other real error in this action.
    it('throws when the target tag already exists and overwrite-existing-tags is explicitly false', async () => {
      mockGit.getFileAtRef.mockReturnValue(
        JSON.stringify({ '.': { latest: '1.0.0', main: '1.0.0' } })
      )
      mockGit.tagExists.mockReturnValue(true)

      const changes: PackageChanges[] = [
        {
          name: 'root',
          releaseTarget: 'main',
          path: '.',
          currentVersion: '1.0.0',
          newVersion: '1.1.0',
          commits: [],
          changelog: '## Changes'
        }
      ]

      await expect(
        githubService.createRelease(changes, false, false)
      ).rejects.toThrow(/Tag v1\.0\.0 already exists.*overwrite-existing-tags/)

      expect(mockGit.createAnnotatedTag).not.toHaveBeenCalled()
      expect(mockGit.pushTag).not.toHaveBeenCalled()
      // No misleading success outputs for the collided package.
      expect(core.setOutput).not.toHaveBeenCalledWith(
        'version',
        expect.anything()
      )
      expect(core.setOutput).not.toHaveBeenCalledWith(
        'versions',
        expect.anything()
      )
    })

    // Deprecated default: the createRelease() parameter itself defaults to
    // true (matching pre-2.x force-move behavior), independent of main.ts's
    // own input-parsing default -- so calling with only two args must also
    // force-move rather than throw.
    it('force-moves the tag when overwrite-existing-tags is omitted (defaults to true)', async () => {
      mockGit.getFileAtRef.mockReturnValue(
        JSON.stringify({ '.': { latest: '1.0.0', main: '1.0.0' } })
      )
      mockGit.tagExists.mockReturnValue(true)

      const changes: PackageChanges[] = [
        {
          name: 'root',
          releaseTarget: 'main',
          path: '.',
          currentVersion: '1.0.0',
          newVersion: '1.1.0',
          commits: [],
          changelog: '## Changes'
        }
      ]

      await githubService.createRelease(changes)

      expect(mockGit.createAnnotatedTag).toHaveBeenCalledWith(
        'v1.0.0',
        '## Changes',
        'test-sha',
        true
      )
      expect(mockGit.pushTag).toHaveBeenCalledWith('v1.0.0', true)
    })

    it('force-moves the tag and reports success when overwrite-existing-tags is true', async () => {
      mockGit.getFileAtRef.mockReturnValue(
        JSON.stringify({ '.': { latest: '1.0.0', main: '1.0.0' } })
      )
      mockGit.tagExists.mockReturnValue(true)

      const changes: PackageChanges[] = [
        {
          name: 'root',
          releaseTarget: 'main',
          path: '.',
          currentVersion: '1.0.0',
          newVersion: '1.1.0',
          commits: [],
          changelog: '## Changes'
        }
      ]

      await githubService.createRelease(changes, false, true)

      expect(mockGit.createAnnotatedTag).toHaveBeenCalledWith(
        'v1.0.0',
        '## Changes',
        'test-sha',
        true
      )
      expect(mockGit.pushTag).toHaveBeenCalledWith('v1.0.0', true)
      // The overwritten package IS reported as an actual release.
      expect(core.setOutput).toHaveBeenCalledWith('version', '1.0.0')
      expect(core.setOutput).toHaveBeenCalledWith(
        'versions',
        JSON.stringify([
          { name: '.', path: '.', version: '1.0.0', prerelease: false }
        ])
      )
    })

    it('takes the normal (non-force) path when there is no collision, regardless of overwrite-existing-tags', async () => {
      mockGit.getFileAtRef.mockReturnValue(
        JSON.stringify({ '.': { latest: '1.0.0', main: '1.0.0' } })
      )
      mockGit.tagExists.mockReturnValue(false)

      const changes: PackageChanges[] = [
        {
          name: 'root',
          releaseTarget: 'main',
          path: '.',
          currentVersion: '1.0.0',
          newVersion: '1.1.0',
          commits: [],
          changelog: '## Changes'
        }
      ]

      await githubService.createRelease(changes, false, true)

      expect(mockGit.createAnnotatedTag).toHaveBeenCalledWith(
        'v1.0.0',
        '## Changes',
        'test-sha'
      )
      expect(mockGit.pushTag).toHaveBeenCalledWith('v1.0.0')
    })

    it('uses change.newVersion directly for prereleases (bypassing the manifest)', async () => {
      mockGit.getFileAtRef.mockReturnValue(
        JSON.stringify({ 'packages/core': { latest: '1.0.0', main: '1.0.0' } })
      )

      const changes: PackageChanges[] = [
        {
          name: 'core',
          releaseTarget: 'canary',
          path: 'packages/core',
          currentVersion: '1.0.0',
          newVersion: '1.1.0-rc.1',
          commits: [],
          changelog: '## Changes'
        }
      ]

      await githubService.createRelease(changes, true)

      expect(mockGit.createAnnotatedTag).toHaveBeenCalledWith(
        'core-v1.1.0-rc.1',
        '## Changes',
        'test-sha'
      )
      expect(core.setOutput).toHaveBeenCalledWith('prerelease', true)
    })

    it('propagates errors from git tag creation', async () => {
      mockGit.getFileAtRef.mockReturnValue(
        JSON.stringify({ '.': { latest: '1.0.0', main: '1.0.0' } })
      )
      mockGit.createAnnotatedTag.mockImplementation(() => {
        throw new Error('git push failed')
      })

      const changes: PackageChanges[] = [
        {
          name: 'root',
          releaseTarget: 'main',
          path: '.',
          currentVersion: '1.0.0',
          newVersion: '1.1.0',
          commits: [],
          changelog: '## Changes'
        }
      ]

      await expect(githubService.createRelease(changes)).rejects.toThrow(
        'git push failed'
      )
    })
  })

  describe('createReleasePullRequest', () => {
    const packageJsonPath = 'packages/core/package.json'
    const changelogPath = 'packages/core/CHANGELOG.md'
    const manifestPath = '.release-manifest.json'

    function mockFsForCore(): void {
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
    }

    const changes: PackageChanges[] = [
      {
        name: 'core',
        releaseTarget: 'main',
        path: 'packages/core',
        currentVersion: '1.0.0',
        newVersion: '1.1.0',
        commits: [],
        changelog: '## Changes\n\n- feat(core): add feature'
      }
    ]

    beforeEach(() => {
      mockGit.getRemoteBranchSha.mockReturnValue('main-sha')
      mockGit.commitFilesToBranch.mockReturnValue('commit-sha')
      mockFsForCore()
    })

    it('throws when origin/main cannot be resolved', async () => {
      mockGit.getRemoteBranchSha.mockReturnValue(null)

      await expect(
        githubService.createReleasePullRequest(changes, 'release-me')
      ).rejects.toThrow('Could not resolve origin/main SHA')
    })

    it('commits files to the release-<target> branch based on origin/main', async () => {
      mockGh.listOpenPullRequests.mockReturnValue([])
      mockGh.createPullRequest.mockReturnValue(456)

      await githubService.createReleasePullRequest(changes, 'release-me')

      expect(mockGit.commitFilesToBranch).toHaveBeenCalledWith(
        expect.objectContaining({
          branch: 'release-main',
          baseRef: 'origin/main',
          message: 'chore: release core@1.1.0',
          userName: 'github-actions[bot]',
          userEmail: 'actions@github.com'
        })
      )
    })

    it('updates an existing open PR', async () => {
      mockGh.listOpenPullRequests.mockReturnValue([
        mockPr({
          number: 123,
          title: 'chore: release core@1.0.0',
          labels: ['release-me']
        })
      ])

      await githubService.createReleasePullRequest(changes, 'release-me')

      expect(mockGh.listOpenPullRequests).toHaveBeenCalledWith('release-main')
      expect(mockGh.updatePullRequest).toHaveBeenCalledWith(
        123,
        'chore: release core@1.1.0',
        expect.stringContaining('## Changes')
      )
      expect(mockGh.createPullRequest).not.toHaveBeenCalled()
    })

    it('does not re-add a label the existing PR already has', async () => {
      mockGh.listOpenPullRequests.mockReturnValue([
        mockPr({ number: 123, labels: ['release-me'] })
      ])

      await githubService.createReleasePullRequest(changes, 'release-me')

      expect(mockGh.addLabels).not.toHaveBeenCalled()
    })

    it('adds labels to an existing PR that is missing them', async () => {
      mockGh.listOpenPullRequests.mockReturnValue([
        mockPr({ number: 123, labels: [] })
      ])

      await githubService.createReleasePullRequest(changes, 'release-me')

      expect(mockGh.addLabels).toHaveBeenCalledWith(123, [
        'release-me',
        'release-target:main'
      ])
    })

    it('creates a new PR when none exists, with release-me and release-target labels', async () => {
      mockGh.listOpenPullRequests.mockReturnValue([])
      mockGh.createPullRequest.mockReturnValue(456)

      await githubService.createReleasePullRequest(changes, 'release-me')

      expect(mockGh.createPullRequest).toHaveBeenCalledWith({
        title: 'chore: release core@1.1.0',
        body: expect.stringContaining('## Core Changelog (1.0.0 -> 1.1.0)'),
        head: 'release-main',
        base: 'main'
      })
      expect(mockGh.addLabels).toHaveBeenCalledWith(456, [
        'release-me',
        'release-target:main'
      ])
    })

    it('formats the PR body and title for a root package', async () => {
      const rootPackageJsonPath = 'package.json'
      const rootChangelogPath = 'CHANGELOG.md'
      vi.mocked(fs.existsSync).mockImplementation(
        (p) =>
          p === rootPackageJsonPath ||
          p === rootChangelogPath ||
          p === manifestPath
      )
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (p === rootPackageJsonPath)
          return JSON.stringify({ name: 'root', version: '1.0.0' })
        if (p === rootChangelogPath) return '## 1.0.0\n\n- Initial release\n'
        if (p === manifestPath)
          return JSON.stringify({ '.': { latest: '1.0.0', main: '1.0.0' } })
        return ''
      })
      mockGh.listOpenPullRequests.mockReturnValue([])
      mockGh.createPullRequest.mockReturnValue(456)

      const rootChanges: PackageChanges[] = [
        {
          name: 'root',
          releaseTarget: 'main',
          path: '.',
          currentVersion: '1.0.0',
          newVersion: '1.1.0',
          commits: [],
          changelog: '## Changes\n\n- feat: add feature'
        }
      ]

      await githubService.createReleasePullRequest(rootChanges, 'release-me')

      expect(mockGh.createPullRequest).toHaveBeenCalledWith({
        title: 'chore: release 1.1.0',
        body: '## Changelog (1.0.0 -> 1.1.0)\n\n## Changes\n\n- feat: add feature',
        head: 'release-main',
        base: 'main'
      })

      const call = mockGit.commitFilesToBranch.mock.calls[0][0]
      const manifestFile = call.files.find((f) => f.path === manifestPath)
      expect(manifestFile?.content).toBe(
        JSON.stringify({ '.': { latest: '1.1.0', main: '1.1.0' } }, null, 2) +
          '\n'
      )
    })

    it('formats the PR body and title for a subpackage, and updates the manifest content', async () => {
      mockGh.listOpenPullRequests.mockReturnValue([])
      mockGh.createPullRequest.mockReturnValue(456)

      await githubService.createReleasePullRequest(changes, 'release-me')

      expect(mockGh.createPullRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'chore: release core@1.1.0',
          body: '## Core Changelog (1.0.0 -> 1.1.0)\n\n## Changes\n\n- feat(core): add feature'
        })
      )

      const call = mockGit.commitFilesToBranch.mock.calls[0][0]
      const manifestFile = call.files.find((f) => f.path === manifestPath)
      expect(manifestFile?.content).toBe(
        JSON.stringify(
          { 'packages/core': { latest: '1.1.0', main: '1.1.0' } },
          null,
          2
        ) + '\n'
      )
    })

    it('formats the PR body for multiple packages and updates all their manifest entries', async () => {
      const corePackageJsonPath = 'packages/core/package.json'
      const coreChangelogPath = 'packages/core/CHANGELOG.md'
      const utilsPackageJsonPath = 'packages/utils/package.json'
      const utilsChangelogPath = 'packages/utils/CHANGELOG.md'
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
      mockGh.listOpenPullRequests.mockReturnValue([])
      mockGh.createPullRequest.mockReturnValue(456)

      const multiChanges: PackageChanges[] = [
        changes[0],
        {
          name: 'utils',
          releaseTarget: 'main',
          path: 'packages/utils',
          currentVersion: '2.0.0',
          newVersion: '2.1.0',
          commits: [],
          changelog: '## Changes\n\n- feat(utils): add utility'
        }
      ]

      await githubService.createReleasePullRequest(multiChanges, 'release-me')

      const call = mockGit.commitFilesToBranch.mock.calls[0][0]
      const manifestFile = call.files.find((f) => f.path === manifestPath)
      expect(manifestFile?.content).toBe(
        JSON.stringify(
          {
            'packages/core': { latest: '1.1.0', main: '1.1.0' },
            'packages/utils': { latest: '2.1.0', main: '2.1.0' }
          },
          null,
          2
        ) + '\n'
      )
    })

    // Regression coverage for the separate "format Cargo.toml & sync
    // Cargo.lock" workaround workflow this replaces: a version-only
    // Cargo.toml edit leaves Cargo.lock's own entry for that package
    // stale, so it must be refreshed as part of the same release commit.
    describe('Cargo.lock sync', () => {
      const cargoTomlPath = 'packages/core/Cargo.toml'
      const cargoLockPath = 'packages/core/Cargo.lock'
      const rootCargoLockPath = 'Cargo.lock'

      function mockFsForCargo(options: {
        standaloneLock?: boolean
        workspaceLock?: boolean
      }): void {
        vi.mocked(fs.existsSync).mockImplementation((p) => {
          if (p === cargoTomlPath) return true
          if (p === changelogPath) return true
          if (p === manifestPath) return true
          if (p === cargoLockPath) return Boolean(options.standaloneLock)
          if (p === rootCargoLockPath) return Boolean(options.workspaceLock)
          return false
        })
        vi.mocked(fs.readFileSync).mockImplementation((p) => {
          if (p === cargoTomlPath) {
            return '[package]\nname = "core"\nversion = "1.0.0"\n'
          }
          if (p === changelogPath) return '## 1.0.0\n\n- Initial release\n'
          if (p === manifestPath) {
            return JSON.stringify({
              'packages/core': { latest: '1.0.0', main: '1.0.0' }
            })
          }
          return ''
        })
      }

      beforeEach(() => {
        mockGh.listOpenPullRequests.mockReturnValue([])
        mockGh.createPullRequest.mockReturnValue(456)
      })

      it("refreshes a standalone crate's own Cargo.lock", async () => {
        mockFsForCargo({ standaloneLock: true })

        await githubService.createReleasePullRequest(changes, 'release-me')

        const call = mockGit.commitFilesToBranch.mock.calls[0][0]
        expect(call.postWriteCommands).toEqual([
          {
            cwd: 'packages/core',
            file: 'cargo',
            args: ['update', '--workspace']
          }
        ])
      })

      it('refreshes a shared workspace Cargo.lock at the repo root', async () => {
        mockFsForCargo({ workspaceLock: true })

        await githubService.createReleasePullRequest(changes, 'release-me')

        const call = mockGit.commitFilesToBranch.mock.calls[0][0]
        expect(call.postWriteCommands).toEqual([
          { cwd: '.', file: 'cargo', args: ['update', '--workspace'] }
        ])
      })

      it('refreshes both when a crate has its own lock and a workspace lock also exists', async () => {
        mockFsForCargo({ standaloneLock: true, workspaceLock: true })

        await githubService.createReleasePullRequest(changes, 'release-me')

        const call = mockGit.commitFilesToBranch.mock.calls[0][0]
        expect(call.postWriteCommands).toHaveLength(2)
        expect(call.postWriteCommands).toEqual(
          expect.arrayContaining([
            { cwd: '.', file: 'cargo', args: ['update', '--workspace'] },
            {
              cwd: 'packages/core',
              file: 'cargo',
              args: ['update', '--workspace']
            }
          ])
        )
      })

      it('does not run cargo when no Cargo.lock exists anywhere', async () => {
        mockFsForCargo({})

        await githubService.createReleasePullRequest(changes, 'release-me')

        const call = mockGit.commitFilesToBranch.mock.calls[0][0]
        expect(call.postWriteCommands).toEqual([])
      })

      it('does not run cargo when the changed package has no Cargo.toml', async () => {
        mockFsForCore()

        await githubService.createReleasePullRequest(changes, 'release-me')

        const call = mockGit.commitFilesToBranch.mock.calls[0][0]
        expect(call.postWriteCommands).toEqual([])
      })
    })
  })

  describe('createVersionBumpPullRequest', () => {
    const manifestPath = '.release-manifest.json'
    const changes: PackageChanges[] = [
      {
        name: 'core',
        releaseTarget: 'canary',
        path: 'packages/core',
        currentVersion: '1.0.0',
        newVersion: '1.1.0',
        commits: [],
        changelog: 'Bumped canary to 1.1.0'
      }
    ]

    beforeEach(() => {
      mockGit.getRemoteBranchSha.mockReturnValue('main-sha')
      mockGit.commitFilesToBranch.mockReturnValue('commit-sha')
      mockGit.getFileAtRef.mockReturnValue(
        JSON.stringify({ 'packages/core': { latest: '1.1.0', main: '1.0.0' } })
      )
    })

    it('commits only the manifest file to the release-<target> branch', async () => {
      mockGh.listOpenPullRequests.mockReturnValue([])
      mockGh.createPullRequest.mockReturnValue(789)

      await githubService.createVersionBumpPullRequest(changes, 'release-me')

      expect(mockGit.commitFilesToBranch).toHaveBeenCalledWith(
        expect.objectContaining({
          branch: 'release-canary',
          baseRef: 'origin/main',
          files: [expect.objectContaining({ path: manifestPath })]
        })
      )
      expect(mockGh.createPullRequest).toHaveBeenCalledWith(
        expect.objectContaining({ head: 'release-canary', base: 'main' })
      )
      expect(mockGh.addLabels).toHaveBeenCalledWith(789, [
        'release-me',
        'release-target:canary'
      ])
    })

    it('updates an existing open PR instead of creating a new one', async () => {
      mockGh.listOpenPullRequests.mockReturnValue([
        mockPr({ number: 321, labels: ['release-me'] })
      ])

      await githubService.createVersionBumpPullRequest(changes, 'release-me')

      expect(mockGh.updatePullRequest).toHaveBeenCalledWith(
        321,
        'chore: bump canary to packages/core@1.1.0',
        expect.any(String)
      )
      expect(mockGh.createPullRequest).not.toHaveBeenCalled()
    })
  })

  describe('removeLabel', () => {
    it('delegates to gh.removeLabel', async () => {
      await githubService.removeLabel('test-label', 123)
      expect(mockGh.removeLabel).toHaveBeenCalledWith(123, 'test-label')
    })

    it('propagates errors', async () => {
      mockGh.removeLabel.mockImplementation(() => {
        throw new Error('gh CLI Error')
      })
      await expect(
        githubService.removeLabel('test-label', 123)
      ).rejects.toThrow('gh CLI Error')
    })
  })

  describe('addLabel', () => {
    it('adds a label to the PR', async () => {
      await githubService.addLabel('test-label', 123)
      expect(mockGh.addLabels).toHaveBeenCalledWith(123, ['test-label'])
    })

    it('removes the release-me label when adding the released label', async () => {
      await githubService.addLabel('released', 123)
      expect(mockGh.removeLabel).toHaveBeenCalledWith(123, 'release-me')
      expect(mockGh.addLabels).toHaveBeenCalledWith(123, ['released'])
    })

    it('warns but still adds the label when removing release-me fails', async () => {
      mockGh.removeLabel.mockImplementation(() => {
        throw new Error('gh CLI Error')
      })

      await githubService.addLabel('released', 123)

      expect(core.warning).toHaveBeenCalledWith(
        'Failed to remove release-me label: Error: gh CLI Error'
      )
      expect(mockGh.addLabels).toHaveBeenCalledWith(123, ['released'])
    })
  })

  describe('updatePackageVersion', () => {
    it('should update package.json version', async () => {
      const packagePath = 'packages/core'
      const newVersion = '1.0.0'
      const packageJsonPath = path.join(packagePath, 'package.json')
      const packageJson = { name: 'core', version: '0.1.0' }

      vi.mocked(fs.existsSync).mockImplementation((p) => p === packageJsonPath)
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(packageJson))
      vi.mocked(fs.writeFileSync).mockImplementation(() => {})

      await githubService.updatePackageVersion(packagePath, newVersion)

      expect(fs.readFileSync).toHaveBeenCalledWith(packageJsonPath, 'utf-8')
      const formattedJSON =
        JSON.stringify(
          { ...packageJson, version: newVersion },
          null,
          2
        ).replace(/ {2}/g, '  ') + '\n'
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        packageJsonPath,
        formattedJSON
      )
    })

    it('should update Cargo.toml version', async () => {
      const packagePath = 'packages/core'
      const newVersion = '1.0.0'
      const cargoTomlPath = path.join(packagePath, 'Cargo.toml')
      const cargoToml = '[package]\nname = "core"\nversion = "0.1.0"'

      vi.mocked(fs.existsSync).mockImplementation((p) => p === cargoTomlPath)
      vi.mocked(fs.readFileSync).mockReturnValue(cargoToml)
      vi.mocked(fs.writeFileSync).mockImplementation(() => {})

      await githubService.updatePackageVersion(packagePath, newVersion)

      expect(fs.readFileSync).toHaveBeenCalledWith(cargoTomlPath, 'utf-8')
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        cargoTomlPath,
        expect.stringContaining(`version = "${newVersion}"`)
      )
    })

    // Regression coverage: the old @iarna/toml parse+stringify round trip
    // reformatted the whole file (reordering keys, dropping comments,
    // normalizing whitespace), forcing consumers to run a separate
    // formatter (e.g. `taplo fmt`) after every release PR. The targeted
    // replacement must touch only the version field's characters.
    it('preserves Cargo.toml comments, key order, and formatting untouched', async () => {
      const packagePath = 'packages/core'
      const newVersion = '1.0.0'
      const cargoTomlPath = path.join(packagePath, 'Cargo.toml')
      const cargoToml =
        '# top-of-file comment\n[package]\nname = "core"\nversion = "0.1.0" # keep at latest\nedition = "2024"\n\n[dependencies]\nserde = { version = "1.0", features = ["derive"] }\n'

      vi.mocked(fs.existsSync).mockImplementation((p) => p === cargoTomlPath)
      vi.mocked(fs.readFileSync).mockReturnValue(cargoToml)
      vi.mocked(fs.writeFileSync).mockImplementation(() => {})

      await githubService.updatePackageVersion(packagePath, newVersion)

      const expected =
        '# top-of-file comment\n[package]\nname = "core"\nversion = "1.0.0" # keep at latest\nedition = "2024"\n\n[dependencies]\nserde = { version = "1.0", features = ["derive"] }\n'
      expect(fs.writeFileSync).toHaveBeenCalledWith(cargoTomlPath, expected)
    })

    it('leaves a Cargo.toml with no [package] table untouched (e.g. a pure workspace root)', async () => {
      const packagePath = '.'
      const newVersion = '1.0.0'
      const cargoTomlPath = path.join(packagePath, 'Cargo.toml')
      const cargoToml = '[workspace]\nmembers = ["packages/*"]\n'

      vi.mocked(fs.existsSync).mockImplementation((p) => p === cargoTomlPath)
      vi.mocked(fs.readFileSync).mockReturnValue(cargoToml)
      vi.mocked(fs.writeFileSync).mockImplementation(() => {})

      await githubService.updatePackageVersion(packagePath, newVersion)

      expect(fs.writeFileSync).not.toHaveBeenCalled()
    })

    it('should update pyproject.toml version', async () => {
      const packagePath = 'packages/core'
      const newVersion = '1.0.0'
      const pyprojectTomlPath = path.join(packagePath, 'pyproject.toml')
      const pyprojectToml =
        '[project]\nname = "core"\nversion = "0.1.0"\n\n[build-system]\nrequires = ["setuptools"]\n'

      vi.mocked(fs.existsSync).mockImplementation(
        (p) => p === pyprojectTomlPath
      )
      vi.mocked(fs.readFileSync).mockReturnValue(pyprojectToml)
      vi.mocked(fs.writeFileSync).mockImplementation(() => {})

      await githubService.updatePackageVersion(packagePath, newVersion)

      expect(fs.readFileSync).toHaveBeenCalledWith(pyprojectTomlPath, 'utf-8')
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        pyprojectTomlPath,
        expect.stringContaining(`version = "${newVersion}"`)
      )
    })

    it('should update version.txt version', async () => {
      const packagePath = 'packages/core'
      const newVersion = '1.0.0'
      const versionTxtPath = path.join(packagePath, 'version.txt')

      vi.mocked(fs.existsSync).mockImplementation((p) => p === versionTxtPath)
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
        `No package.json, Cargo.toml, pyproject.toml, or version.txt found in ${packagePath}`
      )
    })
  })

  describe('getPullRequestFromCommit', () => {
    it('should return the most recently merged PR number', async () => {
      mockGh.getMergedPullRequestsForCommit.mockReturnValue([
        mockPr({ number: 123, merged: true, mergedAt: '2024-01-01T12:00:00Z' }),
        mockPr({ number: 456, merged: true, mergedAt: '2024-01-02T12:00:00Z' })
      ])

      const prNumber = await githubService.getPullRequestFromCommit('abc123')
      expect(prNumber).toBe(456)
    })

    it('should return null if no merged PRs found', async () => {
      mockGh.getMergedPullRequestsForCommit.mockReturnValue([
        mockPr({ number: 123, merged: false, mergedAt: null }),
        mockPr({ number: 456, merged: false, mergedAt: null })
      ])

      const prNumber = await githubService.getPullRequestFromCommit('abc123')
      expect(prNumber).toBeNull()
    })

    it('should return null and warn on errors', async () => {
      mockGh.getMergedPullRequestsForCommit.mockImplementation(() => {
        throw new Error('gh CLI Error')
      })

      const prNumber = await githubService.getPullRequestFromCommit('abc123')
      expect(prNumber).toBeNull()
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining('Failed to get PR from commit abc123')
      )
    })
  })

  describe('wasReleasePR', () => {
    it('should return true if PR has release-me label', async () => {
      mockGh.getPullRequest.mockReturnValue(
        mockPr({ labels: ['release-me', 'other'] })
      )
      await expect(githubService.wasReleasePR(123)).resolves.toBe(true)
    })

    it('should return false if PR does not have release-me label', async () => {
      mockGh.getPullRequest.mockReturnValue(mockPr({ labels: ['other'] }))
      await expect(githubService.wasReleasePR(123)).resolves.toBe(false)
    })

    it('should return false and warn on errors', async () => {
      mockGh.getPullRequest.mockImplementation(() => {
        throw new Error('gh CLI Error')
      })
      await expect(githubService.wasReleasePR(123)).resolves.toBe(false)
      expect(core.warning).toHaveBeenCalled()
    })
  })

  describe('getManifestFromMain', () => {
    it('should return manifest content from origin/main', async () => {
      const manifest = { 'packages/core': { latest: '1.0.0', main: '1.0.0' } }
      mockGit.getFileAtRef.mockReturnValue(JSON.stringify(manifest))

      const result = await githubService.getManifestFromMain(
        '.release-manifest.json'
      )
      expect(result).toEqual(manifest)
      expect(mockGit.getFileAtRef).toHaveBeenCalledWith(
        'origin/main',
        '.release-manifest.json'
      )
    })

    it('should convert the legacy string-version manifest format', async () => {
      mockGit.getFileAtRef.mockReturnValue(JSON.stringify({ '.': '1.0.0' }))

      const result = await githubService.getManifestFromMain(
        '.release-manifest.json'
      )
      expect(result).toEqual({ '.': { latest: '1.0.0', main: '1.0.0' } })
    })

    it('should handle a missing manifest file', async () => {
      mockGit.getFileAtRef.mockReturnValue(null)

      const result = await githubService.getManifestFromMain(
        '.release-manifest.json'
      )
      expect(result).toEqual({})
    })

    it('should handle errors', async () => {
      mockGit.getFileAtRef.mockImplementation(() => {
        throw new Error('git show failed')
      })

      const result = await githubService.getManifestFromMain(
        '.release-manifest.json'
      )
      expect(result).toEqual({})
    })

    it('should join the manifest path with a custom root directory', async () => {
      mockGit.getFileAtRef.mockReturnValue(
        JSON.stringify({ 'packages/core': { latest: '1.0.0', main: '1.0.0' } })
      )

      await githubService.getManifestFromMain(
        '.release-manifest.json',
        'packages/core'
      )
      expect(mockGit.getFileAtRef).toHaveBeenCalledWith(
        'origin/main',
        path.join('packages/core', '.release-manifest.json')
      )
    })
  })

  describe('wasManifestUpdatedInLastCommit', () => {
    it('should return true if manifest was updated for the release target', async () => {
      mockGit.getLastCommitDiffForFile.mockReturnValue('+  "main": "1.0.0"')

      const result = await githubService.wasManifestUpdatedInLastCommit(
        '.release-manifest.json',
        'main'
      )
      expect(result).toBe(true)
      expect(mockGit.getLastCommitDiffForFile).toHaveBeenCalledWith(
        '.release-manifest.json',
        'HEAD'
      )
    })

    it('should return false if manifest was not updated for the release target', async () => {
      mockGit.getLastCommitDiffForFile.mockReturnValue('+  "canary": "1.0.0"')

      const result = await githubService.wasManifestUpdatedInLastCommit(
        '.release-manifest.json',
        'main'
      )
      expect(result).toBe(false)
    })

    it('should return false when the diff is empty', async () => {
      mockGit.getLastCommitDiffForFile.mockReturnValue('')

      const result = await githubService.wasManifestUpdatedInLastCommit(
        '.release-manifest.json',
        'main'
      )
      expect(result).toBe(false)
    })

    it('should return false and warn on errors', async () => {
      mockGit.getLastCommitDiffForFile.mockImplementation(() => {
        throw new Error('git show failed')
      })

      const result = await githubService.wasManifestUpdatedInLastCommit(
        '.release-manifest.json',
        'main'
      )
      expect(result).toBe(false)
      expect(core.warning).toHaveBeenCalled()
    })

    it('should join the manifest path with a custom root directory', async () => {
      mockGit.getLastCommitDiffForFile.mockReturnValue('+  "main": "1.0.0"')

      const result = await githubService.wasManifestUpdatedInLastCommit(
        '.release-manifest.json',
        'main',
        'packages/core'
      )
      expect(result).toBe(true)
      expect(mockGit.getLastCommitDiffForFile).toHaveBeenCalledWith(
        path.join('packages/core', '.release-manifest.json'),
        'HEAD'
      )
    })
  })

  describe('getLastReleaseVersion', () => {
    it('should return the latest tag for the root package', async () => {
      mockGit.listTagsByDateDesc.mockReturnValue(['v1.0.0', 'v0.9.0'])
      const version = await githubService.getLastReleaseVersion('.')
      expect(version).toBe('v1.0.0')
    })

    it('should return the latest tag for a subpackage', async () => {
      mockGit.listTagsByDateDesc.mockReturnValue(['core-v1.0.0', 'core-v0.9.0'])
      const version = await githubService.getLastReleaseVersion('packages/core')
      expect(version).toBe('core-v1.0.0')
    })

    it('should use basename(packagePath) for deeply nested package paths', async () => {
      mockGit.listTagsByDateDesc.mockReturnValue(['bar-v1.0.0', 'bar-v0.9.0'])
      const version = await githubService.getLastReleaseVersion('apps/foo/bar')
      expect(version).toBe('bar-v1.0.0')
    })

    it('should ignore prerelease tags', async () => {
      mockGit.listTagsByDateDesc.mockReturnValue(['v1.0.0-rc.1', 'v0.9.0'])
      const version = await githubService.getLastReleaseVersion('.')
      expect(version).toBe('v0.9.0')
    })

    it('should return null if no matching tags are found', async () => {
      mockGit.listTagsByDateDesc.mockReturnValue([])
      const version = await githubService.getLastReleaseVersion('.')
      expect(version).toBeNull()
    })

    it('should return null on errors', async () => {
      mockGit.listTagsByDateDesc.mockImplementation(() => {
        throw new Error('git tag failed')
      })
      const version = await githubService.getLastReleaseVersion('.')
      expect(version).toBeNull()
    })
  })

  describe('getLatestRcVersion', () => {
    it('should return next RC number when previous RCs exist', async () => {
      mockGit.listTagsByDateDesc.mockReturnValue([
        'core-v1.0.0-rc.2',
        'core-v1.0.0-rc.1'
      ])

      const rcNumber = await githubService.getLatestRcVersion(
        'packages/core',
        '1.0.0'
      )
      expect(rcNumber).toBe(3)
    })

    it('should return 1 when no previous RCs exist', async () => {
      mockGit.listTagsByDateDesc.mockReturnValue([])
      const rcNumber = await githubService.getLatestRcVersion(
        'packages/core',
        '1.0.0'
      )
      expect(rcNumber).toBe(1)
    })

    it('should return 1 on errors', async () => {
      mockGit.listTagsByDateDesc.mockImplementation(() => {
        throw new Error('git tag failed')
      })
      const rcNumber = await githubService.getLatestRcVersion(
        'packages/core',
        '1.0.0'
      )
      expect(rcNumber).toBe(1)
    })

    // Regression tests for the known bug: the old implementation built its
    // matching regex from the raw packagePath instead of
    // basename(packagePath), so it never matched real tag names for
    // subpackages (e.g. "packages/core" vs the actual tag "core-v1.0.0-rc.1").
    it('should match tags using basename(packagePath) for nested package paths', async () => {
      mockGit.listTagsByDateDesc.mockReturnValue([
        'bar-v2.3.4-rc.2',
        'bar-v2.3.4-rc.1',
        'unrelated-v2.3.4-rc.9'
      ])

      const rcNumber = await githubService.getLatestRcVersion(
        'packages/foo/bar',
        '2.3.4'
      )
      expect(rcNumber).toBe(3)
    })

    it('should not match tags from a differently-named package (anchored regex)', async () => {
      mockGit.listTagsByDateDesc.mockReturnValue(['core-utils-v1.0.0-rc.5'])

      const rcNumber = await githubService.getLatestRcVersion('core', '1.0.0')
      expect(rcNumber).toBe(1)
    })

    it('should escape dots in the base version so they cannot match arbitrary characters', async () => {
      // Unescaped, "1.0.0" as a regex would match "1x0y0" too ('.' means
      // "any character"). The tag below must NOT match.
      mockGit.listTagsByDateDesc.mockReturnValue(['core-v1x0y0-rc.9'])

      const rcNumber = await githubService.getLatestRcVersion('core', '1.0.0')
      expect(rcNumber).toBe(1)
    })

    // Regression tests for the root-package RC bug: basename('.') is '.',
    // so the subpackage-style regex `^${basename}-v...` became `^\.-v...`
    // for the root package -- which can never match, because createRelease
    // tags the root package with NO prefix at all (just `v<version>-rc.n`).
    // Root RC lookup therefore always returned null (-> RC.1), so every
    // prerelease after the first for the same root base version collided
    // with the existing tag.
    it('should match unprefixed root-package RC tags (packagePath === ".")', async () => {
      mockGit.listTagsByDateDesc.mockReturnValue([
        'v1.0.0-rc.3',
        'v1.0.0-rc.2',
        'v1.0.0-rc.1'
      ])

      const rcNumber = await githubService.getLatestRcVersion('.', '1.0.0')
      expect(rcNumber).toBe(4)
    })

    it('should number sequential root-package prereleases correctly across calls', async () => {
      mockGit.listTagsByDateDesc.mockReturnValue([])
      expect(await githubService.getLatestRcVersion('.', '2.0.0')).toBe(1)

      mockGit.listTagsByDateDesc.mockReturnValue(['v2.0.0-rc.1'])
      expect(await githubService.getLatestRcVersion('.', '2.0.0')).toBe(2)

      mockGit.listTagsByDateDesc.mockReturnValue(['v2.0.0-rc.2', 'v2.0.0-rc.1'])
      expect(await githubService.getLatestRcVersion('.', '2.0.0')).toBe(3)
    })

    it('should not let a root-package lookup match a subpackage RC tag', async () => {
      mockGit.listTagsByDateDesc.mockReturnValue(['core-v1.0.0-rc.5'])

      const rcNumber = await githubService.getLatestRcVersion('.', '1.0.0')
      expect(rcNumber).toBe(1)
    })
  })

  describe('getChangelogForPackage', () => {
    it('should return the changelog content for the first version section', async () => {
      const changelog =
        '## 1.0.0\n\n- Initial release\n\n## 0.9.0\n\n- Old release'
      mockGit.getFileAtRef.mockReturnValue(changelog)

      const result = await githubService.getChangelogForPackage('packages/core')
      expect(result).toBe('## 1.0.0\n\n- Initial release')
      expect(mockGit.getFileAtRef).toHaveBeenCalledWith(
        'origin/main',
        path.join('packages/core', 'CHANGELOG.md')
      )
    })

    it('should handle a missing changelog file', async () => {
      mockGit.getFileAtRef.mockReturnValue(null)
      const result = await githubService.getChangelogForPackage('packages/core')
      expect(result).toBe('')
    })

    it('should handle a changelog with no version sections', async () => {
      mockGit.getFileAtRef.mockReturnValue('No version sections here')
      const result = await githubService.getChangelogForPackage('packages/core')
      expect(result).toBe('')
    })

    it('should handle errors', async () => {
      mockGit.getFileAtRef.mockImplementation(() => {
        throw new Error('git show failed')
      })
      const result = await githubService.getChangelogForPackage('packages/core')
      expect(result).toBe('')
    })
  })

  describe('findReleasePRByVersions', () => {
    it('should return the PR number if the title matches the generated title', async () => {
      mockGh.listClosedReleasePullRequests.mockReturnValue([
        mockPr({ number: 42, title: 'chore: release core@1.2.3' })
      ])
      const manifest: PackageManifest = {
        'packages/core': { latest: '1.2.3', main: '1.2.3' }
      }
      const prNumber = await githubService.findReleasePRByVersions(
        manifest,
        'main'
      )
      expect(prNumber).toBe(42)
    })

    it('should return null if no PR matches', async () => {
      mockGh.listClosedReleasePullRequests.mockReturnValue([
        mockPr({ number: 42, title: 'chore: release unrelated@1.2.3' })
      ])
      const manifest: PackageManifest = {
        'packages/core': { latest: '1.2.3', main: '1.2.3' }
      }
      const prNumber = await githubService.findReleasePRByVersions(
        manifest,
        'main'
      )
      expect(prNumber).toBeNull()
    })

    // Regression test for the bug fix: releaseTarget was previously
    // hardcoded to 'main' instead of using the actual target passed in.
    it('should pass the actual releaseTarget through instead of hardcoding "main"', async () => {
      const manifest: PackageManifest = {
        'packages/core': { latest: '1.2.3', main: '1.2.3' },
        'packages/utils': { latest: '2.0.0', main: '2.0.0' }
      }
      mockGh.listClosedReleasePullRequests.mockReturnValue([
        mockPr({ number: 99, title: 'chore: release canary' })
      ])

      const prNumber = await githubService.findReleasePRByVersions(
        manifest,
        'canary'
      )

      expect(prNumber).toBe(99)
    })

    // Regression test: gh pr list --label genuinely filters (unlike the
    // old octokit pulls.list labels param, a silent no-op), so passing
    // labels through to listClosedReleasePullRequests here would miss
    // release PRs whose labels never got applied.
    it('fetches without a hard label filter (calls listClosedReleasePullRequests with just the limit)', async () => {
      mockGh.listClosedReleasePullRequests.mockReturnValue([])

      await githubService.findReleasePRByVersions({}, 'main')

      expect(mockGh.listClosedReleasePullRequests).toHaveBeenCalledWith(10)
    })

    it('matches by title even when the PR is missing the expected labels', async () => {
      mockGh.listClosedReleasePullRequests.mockReturnValue([
        mockPr({
          number: 55,
          title: 'chore: release core@1.2.3',
          labels: [] // labels never got applied, e.g. a failed addLabels call
        })
      ])
      const manifest: PackageManifest = {
        'packages/core': { latest: '1.2.3', main: '1.2.3' }
      }

      const prNumber = await githubService.findReleasePRByVersions(
        manifest,
        'main'
      )

      expect(prNumber).toBe(55)
    })

    it('prefers a title match that also carries the expected labels over one that does not', async () => {
      mockGh.listClosedReleasePullRequests.mockReturnValue([
        mockPr({
          number: 1,
          title: 'chore: release core@1.2.3',
          labels: []
        }),
        mockPr({
          number: 2,
          title: 'chore: release core@1.2.3',
          labels: ['release-me', 'release-target:main']
        })
      ])
      const manifest: PackageManifest = {
        'packages/core': { latest: '1.2.3', main: '1.2.3' }
      }

      const prNumber = await githubService.findReleasePRByVersions(
        manifest,
        'main'
      )

      expect(prNumber).toBe(2)
    })

    it('should return null and warn on errors', async () => {
      mockGh.listClosedReleasePullRequests.mockImplementation(() => {
        throw new Error('gh CLI Error')
      })
      const prNumber = await githubService.findReleasePRByVersions({}, 'main')
      expect(prNumber).toBeNull()
      expect(core.warning).toHaveBeenCalled()
    })
  })

  describe('generateReleasePRTitle (private)', () => {
    it('should generate correct title for single root package', () => {
      // @ts-expect-error: access private method for test
      const title = githubService.generateReleasePRTitle([
        {
          path: '.',
          name: 'core',
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
          name: 'core',
          path: 'packages/core',
          currentVersion: '1.0.0',
          newVersion: '1.1.0',
          commits: [],
          changelog: '',
          releaseTarget: 'main'
        }
      ])
      expect(title).toBe('chore: release core@1.1.0')
    })

    it('should generate correct title for multi-package', () => {
      // @ts-expect-error: access private method for test
      const title = githubService.generateReleasePRTitle([
        {
          path: 'packages/core',
          name: 'core',
          currentVersion: '1.0.0',
          newVersion: '1.1.0',
          commits: [],
          changelog: '',
          releaseTarget: 'main'
        },
        {
          path: 'packages/utils',
          name: 'utils',
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
    it('should create a comment on the PR when in a PR context', async () => {
      mockGetActionContext.mockReturnValue(
        makeContext({ isPullRequest: true, pullRequestNumber: 123 })
      )
      githubService = new GitHubService('test-token')

      await githubService.createComment('Test comment')
      expect(mockGh.createComment).toHaveBeenCalledWith(123, 'Test comment')
    })

    it('should not create a comment if not in a PR context', async () => {
      mockGetActionContext.mockReturnValue(
        makeContext({ isPullRequest: false, pullRequestNumber: undefined })
      )
      githubService = new GitHubService('test-token')

      await githubService.createComment('Test comment')
      expect(mockGh.createComment).not.toHaveBeenCalled()
    })
  })

  describe('getReleaseTargetToLatestChanges', () => {
    it('returns a change entry for every package where the target lags latest', () => {
      const manifest: PackageManifest = {
        'packages/core': { latest: '1.1.0', main: '1.0.0' },
        'packages/utils': { latest: '2.0.0', main: '2.0.0' }
      }

      const changes = githubService.getReleaseTargetToLatestChanges(
        manifest,
        'main'
      )

      expect(changes).toEqual([
        {
          name: 'core',
          path: 'packages/core',
          currentVersion: '1.0.0',
          newVersion: '1.1.0',
          commits: [],
          changelog: 'Bumped main to 1.1.0',
          releaseTarget: 'main'
        }
      ])
    })
  })

  describe('getContextSha', () => {
    it('returns the SHA from the action context', () => {
      expect(githubService.getContextSha()).toBe('test-sha')
    })
  })
})
