import { PackageChanges } from './types.js';
export declare class GitHubService {
    private octokit;
    private releaseContext;
    constructor(token: string);
    private getReleaseContext;
    getCommitCount(ref?: string): Promise<number>;
    getPullRequestLabels(): Promise<string[]>;
    createReleasePullRequest(changes: PackageChanges[]): Promise<void>;
    private generatePullRequestBody;
    createRelease(changes: PackageChanges[]): Promise<void>;
    getCommitsSinceLastRelease(packagePath: string): Promise<string[]>;
    updatePackageVersion(packagePath: string, newVersion: string): Promise<void>;
}
