import { execFileSync } from 'child_process'

/**
 * The single subprocess touchpoint for this codebase. This is the ONLY file
 * allowed to import `child_process`. Every git/gh invocation elsewhere MUST
 * go through `execCommand()` below, passing arguments as a discrete argv
 * array (never as an interpolated shell string, and never with
 * `shell: true`). Commit messages, PR titles, branch/tag names and
 * changelog bodies all derive from untrusted commit/PR text and can contain
 * shell metacharacters (backticks, `$()`, quotes, newlines) — string-
 * interpolating them into a shell command would be a command-injection
 * vulnerability.
 */

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface ExecOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  input?: string
  allowNonZeroExit?: boolean
}

/**
 * Thrown when a command exits non-zero and the caller did not opt in to
 * `allowNonZeroExit`. Never includes env values (e.g. tokens) in its
 * message — only the executable name, its arguments, and trimmed stderr.
 */
export class ExecError extends Error {
  readonly command: string
  readonly exitCode: number
  readonly stderr: string

  constructor(command: string, exitCode: number, stderr: string) {
    const trimmedStderr = stderr.trim()
    super(
      trimmedStderr
        ? `Command failed: ${command} (exit code ${exitCode}): ${trimmedStderr}`
        : `Command failed: ${command} (exit code ${exitCode})`
    )
    this.name = 'ExecError'
    this.command = command
    this.exitCode = exitCode
    this.stderr = stderr
  }
}

/**
 * Runs `file` (either 'git' or 'gh') with `args` as an argv array via
 * `execFileSync` — never a shell string, never `shell: true`.
 *
 * On non-zero exit, throws an `ExecError` unless `options.allowNonZeroExit`
 * is true, in which case the result is returned with the real `exitCode`
 * (used for existence probes like `git ls-remote` / `git rev-parse`).
 */
export function execCommand(
  file: 'git' | 'gh',
  args: string[],
  options: ExecOptions = {}
): ExecResult {
  const command = [file, ...args].join(' ')

  try {
    const stdout = execFileSync(file, args, {
      cwd: options.cwd,
      env: options.env,
      input: options.input,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe']
    })

    return {
      stdout,
      stderr: '',
      exitCode: 0
    }
  } catch (error) {
    const execError = error as {
      status?: number | null
      signal?: string | null
      stdout?: string | Buffer
      stderr?: string | Buffer
      message?: string
    }

    const stdout = toUtf8(execError.stdout)
    const stderr = toUtf8(execError.stderr)
    // A signal-terminated process (e.g. killed) has status === null; treat
    // it as a generic failure exit code since there is no real exit code.
    const exitCode = execError.status ?? 1

    if (options.allowNonZeroExit) {
      return {
        stdout,
        stderr,
        exitCode
      }
    }

    throw new ExecError(command, exitCode, stderr || execError.message || '')
  }
}

function toUtf8(value: string | Buffer | undefined): string {
  if (value === undefined) {
    return ''
  }
  return typeof value === 'string' ? value : value.toString('utf-8')
}
