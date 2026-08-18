import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execCommand, ExecError } from './exec.js'

/**
 * All git-native operations for the action.
 *
 * SECURITY: every invocation goes through `execCommand('git', [...argv])`
 * (src/exec.ts, the single `child_process` touchpoint) with each value as a
 * discrete argv element — never an interpolated shell string. Tag names,
 * branch names, refs, commit messages and file contents derive from
 * untrusted commit/PR text and may contain shell metacharacters; passing
 * them as argv elements makes those inert. Where git accepts an
 * end-of-options `--` separator, positional ref/path arguments are placed
 * after it; where it does not, refs are either prefixed with a literal
 * namespace (`refs/tags/`, `refs/heads/`, `origin/`) or validated to not
 * start with `-` so they cannot be smuggled in as git options.
 */

/** Record separator used in `git log --pretty` output (ASCII RS). */
const RECORD_SEPARATOR = '\x1e'
/** Unit separator used in `git log --pretty` output (ASCII US). */
const UNIT_SEPARATOR = '\x1f'

export interface GitCommit {
  sha: string
  message: string
  files: string[]
}

export interface CommitFileEntry {
  path: string
  content: string
}

/**
 * A command run inside the worktree, after `files` are written but before
 * the commit, whose own file changes (e.g. `cargo update --workspace`
 * refreshing `Cargo.lock`) are picked up alongside `files` automatically --
 * see the `git add -A` note in `commitFilesToBranch` below.
 */
export interface CommitPostWriteCommand {
  /** Directory the command runs in, relative to the worktree root. */
  cwd: string
  file: 'cargo'
  args: string[]
}

/**
 * Guards a value that will be passed to git in a position where git does
 * not support an end-of-options `--` separator and the value is not
 * neutralized by a literal prefix. Git itself refuses ref names starting
 * with `-`, so rejecting them here loses no functionality while preventing
 * untrusted input from being interpreted as a git option.
 */
function assertSafePositional(value: string, what: string): void {
  if (value.startsWith('-')) {
    throw new Error(`Refusing to pass ${what} starting with '-': ${value}`)
  }
}

/** The `token` action input, used to authenticate pushes. Empty until
 * `configureGitAuth` is called (the GitHubService facade constructor does
 * this), in which case pushes fall back to whatever credentials
 * `actions/checkout` already persisted in the runner's git config. */
let gitAuthToken = ''

/**
 * Stores the `token` action input so pushes can authenticate with it
 * explicitly, matching the old Octokit-based implementation (which always
 * pushed using the `token` input, not ambient runner credentials). This
 * matters for consumers who deliberately pass a PAT so that release-PR
 * pushes trigger downstream CI workflows (pushes authenticated as the
 * default GITHUB_TOKEN suppress workflow-triggering events), and for
 * workflows that check out with `persist-credentials: false`.
 */
export function configureGitAuth(token: string): void {
  gitAuthToken = token
}

/**
 * Builds an env override that authenticates a single git push with the
 * configured token, via the `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/
 * `GIT_CONFIG_VALUE_n` env-var mechanism (git >= 2.31) rather than a
 * `-c http.extraheader=...` argv element -- this keeps the base64-encoded
 * token out of argv (and therefore out of `ps` output) the same way gh.ts
 * threads GH_TOKEN via env instead of an argv flag. Nothing is written to
 * repo or global git config, so the override is scoped to only the single
 * `execCommand` call it's passed to. Mirrors the header actions/checkout
 * itself sets for the same purpose. Returns undefined when no token has
 * been configured, so callers fall back to ambient (checkout-persisted)
 * credentials.
 */
function pushAuthEnv(): NodeJS.ProcessEnv | undefined {
  if (!gitAuthToken) {
    return undefined
  }

  const basicAuth = Buffer.from(`x-access-token:${gitAuthToken}`).toString(
    'base64'
  )

  return {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basicAuth}`
  }
}

/** Runs a `git push` with the token-based auth override applied only when
 * a token has been configured, so untouched (no-token) call sites keep
 * behaving exactly as before. */
function execPush(args: string[]): void {
  const authEnv = pushAuthEnv()
  if (authEnv) {
    execCommand('git', args, { env: authEnv })
  } else {
    execCommand('git', args)
  }
}

/**
 * Fetches all tags from origin. Defensive no-op when tags are already
 * present (the consuming workflow checks out with fetch-depth: 0). Failures
 * (e.g. offline test environments) are swallowed on purpose.
 */
export function fetchTags(): void {
  try {
    execCommand('git', ['fetch', '--tags', '--force', '--quiet', 'origin'], {
      allowNonZeroExit: true
    })
  } catch {
    // Swallow failures (e.g. no git binary or no remote in tests).
  }
}

/**
 * Resolves a ref (branch name, fully-qualified ref, SHA, ...) to the first
 * candidate spelling that points at a commit in the local clone. On pull
 * request events the clone is a detached merge ref, so plain branch names
 * often only exist as `origin/<branch>`. Returns the resolvable candidate
 * string (usable in later git commands), or null when nothing resolves.
 */
export function resolveRef(ref: string): string | null {
  const stripped = ref.replace(/^refs\/heads\//, '')
  const candidates = [ref, stripped, `origin/${stripped}`, 'HEAD']
  const seen = new Set<string>()

  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate) || candidate.startsWith('-')) {
      continue
    }
    seen.add(candidate)

    const result = execCommand(
      'git',
      ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`],
      { allowNonZeroExit: true }
    )
    if (result.exitCode === 0) {
      return candidate
    }
  }

  return null
}

/**
 * Counts the commits reachable from `ref` (default HEAD). Replaces the old
 * repos.listCommits + Link-header pagination dance.
 */
export function getCommitCount(ref?: string): number {
  const target = ref ?? 'HEAD'
  assertSafePositional(target, 'ref')
  const result = execCommand('git', ['rev-list', '--count', target, '--'])
  return parseInt(result.stdout.trim(), 10)
}

/**
 * Lists the commits in `base..head` (or all commits reachable from `head`
 * when base is null), oldest first — matching the order of the old GitHub
 * compare API. When `includeFiles` is true each commit carries the paths it
 * touched (replacing the old per-commit repos.getCommit calls).
 *
 * Parsing uses ASCII record/unit separators in the pretty format because
 * commit bodies are multiline: records must NEVER be split on newlines.
 */
export function getCommitsBetween(
  base: string | null,
  head: string,
  includeFiles: boolean
): GitCommit[] {
  assertSafePositional(head, 'head ref')
  if (base !== null) {
    assertSafePositional(base, 'base ref')
  }

  const range = base ? `${base}..${head}` : head
  const args = [
    'log',
    '--reverse',
    `--pretty=format:${RECORD_SEPARATOR}%H${UNIT_SEPARATOR}%B${UNIT_SEPARATOR}`
  ]
  if (includeFiles) {
    // `--diff-merges=first-parent` makes merge commits report a file list
    // too (git log otherwise suppresses diff/name output for merge commits
    // unless told which parent(s) to diff against), and diffs them against
    // their first parent specifically -- consistent with how the rest of
    // the pipeline (see getLastCommitDiffForFile) treats merge commits.
    // This only changes the diff FORMAT, not which commits are traversed,
    // so the base..head commit-range logic above is unaffected.
    args.push('--name-only', '--diff-merges=first-parent')
  }
  args.push(range, '--')

  const result = execCommand('git', args)

  const commits: GitCommit[] = []
  for (const record of result.stdout.split(RECORD_SEPARATOR)) {
    if (!record.trim()) {
      continue
    }

    const units = record.split(UNIT_SEPARATOR)
    if (units.length < 2) {
      continue
    }

    const sha = units[0].trim()
    const message = units[1].replace(/\s+$/, '')
    const filesBlock = units[2] ?? ''
    const files = filesBlock
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)

    commits.push({ sha, message, files })
  }

  return commits
}

/**
 * Lists all tags newest-first by creation date. Unlike the old
 * repos.listTags call (whose sort params were silently ignored by the API),
 * this ordering is genuine.
 */
export function listTagsByDateDesc(): string[] {
  const result = execCommand('git', ['tag', '--list', '--sort=-creatordate'])
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** Returns true when the tag exists in the local clone. */
export function tagExists(tagName: string): boolean {
  const result = execCommand(
    'git',
    ['rev-parse', '--verify', '--quiet', `refs/tags/${tagName}`],
    { allowNonZeroExit: true }
  )
  return result.exitCode === 0
}

/**
 * Creates an annotated tag pointing at `sha` whose tag message is the
 * changelog (replacing the old refs/tags createRef + createRelease pair).
 * The message may be multiline; callers should pass a non-empty message
 * (e.g. `message || tagName`). When `force` is true, an existing tag of the
 * same name is force-moved to the new sha/message (the git equivalent of
 * the old Octokit `createRef({ force: true })` upsert) -- used only when
 * the `overwrite-existing-tags` input opts into clobbering a pre-existing
 * tag; the default path never passes `force`.
 *
 * An annotated tag is itself a git object with its own "tagger" field
 * (like a commit's author/committer), so it fails with "empty ident
 * name"/"Committer identity unknown" on a runner with no git identity
 * configured -- exactly like `commitFilesToBranch`'s commit step would
 * without its own `-c user.name`/`-c user.email`. `userName`/`userEmail`
 * (the `git-user-name`/`git-user-email` action inputs) are applied the same
 * way here, scoped to just this command.
 */
export function createAnnotatedTag(
  tagName: string,
  message: string,
  sha: string,
  userName: string,
  userEmail: string,
  force: boolean = false
): void {
  // `-m` before `--` so the untrusted tag name and sha can never be read as
  // options; the multiline message is a single argv element.
  const identityArgs = [
    '-c',
    `user.name=${userName}`,
    '-c',
    `user.email=${userEmail}`
  ]
  const args = force
    ? [...identityArgs, 'tag', '-f', '-a', '-m', message, '--', tagName, sha]
    : [...identityArgs, 'tag', '-a', '-m', message, '--', tagName, sha]
  execCommand('git', args)
}

/**
 * Pushes a single tag to origin, authenticated with the `token` action
 * input when one has been configured via `configureGitAuth`. `force`
 * force-updates a remote tag ref that already points elsewhere (needed when
 * `createAnnotatedTag` was called with `force: true` to move an existing
 * tag).
 */
export function pushTag(tagName: string, force: boolean = false): void {
  const args = force
    ? ['push', '--force', 'origin', `refs/tags/${tagName}`]
    : ['push', 'origin', `refs/tags/${tagName}`]
  execPush(args)
}

/**
 * Reads a file's content at a ref (`git show <ref>:<path>`), replacing
 * repos.getContent. Returns null when the ref or the file does not exist.
 * NOTE: callers should pass `origin/main` rather than `main` — on PR events
 * the clone is a detached merge ref and no local `main` branch exists.
 */
export function getFileAtRef(ref: string, filePath: string): string | null {
  assertSafePositional(ref, 'ref')
  const result = execCommand('git', ['show', `${ref}:${filePath}`], {
    allowNonZeroExit: true
  })
  return result.exitCode === 0 ? result.stdout : null
}

/**
 * Returns true when the branch exists on the REMOTE. This must be a remote
 * check: release branches are deleted on GitHub after merge while possibly
 * still being present in the local clone.
 */
export function remoteBranchExists(branch: string): boolean {
  const result = execCommand('git', [
    'ls-remote',
    '--heads',
    'origin',
    `refs/heads/${branch}`
  ])
  return result.stdout.trim().length > 0
}

/**
 * Resolves the SHA of a remote-tracking branch (e.g. the main branch SHA,
 * replacing repos.getBranch). Returns null when it does not exist locally.
 */
export function getRemoteBranchSha(branch: string): string | null {
  const result = execCommand(
    'git',
    ['rev-parse', '--verify', '--quiet', `origin/${branch}`],
    { allowNonZeroExit: true }
  )
  if (result.exitCode !== 0) {
    return null
  }
  const sha = result.stdout.trim()
  return sha.length > 0 ? sha : null
}

/**
 * Returns the patch text for `filePath` in the commit at `ref` (default
 * HEAD), or '' when that commit did not touch the file. Replaces the old
 * repos.getCommit file.patch inspection.
 *
 * Diffs explicitly against the first parent (`<ref>^`) rather than using
 * `git show <ref> -- <path>` directly: for a merge commit, `git show`
 * implicitly produces a COMBINED diff (as if `--cc` were passed), which
 * omits any file that ended up identical to ANY parent. A cleanly merged
 * release PR's manifest change is exactly such a file (identical to the
 * release branch's version, one of the merge's parents), so the combined
 * diff came back empty and callers like wasManifestUpdatedInLastCommit
 * silently concluded the manifest was never touched. A first-parent diff
 * matches what GitHub's REST API returned for
 * `repos.getCommit().files[].patch`, and is identical to `git show`'s
 * output for an ordinary (single-parent) commit, so this is a no-op change
 * for the common case.
 */
export function getLastCommitDiffForFile(
  filePath: string,
  ref?: string
): string {
  const target = ref ?? 'HEAD'
  assertSafePositional(target, 'ref')

  const hasParent =
    execCommand('git', ['rev-parse', '--verify', '--quiet', `${target}^`], {
      allowNonZeroExit: true
    }).exitCode === 0

  if (hasParent) {
    return execCommand('git', ['diff', `${target}^`, target, '--', filePath])
      .stdout
  }

  // No first parent (e.g. `target` is the repository's root commit) --
  // fall back to git show's default diff-against-empty-tree behavior.
  return execCommand('git', ['show', target, '--format=', '--', filePath])
    .stdout
}

/**
 * Creates (or force-updates) `branch` on origin with a single commit on top
 * of `baseRef` containing `files` plus whatever `postWriteCommands` (if any)
 * change on top of them, replacing the old Git Data API blob/tree/commit/ref
 * dance. Uses a temporary detached worktree so the runner's checked-out tree
 * stays pristine, and force-pushes to replicate the old
 * `updateRef({ force: true })` upsert semantics. Returns the new commit SHA.
 */
export function commitFilesToBranch(options: {
  branch: string
  baseRef: string
  message: string
  files: CommitFileEntry[]
  postWriteCommands?: CommitPostWriteCommand[]
  userName: string
  userEmail: string
}): string {
  const {
    branch,
    baseRef,
    message,
    files,
    postWriteCommands = [],
    userName,
    userEmail
  } = options
  assertSafePositional(baseRef, 'base ref')

  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-action-'))
  execCommand('git', ['worktree', 'add', '--detach', worktreeDir, baseRef])

  try {
    for (const file of files) {
      const target = path.resolve(worktreeDir, file.path)
      if (
        target !== worktreeDir &&
        !target.startsWith(worktreeDir + path.sep)
      ) {
        throw new Error(`Refusing to write outside the worktree: ${file.path}`)
      }
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, file.content)
    }

    for (const command of postWriteCommands) {
      const cwd = path.resolve(worktreeDir, command.cwd)
      if (cwd !== worktreeDir && !cwd.startsWith(worktreeDir + path.sep)) {
        throw new Error(
          `Refusing to run a post-write command outside the worktree: ${command.cwd}`
        )
      }
      execCommand(command.file, command.args, { cwd })
    }

    // `-A` rather than the explicit `files` list: postWriteCommands (e.g.
    // `cargo update --workspace` refreshing Cargo.lock) can touch files
    // beyond the ones we wrote ourselves, and the worktree only ever
    // contains a clean checkout of `baseRef` plus those changes, so this
    // stays precisely scoped to what actually changed.
    execCommand('git', ['-C', worktreeDir, 'add', '-A'])

    const commitArgs = [
      '-C',
      worktreeDir,
      '-c',
      `user.name=${userName}`,
      '-c',
      `user.email=${userEmail}`,
      'commit',
      '-m',
      message
    ]
    // allowNonZeroExit so a "nothing to commit" result (the release content
    // already landed on main, e.g. a re-run right after a squash-merge) can
    // be distinguished from a real failure below, instead of always
    // throwing the way `git commit` does by default -- the old Git Data
    // API happily "created" an empty commit and force-updated the branch
    // to the same tree in this situation, so this restores that no-op
    // upsert semantics rather than failing the run.
    const commitResult = execCommand('git', commitArgs, {
      allowNonZeroExit: true
    })

    if (commitResult.exitCode !== 0) {
      if (
        !/nothing to commit/i.test(commitResult.stdout + commitResult.stderr)
      ) {
        throw new ExecError(
          ['git', ...commitArgs].join(' '),
          commitResult.exitCode,
          commitResult.stderr
        )
      }
      // Working tree is already clean relative to baseRef: no-op instead
      // of pushing an empty commit.
    } else {
      // Authenticate with the `token` action input when configured, so
      // consumers relying on PAT-triggered downstream workflows (or
      // `persist-credentials: false` checkouts) keep working -- scoped to
      // just this push invocation, never persisted to git config.
      execPush([
        '-C',
        worktreeDir,
        'push',
        '--force',
        'origin',
        `HEAD:refs/heads/${branch}`
      ])
    }

    return execCommand('git', [
      '-C',
      worktreeDir,
      'rev-parse',
      'HEAD'
    ]).stdout.trim()
  } finally {
    execCommand('git', ['worktree', 'remove', '--force', worktreeDir], {
      allowNonZeroExit: true
    })
    fs.rmSync(worktreeDir, { recursive: true, force: true })
  }
}
