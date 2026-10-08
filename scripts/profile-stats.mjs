#!/usr/bin/env node
// Render profile stats cards as SVG from the GitHub GraphQL API.
//
// Runs in GitHub Actions with the built-in GITHUB_TOKEN. It reads public
// data only, so no personal token or third-party stats service is needed.
//
// Env:
//   GITHUB_TOKEN   token for api.github.com (the Actions token is enough)
//   STATS_USERS    comma-separated user logins whose public contributions are summed
//   STATS_ORGS     comma-separated org logins whose public repos count toward stars and languages
//   STATS_OUT      output directory (default: out)
//   STATS_FIXTURE  optional path to a JSON fixture; skips the network (for local previews)

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const API = 'https://api.github.com/graphql';
const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

const USERS = list(process.env.STATS_USERS || 'joshua-v-dev');
const ORGS = list(process.env.STATS_ORGS || '');
const OUT = process.env.STATS_OUT || 'out';
const TOKEN = process.env.GITHUB_TOKEN || '';
const TOP_LANGS = 6;

async function gql(query, variables) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(API, {
      method: 'POST',
      headers: {
        authorization: `bearer ${TOKEN}`,
        'content-type': 'application/json',
        'user-agent': 'profile-stats',
      },
      body: JSON.stringify({ query, variables }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && !body.errors) return body.data;
    const msg = body.errors ? JSON.stringify(body.errors) : `HTTP ${res.status}`;
    if (attempt === 3) throw new Error(`GraphQL failed: ${msg}`);
    await new Promise((r) => setTimeout(r, attempt * 2000));
  }
}

const USER_QUERY = `
query($login: String!) {
  user(login: $login) {
    login
    contributionsCollection {
      totalCommitContributions
      totalPullRequestContributions
      totalPullRequestReviewContributions
      totalIssueContributions
      totalRepositoriesWithContributedCommits
      contributionCalendar { totalContributions }
    }
  }
}`;

const REPOS_QUERY = `
query($login: String!, $cursor: String) {
  repositoryOwner(login: $login) {
    repositories(first: 100, after: $cursor, privacy: PUBLIC, isFork: false, ownerAffiliations: [OWNER]) {
      pageInfo { hasNextPage endCursor }
      nodes {
        nameWithOwner
        isArchived
        stargazerCount
        languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
          edges { size node { name color } }
        }
      }
    }
  }
}`;

async function fetchRepos(login) {
  const repos = [];
  let cursor = null;
  do {
    const data = await gql(REPOS_QUERY, { login, cursor });
    const conn = data.repositoryOwner?.repositories;
    if (!conn) break;
    repos.push(...conn.nodes);
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
  return repos;
}

async function collect() {
  if (process.env.STATS_FIXTURE) {
    return JSON.parse(await readFile(process.env.STATS_FIXTURE, 'utf8'));
  }
  if (!TOKEN) throw new Error('GITHUB_TOKEN is not set');
  const users = [];
  for (const login of USERS) {
    const data = await gql(USER_QUERY, { login });
    if (!data.user) throw new Error(`user not found: ${login}`);
    users.push(data.user);
  }
  const repos = [];
  const seen = new Set();
  for (const login of [...USERS, ...ORGS]) {
    for (const repo of await fetchRepos(login)) {
      if (seen.has(repo.nameWithOwner)) continue;
      seen.add(repo.nameWithOwner);
      repos.push(repo);
    }
  }
  return { users, repos };
}

function summarize({ users, repos }) {
  const sum = (f) => users.reduce((n, u) => n + (f(u.contributionsCollection) || 0), 0);
  const active = repos.filter((r) => !r.isArchived);
  const langs = new Map();
  for (const repo of active) {
    for (const edge of repo.languages?.edges || []) {
      const cur = langs.get(edge.node.name) || { size: 0, color: edge.node.color };
      cur.size += edge.size;
      langs.set(edge.node.name, cur);
    }
  }
  const total = [...langs.values()].reduce((n, l) => n + l.size, 0) || 1;
  const top = [...langs.entries()]
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, TOP_LANGS)
    .map(([name, l]) => ({ name, color: l.color || '#8b949e', pct: Math.round((l.size / total) * 10000) / 100 }));
  return {
    accounts: users.map((u) => u.login),
    orgs: ORGS,
    contributions: sum((c) => c.contributionCalendar.totalContributions),
    commits: sum((c) => c.totalCommitContributions),
    pullRequests: sum((c) => c.totalPullRequestContributions),
    reviews: sum((c) => c.totalPullRequestReviewContributions),
    issues: sum((c) => c.totalIssueContributions),
    repos: active.length,
    stars: active.reduce((n, r) => n + r.stargazerCount, 0),
    languages: top,
  };
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n) => Number(n).toLocaleString('en-US');

// Colors follow the viewer's light or dark GitHub theme.
const STYLE = `
<style>
  .bg { fill: #0d1117; stroke: #30363d; }
  .title { font: 600 16px 'Segoe UI', Ubuntu, 'Helvetica Neue', Arial, sans-serif; fill: #e6edf3; }
  .label { font: 400 13px 'Segoe UI', Ubuntu, 'Helvetica Neue', Arial, sans-serif; fill: #9198a1; }
  .value { font: 600 13px 'Segoe UI', Ubuntu, 'Helvetica Neue', Arial, sans-serif; fill: #e6edf3; }
  .foot { font: 400 11px 'Segoe UI', Ubuntu, 'Helvetica Neue', Arial, sans-serif; fill: #7d8590; }
  .accent { fill: #eeb300; }
  .track { fill: #21262d; }
  @media (prefers-color-scheme: light) {
    .bg { fill: #ffffff; stroke: #d1d9e0; }
    .title, .value { fill: #1f2328; }
    .label { fill: #59636e; }
    .foot { fill: #6e7781; }
    .accent { fill: #9a6700; }
    .track { fill: #eff2f5; }
  }
</style>`;

function card(width, height, title, body, foot, desc) {
  const lines = Array.isArray(foot) ? foot : [foot];
  const footer = lines
    .map((line, i) => `<text class="foot" x="24" y="${height - 16 - (lines.length - 1 - i) * 14}">${esc(line)}</text>`)
    .join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="t d">
<title id="t">${esc(title)}</title>
<desc id="d">${esc(desc)}</desc>${STYLE}
<rect class="bg" x="0.5" y="0.5" rx="6" width="${width - 1}" height="${height - 1}"/>
<rect class="accent" x="24" y="24" width="4" height="16" rx="1"/>
<text class="title" x="36" y="37">${esc(title)}</text>
${body}
${footer}
</svg>
`;
}

function renderOverview(s) {
  const rows = [
    ['Contributions, last 12 months', s.contributions],
    ['Commits, last 12 months', s.commits],
    ['Pull requests opened, last 12 months', s.pullRequests],
    ['Pull request reviews, last 12 months', s.reviews],
    ['Issues opened, last 12 months', s.issues],
    ['Public repositories', s.repos],
    ['Stars on public repositories', s.stars],
  ];
  const body = rows
    .map(([label, value], i) => {
      const y = 70 + i * 24;
      return `<text class="label" x="24" y="${y}">${esc(label)}</text><text class="value" x="436" y="${y}" text-anchor="end">${esc(fmt(value))}</text>`;
    })
    .join('\n');
  const who = s.accounts.map((a) => `@${a}`).join(' + ');
  const height = 70 + rows.length * 24 + 38;
  const desc = rows.map(([l, v]) => `${l}: ${fmt(v)}`).join('. ');
  const orgs = s.orgs.length ? `Repos and stars include ${s.orgs.map((o) => `@${o}`).join(' + ')}. ` : '';
  return card(460, height, 'GitHub activity', body, [`Public activity of ${who}.`, `${orgs}Refreshed daily.`], desc);
}

function renderLanguages(s) {
  const width = 460;
  const barW = width - 48;
  let x = 24;
  const bar = s.languages
    .map((l) => {
      const w = Math.max((l.pct / 100) * barW, 2);
      const seg = `<rect x="${x.toFixed(1)}" y="56" width="${w.toFixed(1)}" height="8" fill="${esc(l.color)}"/>`;
      x += w;
      return seg;
    })
    .join('');
  const items = s.languages
    .map((l, i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const cx = 24 + col * 212;
      const cy = 92 + row * 24;
      return `<circle cx="${cx + 5}" cy="${cy - 4}" r="5" fill="${esc(l.color)}"/><text class="label" x="${cx + 16}" y="${cy}">${esc(l.name)}</text><text class="value" x="${cx + 196}" y="${cy}" text-anchor="end">${l.pct.toFixed(1)}%</text>`;
    })
    .join('\n');
  const rows = Math.ceil(s.languages.length / 2);
  const height = 92 + rows * 24 + 34;
  const scope = [...s.accounts, ...s.orgs].map((a) => `@${a}`).join(' + ');
  const desc = s.languages.map((l) => `${l.name} ${l.pct.toFixed(1)}%`).join(', ');
  return card(
    width,
    height,
    'Top languages',
    `<rect class="track" x="24" y="56" width="${barW}" height="8" rx="4"/>${bar}\n${items}`,
    ['Share of code in public, active, non-fork repos of', `${scope}.`],
    desc,
  );
}

const data = await collect();
const stats = summarize(data);
// No timestamps in the output, so an unchanged day produces identical files
// and the workflow skips the commit.
await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, 'overview.svg'), renderOverview(stats));
await writeFile(join(OUT, 'languages.svg'), renderLanguages(stats));
await writeFile(join(OUT, 'stats.json'), JSON.stringify(stats, null, 2) + '\n');
console.log(JSON.stringify(stats, null, 2));
