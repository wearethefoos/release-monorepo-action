Object.defineProperty(exports, "__esModule", { value: true });
exports.parseConventionalCommit = parseConventionalCommit;
exports.determineVersionBump = determineVersionBump;
exports.calculateNewVersion = calculateNewVersion;
exports.generateChangelog = generateChangelog;
const tslib_1 = require("tslib");
const semver_1 = tslib_1.__importDefault(require("semver"));
const CONVENTIONAL_COMMIT_TYPES = {
    feat: 'minor',
    fix: 'patch',
    docs: 'none',
    style: 'none',
    refactor: 'patch',
    perf: 'patch',
    test: 'none',
    chore: 'none',
    revert: 'patch',
    ci: 'none',
    build: 'none'
};
function parseConventionalCommit(message) {
    const conventionalCommitRegex = /^(?<type>feat|fix|docs|style|refactor|perf|test|chore|revert|ci|build)(?:\((?<scope>[^)]+)\))?(?<breaking>!)?: (?<message>.+)$/;
    const match = message.match(conventionalCommitRegex);
    if (!match) {
        return {
            type: 'chore',
            breaking: false,
            message,
            hash: ''
        };
    }
    const { type, scope, breaking, message: commitMessage } = match.groups || {};
    return {
        type: type || 'chore',
        scope,
        breaking: Boolean(breaking),
        message: commitMessage || message,
        hash: ''
    };
}
function determineVersionBump(commits) {
    let highestBump = 'none';
    for (const commit of commits) {
        if (commit.breaking) {
            return 'major';
        }
        const bump = CONVENTIONAL_COMMIT_TYPES[commit.type];
        // Update highestBump if the current bump is higher
        if (bump === 'major' ||
            (bump === 'minor' && highestBump !== 'major') ||
            (bump === 'patch' && highestBump === 'none')) {
            highestBump = bump;
        }
    }
    return highestBump;
}
function calculateNewVersion(currentVersion, bump, isPreRelease, prereleaseNumber) {
    const version = semver_1.default.parse(currentVersion);
    if (!version) {
        throw new Error(`Invalid version: ${currentVersion}`);
    }
    let newVersion = currentVersion;
    switch (bump) {
        case 'major':
            newVersion = `${version.major + 1}.0.0`;
            break;
        case 'minor':
            newVersion = `${version.major}.${version.minor + 1}.0`;
            break;
        case 'patch':
            newVersion = `${version.major}.${version.minor}.${version.patch + 1}`;
            break;
    }
    if (isPreRelease) {
        newVersion = `${newVersion}-rc.${prereleaseNumber || 1}`;
    }
    return newVersion;
}
function generateChangelog(commits) {
    const sections = {
        '🚀 Features': [],
        '🐛 Fixes': [],
        '📝 Documentation': [],
        '♻️ Refactors': [],
        '⚡️ Performance': [],
        '🧪 Tests': [],
        '🔧 Chores': [],
        '⏪ Reverts': [],
        '🔨 Build': [],
        '👷 CI': []
    };
    for (const commit of commits) {
        let section;
        switch (commit.type) {
            case 'feat':
                section = '🚀 Features';
                break;
            case 'fix':
                section = '🐛 Fixes';
                break;
            case 'docs':
                section = '📝 Documentation';
                break;
            case 'refactor':
                section = '♻️ Refactors';
                break;
            case 'perf':
                section = '⚡️ Performance';
                break;
            case 'test':
                section = '🧪 Tests';
                break;
            case 'chore':
                section = '🔧 Chores';
                break;
            case 'revert':
                section = '⏪ Reverts';
                break;
            case 'build':
                section = '🔨 Build';
                break;
            case 'ci':
                section = '👷 CI';
                break;
            default:
                section = '🔧 Chores';
        }
        const message = commit.breaking
            ? `**BREAKING CHANGE:** ${commit.message}`
            : commit.message;
        sections[section].push(`- ${message}`);
    }
    const changelog = Object.entries(sections)
        .filter(([, items]) => items.length > 0)
        .map(([title, items]) => `### ${title}\n\n${items.join('\n')}`)
        .join('\n\n');
    return changelog;
}
//# sourceMappingURL=version.js.map
