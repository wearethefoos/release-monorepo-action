import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import { getActionContext } from './context'
import type { Mock } from 'vitest'

// Mock fs module
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn()
}))

describe('getActionContext', () => {
  const originalEnv = process.env

  beforeEach(() => {
    // Save original environment and create a copy for testing
    process.env = { ...originalEnv }
    vi.clearAllMocks()
  })

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv
  })

  describe('pull request event', () => {
    it('should parse pull_request payload correctly', () => {
      const eventPayload = {
        pull_request: {
          number: 42,
          base: { ref: 'main' },
          head: { ref: 'feature/new-thing' }
        }
      }

      process.env.GITHUB_REPOSITORY = 'owner/repo'
      process.env.GITHUB_SHA = 'abc123'
      process.env.GITHUB_REF = 'refs/pull/42/merge'
      process.env.GITHUB_EVENT_PATH = '/tmp/event.json'
      ;(fs.existsSync as Mock).mockReturnValue(true)
      ;(fs.readFileSync as Mock).mockReturnValue(JSON.stringify(eventPayload))

      const context = getActionContext()

      expect(context.isPullRequest).toBe(true)
      expect(context.pullRequestNumber).toBe(42)
      expect(context.baseRef).toBe('main')
      expect(context.headRef).toBe('feature/new-thing')
      expect(context.owner).toBe('owner')
      expect(context.repo).toBe('repo')
      expect(context.sha).toBe('abc123')
      expect(context.isPreRelease).toBe(false)
      expect(context.shouldRelease).toBe(false)
    })

    it('should handle pull_request with missing base/head refs', () => {
      const eventPayload = {
        pull_request: {
          number: 99
          // base and head missing
        }
      }

      process.env.GITHUB_REPOSITORY = 'myowner/myrepo'
      process.env.GITHUB_SHA = 'def456'
      process.env.GITHUB_REF = 'refs/pull/99/merge'
      process.env.GITHUB_EVENT_PATH = '/tmp/event.json'
      ;(fs.existsSync as Mock).mockReturnValue(true)
      ;(fs.readFileSync as Mock).mockReturnValue(JSON.stringify(eventPayload))

      const context = getActionContext()

      expect(context.isPullRequest).toBe(true)
      expect(context.pullRequestNumber).toBe(99)
      expect(context.baseRef).toBe('')
      expect(context.headRef).toBe('')
    })
  })

  describe('push event', () => {
    it('should parse push event (refs from GITHUB_REF)', () => {
      const eventPayload = {}

      process.env.GITHUB_REPOSITORY = 'owner/repo'
      process.env.GITHUB_SHA = 'xyz789'
      process.env.GITHUB_REF = 'refs/heads/main'
      process.env.GITHUB_EVENT_PATH = '/tmp/event.json'
      ;(fs.existsSync as Mock).mockReturnValue(true)
      ;(fs.readFileSync as Mock).mockReturnValue(JSON.stringify(eventPayload))

      const context = getActionContext()

      expect(context.isPullRequest).toBe(false)
      expect(context.pullRequestNumber).toBeUndefined()
      expect(context.baseRef).toBe('refs/heads/main')
      expect(context.headRef).toBe('refs/heads/main')
      expect(context.owner).toBe('owner')
      expect(context.repo).toBe('repo')
      expect(context.sha).toBe('xyz789')
    })

    it('should handle push to non-main branch', () => {
      const eventPayload = {}

      process.env.GITHUB_REPOSITORY = 'owner/repo'
      process.env.GITHUB_SHA = 'zzz999'
      process.env.GITHUB_REF = 'refs/heads/release/v1.0'
      process.env.GITHUB_EVENT_PATH = '/tmp/event.json'
      ;(fs.existsSync as Mock).mockReturnValue(true)
      ;(fs.readFileSync as Mock).mockReturnValue(JSON.stringify(eventPayload))

      const context = getActionContext()

      expect(context.isPullRequest).toBe(false)
      expect(context.baseRef).toBe('refs/heads/release/v1.0')
      expect(context.headRef).toBe('refs/heads/release/v1.0')
    })
  })

  describe('repository parsing', () => {
    it('should split GITHUB_REPOSITORY correctly', () => {
      const eventPayload = {}

      process.env.GITHUB_REPOSITORY = 'myorg/myproject'
      process.env.GITHUB_SHA = 'sha123'
      process.env.GITHUB_REF = 'refs/heads/main'
      process.env.GITHUB_EVENT_PATH = '/tmp/event.json'
      ;(fs.existsSync as Mock).mockReturnValue(true)
      ;(fs.readFileSync as Mock).mockReturnValue(JSON.stringify(eventPayload))

      const context = getActionContext()

      expect(context.owner).toBe('myorg')
      expect(context.repo).toBe('myproject')
    })

    it('should handle GITHUB_REPOSITORY without slash', () => {
      const eventPayload = {}

      process.env.GITHUB_REPOSITORY = 'invalid'
      process.env.GITHUB_SHA = 'sha123'
      process.env.GITHUB_REF = 'refs/heads/main'
      process.env.GITHUB_EVENT_PATH = '/tmp/event.json'
      ;(fs.existsSync as Mock).mockReturnValue(true)
      ;(fs.readFileSync as Mock).mockReturnValue(JSON.stringify(eventPayload))

      const context = getActionContext()

      expect(context.owner).toBe('')
      expect(context.repo).toBe('')
    })

    it('should handle missing GITHUB_REPOSITORY', () => {
      const eventPayload = {}

      delete process.env.GITHUB_REPOSITORY
      process.env.GITHUB_SHA = 'sha123'
      process.env.GITHUB_REF = 'refs/heads/main'
      process.env.GITHUB_EVENT_PATH = '/tmp/event.json'
      ;(fs.existsSync as Mock).mockReturnValue(true)
      ;(fs.readFileSync as Mock).mockReturnValue(JSON.stringify(eventPayload))

      const context = getActionContext()

      expect(context.owner).toBe('')
      expect(context.repo).toBe('')
    })
  })

  describe('missing/unreadable event file', () => {
    it('should handle missing GITHUB_EVENT_PATH', () => {
      delete process.env.GITHUB_EVENT_PATH
      process.env.GITHUB_REPOSITORY = 'owner/repo'
      process.env.GITHUB_SHA = 'sha123'
      process.env.GITHUB_REF = 'refs/heads/main'

      const context = getActionContext()

      expect(context.isPullRequest).toBe(false)
      expect(context.pullRequestNumber).toBeUndefined()
      expect(context.baseRef).toBe('refs/heads/main')
      expect(context.headRef).toBe('refs/heads/main')
    })

    it('should handle GITHUB_EVENT_PATH that does not exist', () => {
      process.env.GITHUB_REPOSITORY = 'owner/repo'
      process.env.GITHUB_SHA = 'sha123'
      process.env.GITHUB_REF = 'refs/heads/main'
      process.env.GITHUB_EVENT_PATH = '/nonexistent/event.json'
      ;(fs.existsSync as Mock).mockReturnValue(false)

      const context = getActionContext()

      expect(context.isPullRequest).toBe(false)
      expect(context.baseRef).toBe('refs/heads/main')
      expect(context.headRef).toBe('refs/heads/main')
    })

    it('should handle readFileSync throwing an error', () => {
      process.env.GITHUB_REPOSITORY = 'owner/repo'
      process.env.GITHUB_SHA = 'sha123'
      process.env.GITHUB_REF = 'refs/heads/main'
      process.env.GITHUB_EVENT_PATH = '/tmp/event.json'
      ;(fs.existsSync as Mock).mockReturnValue(true)
      ;(fs.readFileSync as Mock).mockImplementation(() => {
        throw new Error('Permission denied')
      })

      const context = getActionContext()

      expect(context.isPullRequest).toBe(false)
      expect(context.baseRef).toBe('refs/heads/main')
    })

    it('should handle invalid JSON in event file', () => {
      process.env.GITHUB_REPOSITORY = 'owner/repo'
      process.env.GITHUB_SHA = 'sha123'
      process.env.GITHUB_REF = 'refs/heads/main'
      process.env.GITHUB_EVENT_PATH = '/tmp/event.json'
      ;(fs.existsSync as Mock).mockReturnValue(true)
      ;(fs.readFileSync as Mock).mockReturnValue('{ invalid json }')

      const context = getActionContext()

      expect(context.isPullRequest).toBe(false)
      expect(context.baseRef).toBe('refs/heads/main')
    })
  })

  describe('missing environment variables', () => {
    it('should handle missing GITHUB_SHA', () => {
      const eventPayload = {}

      process.env.GITHUB_REPOSITORY = 'owner/repo'
      delete process.env.GITHUB_SHA
      process.env.GITHUB_REF = 'refs/heads/main'
      process.env.GITHUB_EVENT_PATH = '/tmp/event.json'
      ;(fs.existsSync as Mock).mockReturnValue(true)
      ;(fs.readFileSync as Mock).mockReturnValue(JSON.stringify(eventPayload))

      const context = getActionContext()

      expect(context.sha).toBe('')
    })

    it('should handle missing GITHUB_REF', () => {
      const eventPayload = {}

      process.env.GITHUB_REPOSITORY = 'owner/repo'
      process.env.GITHUB_SHA = 'sha123'
      delete process.env.GITHUB_REF
      process.env.GITHUB_EVENT_PATH = '/tmp/event.json'
      ;(fs.existsSync as Mock).mockReturnValue(true)
      ;(fs.readFileSync as Mock).mockReturnValue(JSON.stringify(eventPayload))

      const context = getActionContext()

      expect(context.baseRef).toBe('')
      expect(context.headRef).toBe('')
    })

    it('should handle all missing environment variables', () => {
      delete process.env.GITHUB_REPOSITORY
      delete process.env.GITHUB_SHA
      delete process.env.GITHUB_REF
      delete process.env.GITHUB_EVENT_PATH

      const context = getActionContext()

      expect(context.owner).toBe('')
      expect(context.repo).toBe('')
      expect(context.sha).toBe('')
      expect(context.baseRef).toBe('')
      expect(context.headRef).toBe('')
      expect(context.isPullRequest).toBe(false)
      expect(context.pullRequestNumber).toBeUndefined()
    })
  })

  describe('default values', () => {
    it('should always set isPreRelease to false', () => {
      const eventPayload = {}

      process.env.GITHUB_REPOSITORY = 'owner/repo'
      process.env.GITHUB_SHA = 'sha123'
      process.env.GITHUB_REF = 'refs/heads/main'
      process.env.GITHUB_EVENT_PATH = '/tmp/event.json'
      ;(fs.existsSync as Mock).mockReturnValue(true)
      ;(fs.readFileSync as Mock).mockReturnValue(JSON.stringify(eventPayload))

      const context = getActionContext()

      expect(context.isPreRelease).toBe(false)
    })

    it('should always set shouldRelease to false', () => {
      const eventPayload = {}

      process.env.GITHUB_REPOSITORY = 'owner/repo'
      process.env.GITHUB_SHA = 'sha123'
      process.env.GITHUB_REF = 'refs/heads/main'
      process.env.GITHUB_EVENT_PATH = '/tmp/event.json'
      ;(fs.existsSync as Mock).mockReturnValue(true)
      ;(fs.readFileSync as Mock).mockReturnValue(JSON.stringify(eventPayload))

      const context = getActionContext()

      expect(context.shouldRelease).toBe(false)
    })
  })

  describe('complex payloads', () => {
    it('should ignore extraneous payload fields', () => {
      const eventPayload = {
        pull_request: {
          number: 50,
          base: { ref: 'main' },
          head: { ref: 'feature' }
        },
        action: 'opened',
        repository: { name: 'ignored' },
        sender: { login: 'ignored' }
      }

      process.env.GITHUB_REPOSITORY = 'owner/repo'
      process.env.GITHUB_SHA = 'sha123'
      process.env.GITHUB_REF = 'refs/pull/50/merge'
      process.env.GITHUB_EVENT_PATH = '/tmp/event.json'
      ;(fs.existsSync as Mock).mockReturnValue(true)
      ;(fs.readFileSync as Mock).mockReturnValue(JSON.stringify(eventPayload))

      const context = getActionContext()

      expect(context.isPullRequest).toBe(true)
      expect(context.pullRequestNumber).toBe(50)
      expect(context.baseRef).toBe('main')
      expect(context.headRef).toBe('feature')
    })

    it('should handle UTF-8 characters in refs and SHA', () => {
      const eventPayload = {
        pull_request: {
          number: 1,
          base: { ref: 'main' },
          head: { ref: 'feature/中文' }
        }
      }

      process.env.GITHUB_REPOSITORY = 'org-ñame/repo'
      process.env.GITHUB_SHA = 'abc123def456'
      process.env.GITHUB_REF = 'refs/pull/1/merge'
      process.env.GITHUB_EVENT_PATH = '/tmp/event.json'
      ;(fs.existsSync as Mock).mockReturnValue(true)
      ;(fs.readFileSync as Mock).mockReturnValue(JSON.stringify(eventPayload))

      const context = getActionContext()

      expect(context.owner).toBe('org-ñame')
      expect(context.repo).toBe('repo')
      expect(context.headRef).toBe('feature/中文')
    })
  })

  describe('edge cases', () => {
    it('should handle GITHUB_REPOSITORY with multiple slashes', () => {
      const eventPayload = {}

      process.env.GITHUB_REPOSITORY = 'owner/repo/extra'
      process.env.GITHUB_SHA = 'sha123'
      process.env.GITHUB_REF = 'refs/heads/main'
      process.env.GITHUB_EVENT_PATH = '/tmp/event.json'
      ;(fs.existsSync as Mock).mockReturnValue(true)
      ;(fs.readFileSync as Mock).mockReturnValue(JSON.stringify(eventPayload))

      const context = getActionContext()

      // destructuring assignment [owner, repo] only captures first two elements
      expect(context.owner).toBe('owner')
      expect(context.repo).toBe('repo')
    })

    it('should handle empty pull_request object', () => {
      const eventPayload = {
        pull_request: {}
      }

      process.env.GITHUB_REPOSITORY = 'owner/repo'
      process.env.GITHUB_SHA = 'sha123'
      process.env.GITHUB_REF = 'refs/pull/1/merge'
      process.env.GITHUB_EVENT_PATH = '/tmp/event.json'
      ;(fs.existsSync as Mock).mockReturnValue(true)
      ;(fs.readFileSync as Mock).mockReturnValue(JSON.stringify(eventPayload))

      const context = getActionContext()

      expect(context.isPullRequest).toBe(true)
      expect(context.pullRequestNumber).toBeUndefined()
      expect(context.baseRef).toBe('')
      expect(context.headRef).toBe('')
    })

    it('should handle pull_request.number as 0', () => {
      const eventPayload = {
        pull_request: {
          number: 0,
          base: { ref: 'main' },
          head: { ref: 'feature' }
        }
      }

      process.env.GITHUB_REPOSITORY = 'owner/repo'
      process.env.GITHUB_SHA = 'sha123'
      process.env.GITHUB_REF = 'refs/pull/0/merge'
      process.env.GITHUB_EVENT_PATH = '/tmp/event.json'
      ;(fs.existsSync as Mock).mockReturnValue(true)
      ;(fs.readFileSync as Mock).mockReturnValue(JSON.stringify(eventPayload))

      const context = getActionContext()

      expect(context.isPullRequest).toBe(true)
      expect(context.pullRequestNumber).toBe(0)
    })
  })
})
