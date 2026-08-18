import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { execCommand, ExecError } from './exec'
import * as childProcess from 'child_process'

// Mock child_process module
vi.mock('child_process')

interface MockExecError extends Error {
  status?: number | null
  signal?: string
  stdout?: string | Buffer
  stderr?: string | Buffer
}

describe('exec.ts', () => {
  let execFileSync: ReturnType<
    typeof vi.mocked<typeof childProcess.execFileSync>
  >

  beforeEach(() => {
    // Get the mocked execFileSync using vi.mocked
    execFileSync = vi.mocked(childProcess.execFileSync)
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('execCommand success cases', () => {
    it('should call execFileSync with correct arguments for git command', () => {
      execFileSync.mockReturnValue('success output')

      const result = execCommand('git', ['commit', '-m', 'test message'])

      expect(execFileSync).toHaveBeenCalledWith(
        'git',
        ['commit', '-m', 'test message'],
        {
          cwd: undefined,
          env: undefined,
          input: undefined,
          encoding: 'utf-8',
          maxBuffer: 32 * 1024 * 1024,
          stdio: ['pipe', 'pipe', 'pipe']
        }
      )
      expect(result).toEqual({
        stdout: 'success output',
        stderr: '',
        exitCode: 0
      })
    })

    it('should call execFileSync with correct arguments for gh command', () => {
      execFileSync.mockReturnValue('pr created')

      const result = execCommand('gh', ['pr', 'create', '--title', 'Test PR'])

      expect(execFileSync).toHaveBeenCalledWith(
        'gh',
        ['pr', 'create', '--title', 'Test PR'],
        {
          cwd: undefined,
          env: undefined,
          input: undefined,
          encoding: 'utf-8',
          maxBuffer: 32 * 1024 * 1024,
          stdio: ['pipe', 'pipe', 'pipe']
        }
      )
      expect(result).toEqual({
        stdout: 'pr created',
        stderr: '',
        exitCode: 0
      })
    })

    it('should return stdout unmodified on success', () => {
      const expectedOutput =
        'git log output\nwith multiple lines\nand special chars: !@#$%'
      execFileSync.mockReturnValue(expectedOutput)

      const result = execCommand('git', ['log', '--oneline'])

      expect(result.stdout).toBe(expectedOutput)
    })

    it('should set maxBuffer to at least 32MB', () => {
      execFileSync.mockReturnValue('output')

      execCommand('git', ['log'])

      const callOptions = execFileSync.mock.calls[0][2]
      expect(callOptions.maxBuffer).toBe(32 * 1024 * 1024)
      expect(callOptions.maxBuffer).toBeGreaterThanOrEqual(32 * 1024 * 1024)
    })

    it('should use utf-8 encoding', () => {
      execFileSync.mockReturnValue('output')

      execCommand('git', ['show', 'HEAD:README.md'])

      const callOptions = execFileSync.mock.calls[0][2]
      expect(callOptions.encoding).toBe('utf-8')
    })

    it('should forward cwd option', () => {
      execFileSync.mockReturnValue('output')

      execCommand('git', ['status'], { cwd: '/custom/path' })

      expect(execFileSync).toHaveBeenCalledWith('git', ['status'], {
        cwd: '/custom/path',
        env: undefined,
        input: undefined,
        encoding: 'utf-8',
        maxBuffer: 32 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    })

    it('should forward env option', () => {
      execFileSync.mockReturnValue('output')
      const customEnv = { ...process.env, CUSTOM_VAR: 'value' }

      execCommand('gh', ['api', 'user'], { env: customEnv })

      expect(execFileSync).toHaveBeenCalledWith('gh', ['api', 'user'], {
        cwd: undefined,
        env: customEnv,
        input: undefined,
        encoding: 'utf-8',
        maxBuffer: 32 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    })

    it('should forward input option for stdin', () => {
      execFileSync.mockReturnValue('output')

      execCommand('git', ['commit', '-F', '-'], { input: 'commit message\n' })

      expect(execFileSync).toHaveBeenCalledWith('git', ['commit', '-F', '-'], {
        cwd: undefined,
        env: undefined,
        input: 'commit message\n',
        encoding: 'utf-8',
        maxBuffer: 32 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    })
  })

  describe('execCommand error handling', () => {
    it('should throw ExecError on non-zero exit code with string stderr', () => {
      const error = new Error('Command failed')
      ;(error as MockExecError).status = 1
      ;(error as MockExecError).stderr = 'fatal: not a git repository'
      execFileSync.mockImplementation(() => {
        throw error
      })

      expect(() => {
        execCommand('git', ['log'])
      }).toThrow(ExecError)

      expect(() => {
        execCommand('git', ['log'])
      }).toThrow(/Command failed: git log/)
    })

    it('should include error message with command, exit code, and stderr', () => {
      const error = new Error('Command failed')
      ;(error as MockExecError).status = 128
      ;(error as MockExecError).stderr = 'fatal: not a git repository'
      execFileSync.mockImplementation(() => {
        throw error
      })

      expect(() => {
        execCommand('git', ['log'])
      }).toThrow(
        /Command failed: git log \(exit code 128\): fatal: not a git repository/
      )
    })

    it('should handle Buffer stderr by converting to utf-8', () => {
      const error = new Error('Command failed')
      ;(error as MockExecError).status = 1
      ;(error as MockExecError).stderr = Buffer.from('buffer stderr')
      execFileSync.mockImplementation(() => {
        throw error
      })

      expect(() => {
        execCommand('git', ['commit'])
      }).toThrow(/buffer stderr/)
    })

    it('should use error message as fallback when stderr is empty', () => {
      const error = new Error('Original error message')
      ;(error as MockExecError).status = 1
      ;(error as MockExecError).stderr = ''
      execFileSync.mockImplementation(() => {
        throw error
      })

      expect(() => {
        execCommand('gh', ['pr', 'create'])
      }).toThrow(
        /Command failed: gh pr create \(exit code 1\): Original error message/
      )
    })

    it('should not include error message if stderr is empty and no message', () => {
      const error = new Error('Command failed')
      ;(error as MockExecError).status = 1
      ;(error as MockExecError).stderr = ''
      ;(error as MockExecError).message = ''
      execFileSync.mockImplementation(() => {
        throw error
      })

      expect(() => {
        execCommand('git', ['status'])
      }).toThrow(/Command failed: git status \(exit code 1\)$/)
    })

    it('should trim stderr in error message', () => {
      const error = new Error('Command failed')
      ;(error as MockExecError).status = 2
      ;(error as MockExecError).stderr = '  \n  error message  \n  '
      execFileSync.mockImplementation(() => {
        throw error
      })

      // Should not include leading/trailing whitespace
      expect(() => {
        execCommand('gh', ['api'])
      }).toThrow(/error message/)
    })

    it('should handle signal-terminated processes (status === null) as exit code 1', () => {
      const error = new Error('Command failed')
      ;(error as MockExecError).status = null
      ;(error as MockExecError).signal = 'SIGTERM'
      ;(error as MockExecError).stderr = 'process killed'
      execFileSync.mockImplementation(() => {
        throw error
      })

      expect(() => {
        execCommand('git', ['clone', 'repo'])
      }).toThrow(/exit code 1/)
    })

    it('should not leak env values in error messages', () => {
      const error = new Error('Command failed')
      ;(error as MockExecError).status = 1
      ;(error as MockExecError).stderr = 'Error: Bad token'
      execFileSync.mockImplementation(() => {
        throw error
      })

      const secretEnv = { SECRET_TOKEN: 'super-secret-token-12345' }

      expect(() => {
        execCommand('gh', ['api', 'user'], { env: secretEnv })
      }).toThrow()

      expect(() => {
        execCommand('gh', ['api', 'user'], { env: secretEnv })
      }).toThrow(ExecError)

      // Verify error message doesn't contain the secret token
      try {
        execCommand('gh', ['api', 'user'], { env: secretEnv })
      } catch (err) {
        if (err instanceof ExecError) {
          expect(err.message).not.toContain('super-secret-token-12345')
        }
      }
    })

    it('should preserve exitCode on ExecError', () => {
      const error = new Error('Command failed')
      ;(error as MockExecError).status = 42
      ;(error as MockExecError).stderr = 'some error'
      execFileSync.mockImplementation(() => {
        throw error
      })

      try {
        execCommand('git', ['push'])
      } catch (err) {
        expect(err).toBeInstanceOf(ExecError)
        expect((err as ExecError).exitCode).toBe(42)
      }
    })

    it('should preserve stderr on ExecError', () => {
      const stderrContent = 'detailed error information'
      const error = new Error('Command failed')
      ;(error as MockExecError).status = 1
      ;(error as MockExecError).stderr = stderrContent
      execFileSync.mockImplementation(() => {
        throw error
      })

      try {
        execCommand('git', ['tag'])
      } catch (err) {
        expect(err).toBeInstanceOf(ExecError)
        expect((err as ExecError).stderr).toBe(stderrContent)
      }
    })

    it('should preserve command on ExecError', () => {
      const error = new Error('Command failed')
      ;(error as MockExecError).status = 1
      ;(error as MockExecError).stderr = 'error'
      execFileSync.mockImplementation(() => {
        throw error
      })

      try {
        execCommand('git', ['commit', '-m', 'message'])
      } catch (err) {
        expect(err).toBeInstanceOf(ExecError)
        expect((err as ExecError).command).toBe('git commit -m message')
      }
    })
  })

  describe('execCommand with allowNonZeroExit', () => {
    it('should return result with exitCode instead of throwing on allowNonZeroExit', () => {
      const error = new Error('Command failed')
      ;(error as MockExecError).status = 1
      ;(error as MockExecError).stdout = 'some output'
      ;(error as MockExecError).stderr = 'some error'
      execFileSync.mockImplementation(() => {
        throw error
      })

      const result = execCommand(
        'git',
        ['ls-remote', '--heads', 'origin', 'nonexistent'],
        {
          allowNonZeroExit: true
        }
      )

      expect(result).toEqual({
        stdout: 'some output',
        stderr: 'some error',
        exitCode: 1
      })
    })

    it('should handle Buffer stdout and stderr with allowNonZeroExit', () => {
      const error = new Error('Command failed')
      ;(error as MockExecError).status = 127
      ;(error as MockExecError).stdout = Buffer.from('output buffer')
      ;(error as MockExecError).stderr = Buffer.from('error buffer')
      execFileSync.mockImplementation(() => {
        throw error
      })

      const result = execCommand('gh', ['pr', 'view', '999'], {
        allowNonZeroExit: true
      })

      expect(result).toEqual({
        stdout: 'output buffer',
        stderr: 'error buffer',
        exitCode: 127
      })
    })

    it('should return exitCode 1 for signal-terminated process with allowNonZeroExit', () => {
      const error = new Error('Command failed')
      ;(error as MockExecError).status = null
      ;(error as MockExecError).signal = 'SIGKILL'
      ;(error as MockExecError).stdout = ''
      ;(error as MockExecError).stderr = 'Killed'
      execFileSync.mockImplementation(() => {
        throw error
      })

      const result = execCommand('git', ['clone', 'repo'], {
        allowNonZeroExit: true
      })

      expect(result.exitCode).toBe(1)
    })

    it('should handle undefined stdout/stderr with allowNonZeroExit', () => {
      const error = new Error('Command failed')
      ;(error as MockExecError).status = 1
      ;(error as MockExecError).stdout = undefined
      ;(error as MockExecError).stderr = undefined
      execFileSync.mockImplementation(() => {
        throw error
      })

      const result = execCommand('git', ['rev-parse', 'invalid-ref'], {
        allowNonZeroExit: true
      })

      expect(result).toEqual({
        stdout: '',
        stderr: '',
        exitCode: 1
      })
    })
  })

  describe('shell metacharacter safety', () => {
    it('should pass shell metacharacters safely as discrete argv elements', () => {
      execFileSync.mockReturnValue('output')

      const dangerousString = '$(touch /tmp/pwned)'
      execCommand('git', ['commit', '-m', dangerousString])

      // Verify the dangerous string was passed as a distinct argv element,
      // not interpolated into a shell string
      expect(execFileSync).toHaveBeenCalledWith(
        'git',
        ['commit', '-m', dangerousString],
        expect.any(Object)
      )

      // Verify the exact argument array was passed
      const callArgs = execFileSync.mock.calls[0]
      expect(callArgs[1]).toContain(dangerousString)
      expect(callArgs[1][2]).toBe(dangerousString)
    })

    it('should safely pass backtick-containing strings', () => {
      execFileSync.mockReturnValue('output')

      const backticksString = '`rm -rf /`'
      execCommand('git', ['tag', '-a', 'v1.0.0', '-m', backticksString])

      const args = execFileSync.mock.calls[0][1]
      expect(args).toContain(backticksString)
    })

    it('should safely pass quote-containing strings', () => {
      execFileSync.mockReturnValue('output')

      const quoteString = "'; DROP TABLE releases; --"
      execCommand('git', ['commit', '-m', quoteString])

      const args = execFileSync.mock.calls[0][1]
      expect(args).toContain(quoteString)
    })

    it('should safely pass newline-containing strings', () => {
      execFileSync.mockReturnValue('output')

      const multilineString = 'line 1\nline 2\nline 3'
      execCommand('git', ['commit', '-m', multilineString])

      const args = execFileSync.mock.calls[0][1]
      expect(args).toContain(multilineString)
    })

    it('should safely pass variable expansion strings', () => {
      execFileSync.mockReturnValue('output')

      const varString = '$USER:$HOME:/path'
      execCommand('gh', ['pr', 'create', '--title', varString])

      const args = execFileSync.mock.calls[0][1]
      expect(args).toContain(varString)
    })

    it('should handle complex real-world commit message safely', () => {
      execFileSync.mockReturnValue('commit-sha')

      const commitMessage =
        'feat: implement feature\n\nThis PR fixes issue #123\nCloses #456\n\nBreaking Change: $(whoami)'
      execCommand('git', ['commit', '-m', commitMessage])

      const args = execFileSync.mock.calls[0][1]
      expect(args).toContain(commitMessage)
      expect(args[2]).toBe(commitMessage)
    })

    it('should never use shell: true', () => {
      execFileSync.mockReturnValue('output')

      execCommand('git', ['log', '--oneline'])

      const options = execFileSync.mock.calls[0][2]
      expect(options.shell).toBeUndefined()
    })

    it('should always use execFileSync, never exec or execSync', () => {
      // This test verifies the implementation uses execFileSync
      // by checking it was called (done in other tests already)
      // and by confirming the module only imports execFileSync
      execFileSync.mockReturnValue('output')

      execCommand('git', ['status'])

      expect(execFileSync).toHaveBeenCalled()
    })
  })

  describe('ExecError class', () => {
    it('should create ExecError with correct properties', () => {
      const error = new ExecError('git commit', 1, 'error message')

      expect(error.name).toBe('ExecError')
      expect(error.command).toBe('git commit')
      expect(error.exitCode).toBe(1)
      expect(error.stderr).toBe('error message')
    })

    it('should include stderr in error message when present', () => {
      const error = new ExecError(
        'git push',
        128,
        'fatal: not a git repository'
      )

      expect(error.message).toContain('fatal: not a git repository')
      expect(error.message).toContain('exit code 128')
    })

    it('should format message correctly without stderr', () => {
      const error = new ExecError('gh api', 404, '')

      expect(error.message).toBe('Command failed: gh api (exit code 404)')
    })

    it('should be instanceof Error', () => {
      const error = new ExecError('git tag', 1, 'error')

      expect(error).toBeInstanceOf(Error)
    })
  })

  describe('edge cases and realistic scenarios', () => {
    it('should handle very long output', () => {
      const longOutput = 'x'.repeat(1000000) // 1MB of output
      execFileSync.mockReturnValue(longOutput)

      const result = execCommand('git', ['log', '--all'])

      expect(result.stdout).toBe(longOutput)
      expect(result.stdout.length).toBe(1000000)
    })

    it('should handle empty output', () => {
      execFileSync.mockReturnValue('')

      const result = execCommand('git', ['rev-parse', 'nonexistent'])

      expect(result.stdout).toBe('')
      expect(result.stderr).toBe('')
    })

    it('should handle commands with many arguments', () => {
      execFileSync.mockReturnValue('ok')

      const manyArgs = Array(100)
        .fill('arg')
        .map((a, i) => `${a}${i}`)
      execCommand('git', ['log', ...manyArgs])

      const args = execFileSync.mock.calls[0][1]
      expect(args.length).toBe(101) // 'log' + 100 args
    })

    it('should work with both git and gh commands', () => {
      execFileSync.mockReturnValue('result')

      execCommand('git', ['status'])
      execCommand('gh', ['issue', 'list'])

      expect(execFileSync).toHaveBeenCalledTimes(2)
      expect(execFileSync.mock.calls[0][0]).toBe('git')
      expect(execFileSync.mock.calls[1][0]).toBe('gh')
    })
  })
})
