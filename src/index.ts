import * as core from '@actions/core';
import * as github from '@actions/github';
import type { LocalizationStatus } from '@lunariajs/core';
import {
	LunariaConfigSchema,
	parseWithFriendlyErrors,
	type LunariaUserConfig,
} from '@lunariajs/core/config';
import { getPathResolver } from '@lunariajs/core/status';
import { execa } from 'execa';
import { markdownTable } from 'markdown-table';
import mm from 'micromatch';
import { dirname, join } from 'node:path';
import resolve from 'resolve-package-path';
import {
	body,
	commentSummary,
	notes,
	overviewTracked,
	overviewUntracked,
	trackedFilesDetails,
	warnings,
} from './comment.js';
import type { Files, PullRequest } from './types.js';

/**
 * Finds the corresponding Lunaria config's `file` object for a determined filename.
 */
function findFileConfig(filename: string, files: LunariaUserConfig['files']) {
	return files.find(
		(file) =>
			mm.isMatch(filename, file.location) &&
			['node_modules', ...(file.ignore || [])].every((ignored) => !mm.isMatch(filename, ignored))
	);
}

/**
 * Collapses a filename to only its non-base part.
 */
function collapseFilename(filename: string, dashboard: LunariaUserConfig['dashboard']) {
	const { basesToHide } = dashboard;

	if (!basesToHide) return filename;

	for (const base of basesToHide) {
		const newFilename = filename.replace(base, '');

		if (newFilename === filename) continue;
		return newFilename;
	}

	return filename;
}

/**
 * Removes the root directory of a given filename.
 * This is necessary since Lunaria's glob patterns are based on the cwd
 * and won't account for the root directory by default.
 */
function unrootFilename(root: string, filename: string) {
	if (root === '.') return filename;
	const rootDir = `${root}/`;

	if (filename.startsWith(rootDir)) return filename.replace(rootDir, '');
	return filename;
}

function getStatusOverview(title: string, ignoreKeywords: string[]) {
	const IGNORE_KEYWORDS = new RegExp(`(${ignoreKeywords.join('|')})`, 'i');
	const match = title.match(IGNORE_KEYWORDS)?.at(0);
	return match ? overviewUntracked(match) : overviewTracked;
}

async function getTrackedFilesTable(
	pullRequest: PullRequest,
	trackedFiles: Files,
	config: LunariaUserConfig,
	status: LocalizationStatus[]
) {
	const { defaultLocale, locales, files, repository, dashboard } = config;
	const rows: string[][] = [];

	for (const file of trackedFiles) {
		const rootlessFilename = unrootFilename(repository.rootDir, file.filename);
		const fileConfig = findFileConfig(rootlessFilename, files);
		const foundWarnings: Array<keyof typeof warnings> = [];

		const pathResolver = getPathResolver(fileConfig.pattern, defaultLocale, locales);
		const pathParams = pathResolver.isMatch(rootlessFilename).params;
		const sharedPath = pathResolver.toSharedPath(rootlessFilename);
		const collapsedSharedPath = collapseFilename(sharedPath, dashboard);

		// lang fallbacks to default locale's lang to account for root locale.
		const lang = pathParams.lang || defaultLocale.lang;
		const isSourceLocale = lang === defaultLocale.lang;

		const statusType = (status: Files[number]['status']) => {
			// It might be necessary to rethink these according to how Git
			// handles the different statuses.
			switch (status) {
				case 'renamed':
				case 'copied':
					return 'added';
				case 'modified':
					return 'changed';
				default:
					return status;
			}
		};

		const statusEntry = status.find((entry) => entry.sharedPath === sharedPath);

		const createdDate = new Date(pullRequest.created_at);
		// Don't go after the latest source change if the source file is part of the PR, assume creation date of PR.
		// If it wasn't possible to find the latest source change date, we assume it isn't possibly outdated.
		const latestSourceChange =
			statusEntry && !isSourceLocale
				? new Date(statusEntry?.sourceFile?.git.lastMajorChange)
				: createdDate;

		if (latestSourceChange > createdDate) foundWarnings.push('outdated');

		const warningIcons = foundWarnings.map((k) => warnings[k].icon).join(' ');
		const key = `${isSourceLocale ? 'source' : 'localization'}-${statusType(file.status)}` as const;
		const note = `${notes[key]} ${warningIcons}`;

		rows.push([lang, `[${collapsedSharedPath}](${file.blob_url})`, note]);
	}

	const filesTable = markdownTable([['Locale', 'File', 'Note'], ...rows]);
	const warningsTable = markdownTable([
		['Icon', 'Description'],
		...Object.values(warnings).map(({ icon, description }) => [icon, description]),
	]);

	return trackedFilesDetails(filesTable, warningsTable);
}

async function getLunariaContext() {
	const root = resolve('@lunariajs/core', process.cwd());

	if (!root) {
		core.setFailed(
			'Failed to find the `@lunariajs/core` package. Did you remember to install dependencies?'
		);
		process.exit(1);
	}

	const bin = join(dirname(root), 'dist/cli/index.mjs');
	const { stdout } = await execa(bin, ['stdout'], {
		encoding: 'utf8',
		detached: true,
		reject: false,
	});

	core.debug(stdout);

	const [userConfig, status] = JSON.parse(stdout) as [
		userConfig: undefined,
		status: LocalizationStatus[],
	];

	const config = parseWithFriendlyErrors(
		LunariaConfigSchema,
		userConfig,
		'Failed to parse your Lunaria config:\n'
	);

	return { config, status };
}

async function main() {
	const context = github.context;
	const payload = context.payload;

	if (!payload.pull_request) {
		core.notice('Skipped, could not find the pull request context.');
		return;
	}

	if (!payload.repository) {
		core.notice('Skipped, could not find pull request repository.');
		return;
	}

	if (payload.action !== 'opened' && payload.action !== 'synchronize') {
		core.notice('Skipped, Lunaria action only runs during pull request opening/synchronization.');
		return;
	}

	const githubToken = core.getInput('token', { required: true });
	const octokit = github.getOctokit(githubToken);

	const { config, status } = await getLunariaContext();

	const pullRequestContext = {
		...context.repo,
		pull_number: payload.pull_request.number,
		issue_number: payload.pull_request.number,
	};

	const { data: pullRequest } = await octokit.rest.pulls.get(pullRequestContext);

	const pullRequestFiles = await octokit.paginate(
		octokit.rest.pulls.listFiles,
		{
			...pullRequestContext,
			per_page: 100,
		},
		(response) => response.data
	);

	const trackedFiles = pullRequestFiles.filter((file) =>
		findFileConfig(unrootFilename(config.repository.rootDir, file.filename), config.files)
	);

	if (!trackedFiles.length) {
		core.notice("This pull request doesn't include any tracked files");
		return;
	}

	const overview = getStatusOverview(pullRequest.title, config.ignoreKeywords);
	const trackedFilesTable = await getTrackedFilesTable(pullRequest, trackedFiles, config, status);

	await commentSummary(octokit, pullRequestContext, body(overview, trackedFilesTable));
}

main().catch((e) => {
	core.setFailed(e.message);
});
