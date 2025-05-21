Object.defineProperty(exports, "__esModule", { value: true });
exports.run = run;
const tslib_1 = require("tslib");
const core = tslib_1.__importStar(require("@actions/core"));
const fs = tslib_1.__importStar(require("fs"));
const github_js_1 = require("./github.js");
const version_js_1 = require("./version.js");
const path_1 = tslib_1.__importDefault(require("path"));
/**
 * The main function for the action.
 *
 * @returns Resolves when the action is complete.
 */
async function run() {
    try {
        const token = core.getInput('token', { required: true });
        const rootDir = core.getInput('root-dir', { required: false });
        const manifestFile = core.getInput('manifest-file', { required: true });
        const createPreRelease = core.getInput('create-prerelease') === 'true';
        const prereleaseLabel = core.getInput('prerelease-label');
        const github = new github_js_1.GitHubService(token);
        const labels = await github.getPullRequestLabels();
        // Check if this is a release PR
        if (labels.includes('release-me')) {
            core.info('This is a release PR, skipping version calculation');
            return;
        }
        // Check if this is a prerelease PR
        const isPreRelease = labels.includes(prereleaseLabel);
        if (!createPreRelease && isPreRelease) {
            core.info('prereleases are disabled and this is a prerelease PR, skipping');
            return;
        }
        // Read and parse the manifest file
        const manifestContent = fs.readFileSync(path_1.default.join(rootDir, manifestFile), 'utf-8');
        const manifest = JSON.parse(manifestContent);
        const changes = [];
        // Process each package in the manifest
        for (const [packagePath, currentVersion] of Object.entries(manifest)) {
            // Get commits for this package
            const commitMessages = await github.getCommitsSinceLastRelease(path_1.default.join(rootDir, packagePath));
            if (commitMessages.length === 0) {
                continue;
            }
            // Parse conventional commits
            const commits = commitMessages.map((message) => ({
                ...(0, version_js_1.parseConventionalCommit)(message),
                hash: '' // We don't need the hash for version calculation
            }));
            // Determine version bump
            const bump = (0, version_js_1.determineVersionBump)(commits);
            if (bump === 'none') {
                continue;
            }
            // Calculate new version
            const newVersion = (0, version_js_1.calculateNewVersion)(currentVersion, bump, isPreRelease);
            // Generate changelog
            const changelog = (0, version_js_1.generateChangelog)(commits);
            changes.push({
                path: path_1.default.join(rootDir, packagePath),
                currentVersion,
                newVersion,
                commits,
                changelog
            });
        }
        if (changes.length === 0) {
            core.info('No changes requiring version updates found');
            return;
        }
        // Update package versions and create PR if needed
        for (const change of changes) {
            await github.updatePackageVersion(change.path, change.newVersion);
        }
        if (isPreRelease) {
            await github.createReleasePullRequest(changes);
        }
        else {
            await github.createRelease(changes);
        }
        // Set outputs
        core.setOutput('version', changes[0].newVersion);
        core.setOutput('prerelease', isPreRelease);
    }
    catch (error) {
        if (error instanceof Error) {
            core.setFailed(error.message);
        }
        else {
            core.setFailed('An unknown error occurred');
        }
    }
}
run();
//# sourceMappingURL=main.js.map
