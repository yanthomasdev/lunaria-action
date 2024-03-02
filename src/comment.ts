import type { Octokit } from './types.js';

/**
 * We need to use a "pragma" so we can update the Action comment consistently.
 * Relying on the bot name alone wouldn't work if using a PAT or when multiple
 * actions comment on the same PR.
 */
const pragma = '<!-- lunaria-action-comment -->';

export const overviewTracked = `
🌕 **This pull request will trigger status changes.**

<details>
<summary>Learn more</summary>

By default, every PR changing files present in the [Lunaria configuration's \`files\` property](https://lunaria.dev/reference/configuration/#files-required) will be considered and trigger status changes accordingly.

You can change this by adding one of the keywords present in the [\`ignoreKeywords\` property in your Lunaria configuration file](https://lunaria.dev/reference/configuration/#ignorekeywords) in the PR's title (ignoring all files) or by [including a tracker directive](https://lunaria.dev/guides/tracking/#tracker-directives) in the merged commit's description. 
</details>`;

export const overviewUntracked = (match: string) => `
🌑 **This pull request will _not_ trigger status changes.**

<details>
<summary>Learn more</summary>

Lunaria automatically ignores changes on specific PRs by adding a ignored keyword in its title. Found: \`${match}\`.

You can change this by either removing the keyword above from the PR's title, or modifying the [\`ignoreKeywords\` property in your Lunaria configuration file](https://lunaria.dev/reference/configuration/#ignorekeywords).
</details>`;

export const trackedFilesDetails = (filesTable: string, warningsTable: string) => `
${filesTable}

<details>
<summary>Warnings reference</summary>

${warningsTable}

</details>`;

export const notes = {
	'source-added': 'Source added, will be tracked.',
	'source-removed': 'Source removed, will stop being tracked.',
	'source-changed': 'Source changed, localizations will be marked as outdated.',
	'source-unchanged': 'Source unchanged, will be ignored.',
	'localization-added': 'Localization added, will be marked as complete.',
	'localization-removed': 'Localization removed, will be marked as missing.',
	'localization-changed': 'Localization changed, will be marked as complete.',
	'localization-unchanged': 'Localization unchanged, will be ignored.',
};

export const warnings = {
	outdated: {
		icon: '🔄️',
		description:
			'The source for this localization has been updated since the creation of this pull request, make sure all changes in the source have been applied.',
	},
};

export const body = (overview: string, trackedFiles: string) => `
${pragma}

## Lunaria Status Overview

${overview}

### Tracked Files

${trackedFiles}`;

export async function commentSummary(
	octokit: Octokit,
	issue: { repo: string; owner: string; issue_number: number },
	body: string
) {
	const existingCommentId = await findExistingCommentId(octokit, issue);

	if (existingCommentId) {
		return octokit.rest.issues.updateComment({
			...issue,
			comment_id: existingCommentId,
			body: body,
		});
	}

	return octokit.rest.issues.createComment({
		...issue,
		body: body,
	});
}

export async function findExistingCommentId(
	octokit: Octokit,
	issue: { repo: string; owner: string; issue_number: number }
) {
	return (
		await octokit.paginate(
			octokit.rest.issues.listComments,
			{
				...issue,
				per_page: 100,
			},
			(response, done) => {
				// Stop paginating when the existing Lunaria bot comment is found.
				if (response.data.find((comment) => comment.body?.includes(pragma))) {
					done();
					return response.data;
				}
				return [];
			}
		)
	)
		.flat()
		.at(0)?.id;
}
