// GitHub-platform operations with no git equivalent: pull requests, labels,
// and issue comments. All of these go through the `gh` CLI, which is
// preinstalled and pre-authenticated (via GH_TOKEN) on GitHub-hosted runners.
//
// SECURITY: every invocation below goes through execCommand() in ./exec.js,
// which uses child_process.execFileSync with an argv array. Titles, bodies,
// labels, branch names, and commit SHAs are all untrusted text (they can
// originate from PR titles / commit messages) and are therefore ALWAYS
// passed as discrete argv elements, never interpolated into a shell string.
// Long/multiline bodies (PR bodies, comments) are passed via `--body-file -`
// with the body supplied on stdin through ExecOptions.input, so they never
// touch argv parsing at all.
import { execCommand, ExecError } from './exec.js'

export interface PullRequestInfo {
  number: number
  title: string
  labels: string[]
  merged: boolean
  mergedAt: string | null
}

interface GhLabel {
  name: string
}

interface GhPullRequestView {
  number: number
  title: string
  labels: GhLabel[]
  mergedAt: string | null
  state: string
}

interface GhPullRequestListItem {
  number: number
  title: string
  labels: GhLabel[]
}

interface GhCommitPull {
  number: number
  title: string
  labels: GhLabel[]
  merged_at: string | null
}

let ghToken = ''
let ghRepo = ''

/**
 * Stores the token and 'owner/repo' string used by every subsequent gh
 * call in this module. Must be called once before any other export here
 * is used (the GitHubService facade constructor does this).
 */
export function configureGh(token: string, repo: string): void {
  ghToken = token
  ghRepo = repo
}

function ghEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GH_TOKEN: ghToken }
}

function runGh(args: string[], input?: string): string {
  return execCommand('gh', args, { env: ghEnv(), input }).stdout
}

function parseJson<T>(raw: string, args: string[]): T {
  try {
    return JSON.parse(raw) as T
  } catch (error) {
    throw new Error(
      `Failed to parse JSON output from "gh ${args.join(' ')}": ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    )
  }
}

function toPullRequestInfo(
  pr: GhPullRequestListItem,
  merged: boolean,
  mergedAt: string | null
): PullRequestInfo {
  return {
    number: pr.number,
    title: pr.title,
    labels: pr.labels.map((label) => label.name),
    merged,
    mergedAt
  }
}

/**
 * Distinguishes a genuine "PR not found" gh failure from every other kind
 * of exec failure (not authenticated, rate-limited, network error, ...).
 * `gh pr view --json ...` queries via GraphQL, so a missing PR number
 * surfaces as "Could not resolve to a PullRequest ..." rather than a plain
 * HTTP 404; both patterns (plus the REST-style 404 gh sometimes prints) are
 * treated as "not found". Anything else is a real failure that must
 * propagate, not be swallowed into a false negative.
 */
function isPullRequestNotFoundError(error: unknown): boolean {
  if (!(error instanceof ExecError)) {
    return false
  }
  const text = `${error.stderr}\n${error.message}`
  return (
    /Could not resolve to a PullRequest/i.test(text) ||
    /no pull requests found/i.test(text) ||
    /HTTP 404/i.test(text)
  )
}

/**
 * gh pr view <n> -R repo --json number,title,labels,mergedAt,state
 * Returns null only when gh reports the PR genuinely does not exist,
 * matching the old octokit try/catch-and-null callers for a real 404.
 * Every other failure (auth, rate limit, network) is rethrown -- the old
 * Octokit call would have thrown too, and swallowing it here previously
 * made e.g. isPullRequestMerged() silently return false on a transient gh
 * failure instead of failing the run loudly and retryably.
 */
export function getPullRequest(prNumber: number): PullRequestInfo | null {
  const args = [
    'pr',
    'view',
    String(prNumber),
    '-R',
    ghRepo,
    '--json',
    'number,title,labels,mergedAt,state'
  ]

  let raw: string
  try {
    raw = runGh(args)
  } catch (error) {
    if (isPullRequestNotFoundError(error)) {
      return null
    }
    throw error
  }

  const pr = parseJson<GhPullRequestView>(raw, args)
  return toPullRequestInfo(pr, pr.mergedAt !== null, pr.mergedAt)
}

/**
 * gh pr list -R repo --state open --head <branch> --json number,title,labels
 */
export function listOpenPullRequests(headBranch: string): PullRequestInfo[] {
  const args = [
    'pr',
    'list',
    '-R',
    ghRepo,
    '--state',
    'open',
    '--head',
    headBranch,
    '--json',
    'number,title,labels'
  ]

  const raw = runGh(args)
  const prs = parseJson<GhPullRequestListItem[]>(raw, args)
  return prs.map((pr) => toPullRequestInfo(pr, false, null))
}

/**
 * gh pr list -R repo --state closed --json number,title,labels --limit <n>
 *
 * Deliberately does NOT filter by --label. The old octokit `pulls.list`
 * call's `labels` param was a silent no-op on GitHub's REST API, so
 * matching a release PR by label there was always effectively a no-op --
 * real matching was title-only, over the most recently *updated* closed
 * PRs. `gh pr list --label` genuinely filters server-side, so applying it
 * here would miss release PRs whose labels never actually got applied
 * (e.g. a failed addLabels call after merge, or a consumer that passes
 * createReleasePullRequest a custom label instead of the hardcoded
 * 'release-me'), breaking the post-merge "released" label application.
 * Callers should therefore match primarily by title and treat labels as at
 * most a secondary/bonus signal, restoring the old effective behavior.
 */
export function listClosedReleasePullRequests(
  limit?: number
): PullRequestInfo[] {
  const args = [
    'pr',
    'list',
    '-R',
    ghRepo,
    '--state',
    'closed',
    '--json',
    'number,title,labels',
    '--limit',
    String(limit ?? 10)
  ]

  const raw = runGh(args)
  const prs = parseJson<GhPullRequestListItem[]>(raw, args)
  return prs.map((pr) => toPullRequestInfo(pr, false, null))
}

/**
 * gh pr create -R repo --title <t> --body-file - --head <h> --base <b>
 * with body on stdin. Parses the PR number from the trailing
 * '/pull/<n>' in the printed PR URL.
 */
export function createPullRequest(options: {
  title: string
  body: string
  head: string
  base: string
}): number {
  const args = [
    'pr',
    'create',
    '-R',
    ghRepo,
    '--title',
    options.title,
    '--body-file',
    '-',
    '--head',
    options.head,
    '--base',
    options.base
  ]

  const raw = runGh(args, options.body)
  const match = raw.trim().match(/\/pull\/(\d+)\s*$/)
  if (!match) {
    throw new Error(
      `Failed to parse PR number from "gh ${args.join(' ')}" output: ${raw}`
    )
  }

  return parseInt(match[1], 10)
}

/**
 * gh pr edit <n> -R repo --title <t> --body-file - with body on stdin.
 */
export function updatePullRequest(
  prNumber: number,
  title: string,
  body: string
): void {
  const args = [
    'pr',
    'edit',
    String(prNumber),
    '-R',
    ghRepo,
    '--title',
    title,
    '--body-file',
    '-'
  ]

  runGh(args, body)
}

/**
 * gh api repos/<repo>/issues/<n>/labels, one -f labels[]=<label> per label.
 * MUST go through the REST issues/labels endpoint (not `gh pr edit
 * --add-label`) because this endpoint auto-creates missing labels, exactly
 * like the old octokit issues.addLabels did -- 'release-target:<x>' labels
 * won't pre-exist in consumer repos.
 */
export function addLabels(prNumber: number, labels: string[]): void {
  if (labels.length === 0) {
    return
  }

  const args = [
    'api',
    `repos/${ghRepo}/issues/${prNumber}/labels`,
    '-X',
    'POST'
  ]
  for (const label of labels) {
    args.push('-f', `labels[]=${label}`)
  }

  runGh(args)
}

/**
 * gh api -X DELETE repos/<repo>/issues/<n>/labels/<label>.
 * Intentionally does NOT catch -- callers (e.g. the facade's
 * addLabel('released') path, which tries to remove 'release-me' first)
 * decide whether a failure here is fatal or just a warning.
 */
export function removeLabel(prNumber: number, label: string): void {
  const args = [
    'api',
    '-X',
    'DELETE',
    `repos/${ghRepo}/issues/${prNumber}/labels/${encodeURIComponent(label)}`
  ]

  runGh(args)
}

/**
 * gh pr comment <n> -R repo --body-file - with body on stdin.
 */
export function createComment(prNumber: number, body: string): void {
  const args = [
    'pr',
    'comment',
    String(prNumber),
    '-R',
    ghRepo,
    '--body-file',
    '-'
  ]

  runGh(args, body)
}

/**
 * gh api repos/<repo>/commits/<sha>/pulls
 * Returns every PR associated with the commit; callers filter to merged
 * ones and sort by mergedAt themselves.
 */
export function getMergedPullRequestsForCommit(sha: string): PullRequestInfo[] {
  const args = ['api', `repos/${ghRepo}/commits/${sha}/pulls`]

  const raw = runGh(args)
  const prs = parseJson<GhCommitPull[]>(raw, args)
  return prs.map((pr) =>
    toPullRequestInfo(pr, pr.merged_at !== null, pr.merged_at)
  )
}
