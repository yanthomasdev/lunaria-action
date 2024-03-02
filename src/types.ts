import type { getOctokit } from '@actions/github';

export type Octokit = ReturnType<typeof getOctokit>;
export type Files = Awaited<ReturnType<Octokit['rest']['pulls']['listFiles']>>['data'];
export type PullRequest = Awaited<ReturnType<Octokit['rest']['pulls']['get']>>['data'];
