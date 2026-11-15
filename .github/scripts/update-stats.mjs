// Builds the "By the numbers" card for the profile README.
//
// Live mode (used by the workflow):
//   STATS_TOKEN=<classic PAT, scopes read:user + repo> node .github/scripts/update-stats.mjs
// Offline render from a JSON file (for previews):
//   node .github/scripts/update-stats.mjs --from-json stats.json
//
// Writes assets/stats-dark.svg, assets/stats-light.svg, assets/stats.json and
// rewrites the block between <!-- STATS:START --> and <!-- STATS:END --> in README.md.

import { readFile, writeFile, mkdir } from 'node:fs/promises';

const LOGIN = process.env.STATS_LOGIN || 'momagdy13';
const STATIC = {
  productionApps: 4,
  platforms: ['Android', 'iOS', 'Web'],
};

const nf = new Intl.NumberFormat('en-US');
const fmt = (n) => nf.format(n);

// ---------------------------------------------------------------- data ----

async function gql(token, query, variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'profile-stats-card',
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (!res.ok || body.errors) {
    throw new Error(`GraphQL error (${res.status}): ${JSON.stringify(body.errors || body)}`);
  }
  return body.data;
}

const YEAR_QUERY = `
query ($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      totalCommitContributions
      restrictedContributionsCount
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount } }
      }
    }
  }
}`;

async function fetchStats(token) {
  const { user } = await gql(token, 'query ($login: String!) { user(login: $login) { createdAt } }', { login: LOGIN });
  if (!user) throw new Error(`User ${LOGIN} not found`);

  const now = new Date();
  const firstYear = new Date(user.createdAt).getUTCFullYear();
  const years = [];
  const days = new Map(); // date -> count

  for (let y = firstYear; y <= now.getUTCFullYear(); y++) {
    const from = new Date(Date.UTC(y, 0, 1));
    const endOfYear = new Date(Date.UTC(y, 11, 31, 23, 59, 59));
    const to = endOfYear < now ? endOfYear : now;
    const data = await gql(token, YEAR_QUERY, { login: LOGIN, from: from.toISOString(), to: to.toISOString() });
    const c = data.user.contributionsCollection;
    for (const w of c.contributionCalendar.weeks) {
      for (const d of w.contributionDays) {
        if (d.date.startsWith(String(y))) days.set(d.date, (days.get(d.date) || 0) + d.contributionCount);
      }
    }
    years.push({
      year: y,
      commits: c.totalCommitContributions,
      contributions: c.contributionCalendar.totalContributions,
      restricted: c.restrictedContributionsCount,
    });
  }

  const restricted = years.reduce((s, y) => s + y.restricted, 0);
  if (restricted > 0) {
    console.warn(
      `::warning::${restricted} contributions are in repos this token cannot read, so commit totals undercount. ` +
        'Use a classic PAT with the "repo" scope, and authorize it for SSO if an org requires it.',
    );
  }

  return summarize(years, days, now);
}

function summarize(years, days, now) {
  const dates = [...days.keys()].sort();
  const active = dates.filter((d) => days.get(d) > 0);

  // Longest and current streak of consecutive active days.
  let longest = 0;
  let run = 0;
  let prev = null;
  for (const d of active) {
    const t = Date.parse(d);
    run = prev !== null && t - prev === 86400000 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = t;
  }

  // Contributions per month for the last 12 months.
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const m = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = m.toISOString().slice(0, 7);
    let total = 0;
    for (const [d, n] of days) if (d.startsWith(key)) total += n;
    months.push({ key, label: m.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }), total });
  }

  return {
    login: LOGIN,
    updated: now.toISOString(),
    since: years[0]?.year,
    commits: years.reduce((s, y) => s + y.commits, 0),
    contributions: years.reduce((s, y) => s + y.contributions, 0),
    activeDays: active.length,
    longestStreak: longest,
    years: years.map(({ year, commits, contributions }) => ({ year, commits, contributions })),
    months,
  };
}

// ----------------------------------------------------------------- svg ----

const THEMES = {
  dark: {
    bg: '#0D1117',
    border: '#30363D',
    tile: '#161B22',
    text: '#E6EDF3',
    muted: '#8B949E',
    accentA: '#1E88E5',
    accentB: '#02569B',
    bar: '#1E88E5',
    barNow: '#64B5F6',
    grid: '#21262D',
  },
  light: {
    bg: '#FFFFFF',
    border: '#D0D7DE',
    tile: '#F6F8FA',
    text: '#1F2328',
    muted: '#57606A',
    accentA: '#02569B',
    accentB: '#1E88E5',
    bar: '#0277BD',
    barNow: '#02569B',
    grid: '#EAEEF2',
  },
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function renderSvg(stats, theme) {
  const t = THEMES[theme];
  const W = 860;
  const pad = 24;
  const gap = 16;
  const hasChart = stats.months?.some((m) => m.total > 0);
  const H = hasChart ? 340 : 200;
  const tileW = (W - pad * 2 - gap * 3) / 4;
  const tileY = 52;
  const tileH = 112;

  const updated = stats.updated
    ? new Date(stats.updated).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    : '';

  const tiles = [
    { value: fmt(stats.commits), label: 'COMMITS', sub: stats.since ? `since ${stats.since}` : 'all time' },
    { value: fmt(stats.activeDays), label: 'ACTIVE DAYS', sub: stats.longestStreak ? `longest streak ${fmt(stats.longestStreak)} days` : 'days with contributions' },
    { value: String(STATIC.productionApps), label: 'PRODUCTION APPS', sub: 'live in the stores' },
    { value: String(STATIC.platforms.length), label: 'PLATFORMS', sub: STATIC.platforms.join(' · ') },
  ];

  const tileSvg = tiles
    .map((tile, i) => {
      const x = pad + i * (tileW + gap);
      return `
  <g>
    <rect x="${x}" y="${tileY}" width="${tileW}" height="${tileH}" rx="10" fill="${t.tile}" stroke="${t.border}"/>
    <rect x="${x}" y="${tileY}" width="${tileW}" height="3" rx="1.5" fill="url(#accent)"/>
    <text x="${x + 18}" y="${tileY + 50}" class="num">${esc(tile.value)}</text>
    <text x="${x + 18}" y="${tileY + 76}" class="label">${esc(tile.label)}</text>
    <text x="${x + 18}" y="${tileY + 96}" class="sub">${esc(tile.sub)}</text>
  </g>`;
    })
    .join('');

  let chart = '';
  if (hasChart) {
    const cx = pad;
    const cy = tileY + tileH + 28;
    const cw = 540;
    const ch = 96;
    const max = Math.max(...stats.months.map((m) => m.total), 1);
    const slot = cw / stats.months.length;
    const bw = slot - 10;
    const bars = stats.months
      .map((m, i) => {
        const h = Math.max(2, Math.round((m.total / max) * ch));
        const x = cx + i * slot + 5;
        const last = i === stats.months.length - 1;
        return `
    <rect x="${x}" y="${cy + 20 + ch - h}" width="${bw}" height="${h}" rx="3" fill="${last ? t.barNow : t.bar}" opacity="${last ? 1 : 0.85}"><title>${esc(m.key)}: ${fmt(m.total)} contributions</title></rect>
    <text x="${x + bw / 2}" y="${cy + ch + 38}" class="tick" text-anchor="middle">${esc(m.label)}</text>`;
      })
      .join('');

    const yx = cx + cw + 36;
    const recent = [...stats.years].reverse().slice(0, 3);
    const thisYear = new Date(stats.updated || Date.now()).getUTCFullYear();
    const yearRows = recent
      .map(
        (y, i) => `
    <text x="${yx}" y="${cy + 52 + i * 30}" class="year">${y.year}</text>
    <text x="${W - pad}" y="${cy + 52 + i * 30}" class="yearval" text-anchor="end">${fmt(y.commits)} commits${y.year === thisYear ? ' so far' : ''}</text>`,
      )
      .join('');

    chart = `
  <g>
    <text x="${cx}" y="${cy + 6}" class="label">CONTRIBUTIONS · LAST 12 MONTHS</text>
    <line x1="${cx}" y1="${cy + 20 + ch}" x2="${cx + cw}" y2="${cy + 20 + ch}" stroke="${t.grid}"/>${bars}
    <line x1="${yx - 18}" y1="${cy}" x2="${yx - 18}" y2="${cy + ch + 40}" stroke="${t.grid}"/>
    <text x="${yx}" y="${cy + 6}" class="label">BY YEAR</text>${yearRows}
  </g>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title">
  <title id="title">${esc(`${fmt(stats.commits)} commits, ${fmt(stats.activeDays)} active days, ${STATIC.productionApps} production apps on ${STATIC.platforms.join(', ')}`)}</title>
  <defs>
    <linearGradient id="accent" x1="0" x2="1">
      <stop offset="0" stop-color="${t.accentA}"/>
      <stop offset="1" stop-color="${t.accentB}"/>
    </linearGradient>
  </defs>
  <style>
    text { font-family: 'Segoe UI', Ubuntu, 'Helvetica Neue', Helvetica, Arial, sans-serif; }
    .num { font-size: 34px; font-weight: 700; fill: ${t.text}; }
    .label { font-size: 11.5px; font-weight: 600; letter-spacing: 1.2px; fill: ${t.muted}; }
    .sub { font-size: 12.5px; fill: ${t.muted}; }
    .tick { font-size: 11px; fill: ${t.muted}; }
    .head { font-size: 13px; fill: ${t.muted}; }
    .year { font-size: 14px; font-weight: 600; fill: ${t.text}; }
    .yearval { font-size: 14px; fill: ${t.text}; }
  </style>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="14" fill="${t.bg}" stroke="${t.border}"/>
  <text x="${pad}" y="34" class="head">Private work included</text>
  <text x="${W - pad}" y="34" class="head" text-anchor="end">${updated ? `Updated ${esc(updated)}` : ''}</text>${tileSvg}${chart}
</svg>
`;
}

// -------------------------------------------------------------- readme ----

function readmeBlock(stats) {
  const alt = `${fmt(stats.commits)} commits, ${fmt(stats.activeDays)} active days, ${STATIC.productionApps} production apps on ${STATIC.platforms.join(', ')}`;
  return `<!-- STATS:START -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/stats-dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="assets/stats-light.svg" />
  <img src="assets/stats-light.svg" alt="${esc(alt)}" width="100%" />
</picture>
<!-- STATS:END -->`;
}

async function updateReadme(stats) {
  const path = 'README.md';
  const readme = await readFile(path, 'utf8');
  const re = /<!-- STATS:START -->[\s\S]*?<!-- STATS:END -->/;
  if (!re.test(readme)) throw new Error('README.md has no <!-- STATS:START --> / <!-- STATS:END --> markers');
  await writeFile(path, readme.replace(re, readmeBlock(stats)));
}

// ---------------------------------------------------------------- main ----

const args = process.argv.slice(2);
let stats;
const jsonIdx = args.indexOf('--from-json');
if (jsonIdx !== -1) {
  stats = JSON.parse(await readFile(args[jsonIdx + 1], 'utf8'));
} else {
  const token = process.env.STATS_TOKEN;
  if (!token) {
    console.log('::error::STATS_TOKEN secret is missing. Add a classic PAT (read:user + repo) under Settings → Secrets and variables → Actions.');
    process.exit(1);
  }
  try {
    stats = await fetchStats(token);
  } catch (e) {
    const hint = /\b401\b|Bad credentials/.test(e.message) ? ' The STATS_TOKEN secret is invalid or expired.' : '';
    console.log(`::error::${e.message.replace(/\s+/g, ' ')}${hint}`);
    process.exit(1);
  }
}

await mkdir('assets', { recursive: true });
await writeFile('assets/stats-dark.svg', renderSvg(stats, 'dark'));
await writeFile('assets/stats-light.svg', renderSvg(stats, 'light'));
if (jsonIdx === -1) await writeFile('assets/stats.json', JSON.stringify(stats, null, 2) + '\n');
await updateReadme(stats);

console.log(
  `commits ${fmt(stats.commits)} · contributions ${fmt(stats.contributions ?? 0)} · active days ${fmt(stats.activeDays)} · longest streak ${fmt(stats.longestStreak ?? 0)}`,
);
