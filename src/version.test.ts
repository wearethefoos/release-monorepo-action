import { describe, it, expect } from 'vitest'
import {
  parseConventionalCommit,
  determineVersionBump,
  calculateNewVersion,
  generateChangelog
} from './version'

describe('version.ts', () => {
  describe('parseConventionalCommit', () => {
    it('parses a feat commit', () => {
      const commit = parseConventionalCommit('feat(core): add new feature')
      expect(commit.type).toBe('feat')
      expect(commit.scope).toBe('core')
      expect(commit.breaking).toBe(false)
      expect(commit.message).toBe('add new feature')
    })

    it('parses a breaking change', () => {
      const commit = parseConventionalCommit('fix!: breaking fix')
      expect(commit.type).toBe('fix')
      expect(commit.breaking).toBe(true)
      expect(commit.message).toBe('breaking fix')
    })

    it('returns chore for non-conventional commit', () => {
      const commit = parseConventionalCommit('random commit message')
      expect(commit.type).toBe('chore')
      expect(commit.breaking).toBe(false)
      expect(commit.message).toBe('random commit message')
    })

    it('parses squashed commits correctly', () => {
      const message = `
feat!: support multiple release targets (#16)

* feat!: support multiple release targets

* chore: fix lint setup

* chore: fix commitlint setup

* fix: do not create prerelease PRs

* fix: do not break on PR write permissions

* fix: process all prerelease packages

* fix: monorepo prereleases

* fix: create github prereleases
`
      const commit = parseConventionalCommit(message)
      expect(commit.type).toBe('feat')
      expect(commit.breaking).toBe(true)
      expect(commit.message).toBe('support multiple release targets (#16)')
    })
  })

  describe('determineVersionBump', () => {
    it('returns major for breaking', () => {
      const bump = determineVersionBump([
        { type: 'fix', breaking: true, message: '', hash: '' }
      ])
      expect(bump).toBe('major')
    })
    it('returns minor for feat', () => {
      const bump = determineVersionBump([
        { type: 'feat', breaking: false, message: '', hash: '' }
      ])
      expect(bump).toBe('minor')
    })
    it('returns patch for fix', () => {
      const bump = determineVersionBump([
        { type: 'fix', breaking: false, message: '', hash: '' }
      ])
      expect(bump).toBe('patch')
    })
    it('returns none for docs', () => {
      const bump = determineVersionBump([
        { type: 'docs', breaking: false, message: '', hash: '' }
      ])
      expect(bump).toBe('none')
    })
  })

  describe('calculateNewVersion', () => {
    it('bumps major', () => {
      expect(calculateNewVersion('1.2.3', 'major', false)).toBe('2.0.0')
    })
    it('bumps minor', () => {
      expect(calculateNewVersion('1.2.3', 'minor', false)).toBe('1.3.0')
    })
    it('bumps patch', () => {
      expect(calculateNewVersion('1.2.3', 'patch', false)).toBe('1.2.4')
    })
    it('keeps version for none', () => {
      expect(calculateNewVersion('1.2.3', 'none', false)).toBe('1.2.3')
    })
    it('adds rc for prerelease', () => {
      expect(calculateNewVersion('1.2.3', 'patch', true, 2)).toBe('1.2.4-rc.2')
    })
  })

  describe('generateChangelog', () => {
    it('generates changelog for features and fixes', () => {
      const commits = [
        { type: 'feat', breaking: false, message: 'add login', hash: '' },
        { type: 'fix', breaking: false, message: 'fix bug', hash: '' }
      ]
      const changelog = generateChangelog(commits)
      expect(changelog).toMatch(/Features/)
      expect(changelog).toMatch(/Fixes/)
      expect(changelog).toMatch(/add login/)
      expect(changelog).toMatch(/fix bug/)
    })
    it('marks breaking changes', () => {
      const commits = [
        { type: 'feat', breaking: true, message: 'BREAKING!', hash: '' }
      ]
      const changelog = generateChangelog(commits)
      expect(changelog).toMatch(/BREAKING CHANGE/)
    })
  })
})
