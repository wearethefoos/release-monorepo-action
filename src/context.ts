import * as fs from 'fs'
import type { ReleaseContext } from './types.js'

interface GitHubEventPayload {
  pull_request?: {
    number: number
    base?: {
      ref: string
    }
    head?: {
      ref: string
    }
  }
  [key: string]: unknown
}

function readGitHubEventPayload(): GitHubEventPayload {
  const eventPath = process.env.GITHUB_EVENT_PATH

  if (!eventPath) {
    return {}
  }

  try {
    if (fs.existsSync(eventPath)) {
      const content = fs.readFileSync(eventPath, 'utf-8')
      return JSON.parse(content) as GitHubEventPayload
    }
  } catch {
    // If we can't read or parse the file, return empty payload
  }

  return {}
}

export function getActionContext(): ReleaseContext & { sha: string } {
  const repository = process.env.GITHUB_REPOSITORY ?? ''
  const [owner, repo] = repository.includes('/')
    ? repository.split('/')
    : ['', '']

  const sha = process.env.GITHUB_SHA ?? ''
  const ref = process.env.GITHUB_REF ?? ''
  const payload = readGitHubEventPayload()

  const isPullRequest = payload.pull_request !== undefined
  const pullRequestNumber = isPullRequest
    ? payload.pull_request?.number
    : undefined
  const baseRef = isPullRequest ? (payload.pull_request?.base?.ref ?? '') : ref
  const headRef = isPullRequest ? (payload.pull_request?.head?.ref ?? '') : ref

  return {
    isPullRequest,
    isPreRelease: false,
    shouldRelease: false,
    pullRequestNumber,
    baseRef,
    headRef,
    owner,
    repo,
    sha
  } as ReleaseContext & { sha: string }
}
