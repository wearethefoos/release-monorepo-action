import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { execCommand, ExecError } from './exec.js'
import {
  configureGh,
  getPullRequest,
  listOpenPullRequests,
  listClosedReleasePullRequests,
  createPullRequest,
  updatePullRequest,
  addLabels,
  removeLabel,
  createComment,
  getMergedPullRequestsForCommit
} from './gh.js'

// The real ExecError class is kept (not mocked) since gh.ts's
// getPullRequest distinguishes it (via `instanceof`) from other thrown
// errors to decide whether a failure means "not found" or a real error.
vi.mock('./exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./exec.js')>()
  return {
    ...actual,
    execCommand: vi.fn()
  }
})

const mockExecCommand = execCommand as unknown as Mock

// A body with shell metacharacters that must NEVER be interpolated into an
// argv element or a shell string -- it must only ever travel via stdin
// (ExecOptions.input) alongside a literal ['--body-file', '-'] pair.
const DANGEROUS_BODY =
  'line one `whoami` $(rm -rf /) "quoted" \nline two\nline three'

describe('gh.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: a successful call with empty stdout, for functions (addLabels,
    // removeLabel, createComment, updatePullRequest) that don't parse a
    // return value. Tests that need specific stdout override with
    // mockStdout/mockJson (mockReturnValueOnce takes precedence).
    mockExecCommand.mockReturnValue({ stdout: '', stderr: '', exitCode: 0 })
    configureGh('test-token', 'test-owner/test-repo')
  })

  function lastCall(): { args: string[]; options: Record<string, unknown> } {
    const call =
      mockExecCommand.mock.calls[mockExecCommand.mock.calls.length - 1]
    return {
      args: call[1] as string[],
      options: (call[2] ?? {}) as Record<string, unknown>
    }
  }

  function expectGhToken(options: Record<string, unknown>): void {
    const env = options.env as NodeJS.ProcessEnv | undefined
    expect(env).toBeDefined()
    expect(env?.GH_TOKEN).toBe('test-token')
  }

  function mockStdout(stdout: string): void {
    mockExecCommand.mockReturnValueOnce({ stdout, stderr: '', exitCode: 0 })
  }

  function mockJson(value: unknown): void {
    mockStdout(JSON.stringify(value))
  }

  describe('getPullRequest', () => {
    it('calls gh pr view with the expected argv and env, and parses labels/merged', () => {
      mockJson({
        number: 42,
        title: 'feat: add thing',
        labels: [{ name: 'release-me' }, { name: 'release-target:main' }],
        mergedAt: '2026-01-01T00:00:00Z',
        state: 'MERGED'
      })

      const result = getPullRequest(42)

      expect(mockExecCommand).toHaveBeenCalledTimes(1)
      const [file] = mockExecCommand.mock.calls[0]
      expect(file).toBe('gh')
      const { args, options } = lastCall()
      expect(args).toEqual([
        'pr',
        'view',
        '42',
        '-R',
        'test-owner/test-repo',
        '--json',
        'number,title,labels,mergedAt,state'
      ])
      expectGhToken(options)

      expect(result).toEqual({
        number: 42,
        title: 'feat: add thing',
        labels: ['release-me', 'release-target:main'],
        merged: true,
        mergedAt: '2026-01-01T00:00:00Z'
      })
    })

    it('derives merged=false from a null mergedAt', () => {
      mockJson({
        number: 7,
        title: 'open pr',
        labels: [],
        mergedAt: null,
        state: 'OPEN'
      })

      const result = getPullRequest(7)

      expect(result?.merged).toBe(false)
      expect(result?.mergedAt).toBeNull()
    })

    it('returns null when gh reports the PR does not exist (GraphQL not-found signal)', () => {
      mockExecCommand.mockImplementationOnce(() => {
        throw new ExecError(
          'gh pr view 999 -R test-owner/test-repo --json ...',
          1,
          'GraphQL: Could not resolve to a PullRequest with the number of 999. (repository.pullRequest)'
        )
      })

      const result = getPullRequest(999)

      expect(result).toBeNull()
    })

    it('returns null on a REST-style HTTP 404', () => {
      mockExecCommand.mockImplementationOnce(() => {
        throw new ExecError(
          'gh pr view 999 ...',
          1,
          'HTTP 404: Not Found (https://api.github.com/repos/test-owner/test-repo/pulls/999)'
        )
      })

      expect(getPullRequest(999)).toBeNull()
    })

    // Regression test: the old implementation caught *any* exec failure
    // and returned null the same as a genuine 404, so a transient gh
    // failure (auth, rate limit, network) on a merged release PR made
    // isPullRequestMerged() silently return false instead of failing the
    // run loudly and retryably.
    it('propagates non-not-found ExecErrors (auth failure, rate limit, network error) instead of swallowing them', () => {
      mockExecCommand.mockImplementationOnce(() => {
        throw new ExecError(
          'gh pr view 42 ...',
          1,
          'gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment variable.'
        )
      })

      expect(() => getPullRequest(42)).toThrow(/GH_TOKEN environment variable/)
    })

    it('propagates a plain (non-ExecError) failure too', () => {
      mockExecCommand.mockImplementationOnce(() => {
        throw new Error('boom')
      })

      expect(() => getPullRequest(1)).toThrow('boom')
    })
  })

  describe('listOpenPullRequests', () => {
    it('calls gh pr list with --state open and --head, and maps merged=false/mergedAt=null', () => {
      mockJson([
        {
          number: 1,
          title: 'release: v1.0.0',
          labels: [{ name: 'release-me' }]
        },
        { number: 2, title: 'release: v2.0.0', labels: [] }
      ])

      const result = listOpenPullRequests('release-main')

      const { args, options } = lastCall()
      expect(args).toEqual([
        'pr',
        'list',
        '-R',
        'test-owner/test-repo',
        '--state',
        'open',
        '--head',
        'release-main',
        '--json',
        'number,title,labels'
      ])
      expectGhToken(options)

      expect(result).toEqual([
        {
          number: 1,
          title: 'release: v1.0.0',
          labels: ['release-me'],
          merged: false,
          mergedAt: null
        },
        {
          number: 2,
          title: 'release: v2.0.0',
          labels: [],
          merged: false,
          mergedAt: null
        }
      ])
    })
  })

  describe('listClosedReleasePullRequests', () => {
    // Regression test: gh pr list --label actually filters server-side
    // (unlike the old octokit pulls.list `labels` param, which was a
    // silent no-op), so it must NOT be passed here -- otherwise a release
    // PR whose labels never got applied (failed addLabels call, or a
    // custom label) would be invisible to title-based matching.
    it('does not filter by --label, only --state closed, and defaults --limit to 10', () => {
      mockJson([])

      listClosedReleasePullRequests()

      const { args, options } = lastCall()
      expect(args).toEqual([
        'pr',
        'list',
        '-R',
        'test-owner/test-repo',
        '--state',
        'closed',
        '--json',
        'number,title,labels',
        '--limit',
        '10'
      ])
      expect(args).not.toContain('--label')
      expectGhToken(options)
    })

    it('respects an explicit limit', () => {
      mockJson([])

      listClosedReleasePullRequests(25)

      const { args } = lastCall()
      expect(args).toContain('--limit')
      expect(args[args.indexOf('--limit') + 1]).toBe('25')
    })

    it('maps results with merged=false/mergedAt=null (closed but not necessarily merged)', () => {
      mockJson([
        {
          number: 9,
          title: 'release: v3.0.0',
          labels: [{ name: 'release-me' }]
        }
      ])

      const result = listClosedReleasePullRequests()

      expect(result).toEqual([
        {
          number: 9,
          title: 'release: v3.0.0',
          labels: ['release-me'],
          merged: false,
          mergedAt: null
        }
      ])
    })
  })

  describe('createPullRequest', () => {
    it('sends the body via --body-file - and stdin input, never inline in argv', () => {
      mockStdout('https://github.com/test-owner/test-repo/pull/456\n')

      const result = createPullRequest({
        title: 'release: v1.2.3',
        body: DANGEROUS_BODY,
        head: 'release-main',
        base: 'main'
      })

      const { args, options } = lastCall()
      expect(args).toEqual([
        'pr',
        'create',
        '-R',
        'test-owner/test-repo',
        '--title',
        'release: v1.2.3',
        '--body-file',
        '-',
        '--head',
        'release-main',
        '--base',
        'main'
      ])
      // The dangerous body must not appear anywhere in argv.
      for (const arg of args) {
        expect(arg).not.toContain(DANGEROUS_BODY)
      }
      expect(args).toContain('--body-file')
      expect(args[args.indexOf('--body-file') + 1]).toBe('-')
      expect(options.input).toBe(DANGEROUS_BODY)
      expectGhToken(options)

      expect(result).toBe(456)
    })

    it('parses the PR number from a /pull/<n> URL with surrounding whitespace', () => {
      mockStdout('  https://github.com/o/r/pull/789  \n')

      const result = createPullRequest({
        title: 't',
        body: 'b',
        head: 'h',
        base: 'main'
      })

      expect(result).toBe(789)
    })

    it('throws a descriptive error when the output does not contain a PR URL', () => {
      mockStdout('some unexpected garbage output with no url')

      expect(() =>
        createPullRequest({ title: 't', body: 'b', head: 'h', base: 'main' })
      ).toThrow(/Failed to parse PR number/)
    })
  })

  describe('updatePullRequest', () => {
    it('sends title inline but body via --body-file - and stdin input', () => {
      updatePullRequest(42, 'release: v1.2.3', DANGEROUS_BODY)

      const { args, options } = lastCall()
      expect(args).toEqual([
        'pr',
        'edit',
        '42',
        '-R',
        'test-owner/test-repo',
        '--title',
        'release: v1.2.3',
        '--body-file',
        '-'
      ])
      for (const arg of args) {
        expect(arg).not.toContain(DANGEROUS_BODY)
      }
      expect(options.input).toBe(DANGEROUS_BODY)
      expectGhToken(options)
    })
  })

  describe('addLabels', () => {
    it('uses gh api POST .../issues/<n>/labels with one -f labels[]=<label> per label', () => {
      addLabels(42, ['release-me', 'release-target:main'])

      const { args, options } = lastCall()
      expect(args).toEqual([
        'api',
        'repos/test-owner/test-repo/issues/42/labels',
        '-X',
        'POST',
        '-f',
        'labels[]=release-me',
        '-f',
        'labels[]=release-target:main'
      ])
      expectGhToken(options)
      // Must NOT use `gh pr edit --add-label`, which fails on labels that
      // don't already exist in the consuming repo.
      expect(args).not.toContain('pr')
      expect(args).not.toContain('--add-label')
    })

    it('does not invoke gh at all when there are no labels to add', () => {
      addLabels(42, [])

      expect(mockExecCommand).not.toHaveBeenCalled()
    })
  })

  describe('removeLabel', () => {
    it('uses gh api -X DELETE with the label URL-encoded in the path', () => {
      removeLabel(42, 'release-target:main')

      const { args, options } = lastCall()
      expect(args).toEqual([
        'api',
        '-X',
        'DELETE',
        `repos/test-owner/test-repo/issues/42/labels/${encodeURIComponent('release-target:main')}`
      ])
      // Confirm the colon was actually encoded, not passed through raw.
      expect(args[3]).toBe(
        'repos/test-owner/test-repo/issues/42/labels/release-target%3Amain'
      )
      expectGhToken(options)
    })

    it('propagates errors from a failed gh invocation rather than swallowing them', () => {
      mockExecCommand.mockImplementationOnce(() => {
        throw new Error('gh: label not found')
      })

      expect(() => removeLabel(42, 'release-me')).toThrow('gh: label not found')
    })
  })

  describe('createComment', () => {
    it('sends the comment body via --body-file - and stdin input, never inline', () => {
      createComment(42, DANGEROUS_BODY)

      const { args, options } = lastCall()
      expect(args).toEqual([
        'pr',
        'comment',
        '42',
        '-R',
        'test-owner/test-repo',
        '--body-file',
        '-'
      ])
      for (const arg of args) {
        expect(arg).not.toContain(DANGEROUS_BODY)
      }
      expect(options.input).toBe(DANGEROUS_BODY)
      expectGhToken(options)
    })
  })

  describe('getMergedPullRequestsForCommit', () => {
    it('calls gh api repos/<repo>/commits/<sha>/pulls and maps merged_at -> merged/mergedAt', () => {
      mockJson([
        {
          number: 10,
          title: 'release: v1.0.0',
          labels: [{ name: 'release-me' }],
          merged_at: '2026-01-01T00:00:00Z'
        },
        {
          number: 11,
          title: 'unrelated pr',
          labels: [],
          merged_at: null
        }
      ])

      const result = getMergedPullRequestsForCommit('abc123')

      const { args, options } = lastCall()
      expect(args).toEqual([
        'api',
        'repos/test-owner/test-repo/commits/abc123/pulls'
      ])
      expectGhToken(options)

      expect(result).toEqual([
        {
          number: 10,
          title: 'release: v1.0.0',
          labels: ['release-me'],
          merged: true,
          mergedAt: '2026-01-01T00:00:00Z'
        },
        {
          number: 11,
          title: 'unrelated pr',
          labels: [],
          merged: false,
          mergedAt: null
        }
      ])
    })
  })

  describe('JSON parse error handling', () => {
    it("propagates a descriptive parse error (including the gh command) when gh succeeds but prints non-JSON -- this is distinct from getPullRequest's null-on-ExecError path, since the command itself did not fail", () => {
      mockStdout('not json at all')

      expect(() => getPullRequest(1)).toThrow(
        /Failed to parse JSON output from "gh pr view/
      )
    })

    it('throws the same style of parse error for a list-returning call', () => {
      mockStdout('{not valid json')

      expect(() => listOpenPullRequests('release-main')).toThrow(
        /Failed to parse JSON output from "gh pr list/
      )
    })
  })
})
