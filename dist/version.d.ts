import { VersionBump, ConventionalCommit } from './types.js';
export declare function parseConventionalCommit(message: string): ConventionalCommit;
export declare function determineVersionBump(commits: ConventionalCommit[]): VersionBump;
export declare function calculateNewVersion(currentVersion: string, bump: VersionBump, isPreRelease: boolean, prereleaseNumber?: number): string;
export declare function generateChangelog(commits: ConventionalCommit[]): string;
