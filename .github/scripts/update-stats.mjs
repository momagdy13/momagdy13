// Builds the "By the numbers" card for the profile README.
//
// Live mode (used by the workflow):
//   STATS_TOKEN=<classic PAT, scopes read:user + repo> node .github/scripts/update-stats.mjs
// Offline render from a JSON file (for previews):
//   node .github/scripts/update-stats.mjs --from-json stats.json
//
// Writes assets/stats-*.svg, assets/activity-*.svg, assets/stats.json and
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
  let longestFrom = null;
  let longestTo = null;
  let run = 0;
  let runFrom = null;
  let prev = null;
  for (const d of active) {
    const t = Date.parse(d);
    if (prev !== null && t - prev === 86400000) run += 1;
    else {
      run = 1;
      runFrom = d;
    }
    if (run > longest) {
      longest = run;
      longestFrom = runFrom;
      longestTo = d;
    }
    prev = t;
  }

  // Current streak: today counts if active, but an empty today does not break it yet.
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  const today = iso(now.getTime());
  let cursor = Date.parse(today);
  if (!(days.get(today) > 0)) cursor -= 86400000;
  let current = 0;
  let currentFrom = null;
  const currentTo = days.get(iso(cursor)) > 0 ? iso(cursor) : null;
  while (days.get(iso(cursor)) > 0) {
    current += 1;
    currentFrom = iso(cursor);
    cursor -= 86400000;
  }

  // Daily contributions for the last 31 days.
  const last31 = [];
  for (let i = 30; i >= 0; i--) {
    const d = iso(Date.parse(today) - i * 86400000);
    last31.push({ date: d, count: days.get(d) || 0 });
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
    longestStreakFrom: longestFrom,
    longestStreakTo: longestTo,
    currentStreak: current,
    currentStreakFrom: currentFrom,
    currentStreakTo: currentTo,
    firstContribution: active[0] || null,
    last31,
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

const shortDate = (d, withYear = true) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  });

const range = (from, to) => {
  if (!from || !to) return '';
  if (from === to) return shortDate(from);
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  return `${shortDate(from, !sameYear)} – ${shortDate(to)}`;
};

// Streak tiles plus a 31-day line chart, from the same private-inclusive calendar as the stats card.
function renderActivitySvg(stats, theme) {
  const t = THEMES[theme];
  const W = 860;
  const H = 372;
  const pad = 24;
  const gap = 16;
  const tileW = (W - pad * 2 - gap * 2) / 3;
  const tileY = 52;
  const tileH = 112;

  const tiles = [
    {
      value: fmt(stats.contributions),
      label: 'TOTAL CONTRIBUTIONS',
      sub: stats.firstContribution ? `${shortDate(stats.firstContribution)} – Present` : 'all time',
    },
    {
      value: fmt(stats.currentStreak),
      label: 'CURRENT STREAK',
      sub: stats.currentStreak ? range(stats.currentStreakFrom, stats.currentStreakTo) : 'start one today',
      ring: true,
    },
    {
      value: fmt(stats.longestStreak),
      label: 'LONGEST STREAK',
      sub: range(stats.longestStreakFrom, stats.longestStreakTo),
    },
  ];

  const tileSvg = tiles
    .map((tile, i) => {
      const x = pad + i * (tileW + gap);
      let ring = '';
      if (tile.ring) {
        const r = 30;
        const cx = x + tileW - 50;
        const cy = tileY + tileH / 2;
        const c = 2 * Math.PI * r;
        const share = stats.longestStreak ? Math.min(1, stats.currentStreak / stats.longestStreak) : 0;
        const dash = Math.max(share * c, stats.currentStreak ? 6 : 0);
        ring = `
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${t.grid}" stroke-width="6"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="url(#accent)" stroke-width="6" stroke-linecap="round"
      stroke-dasharray="${dash.toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 ${cx} ${cy})"/>
    <path d="M${cx} ${cy - 13} c5 6 9 10 9 15 a9 9 0 0 1 -18 0 c0 -4 2 -7 4 -9 c0 3 2 5 4 5 c-2 -4 -1 -8 1 -11z" fill="${t.barNow}"/>`;
      }
      return `
  <g>
    <rect x="${x}" y="${tileY}" width="${tileW}" height="${tileH}" rx="10" fill="${t.tile}" stroke="${t.border}"/>
    <rect x="${x}" y="${tileY}" width="${tileW}" height="3" rx="1.5" fill="url(#accent)"/>
    <text x="${x + 18}" y="${tileY + 50}" class="num">${esc(tile.value)}</text>
    <text x="${x + 18}" y="${tileY + 76}" class="label">${esc(tile.label)}</text>
    <text x="${x + 18}" y="${tileY + 96}" class="sub">${esc(tile.sub)}</text>${ring}
  </g>`;
    })
    .join('');

  // Line chart.
  const pts = stats.last31 || [];
  const total31 = pts.reduce((s, p) => s + p.count, 0);
  const cx0 = pad + 34;
  const cx1 = W - pad;
  const cyTop = tileY + tileH + 48;
  const ch = 120;
  const cyBase = cyTop + ch;
  const rawMax = Math.max(...pts.map((p) => p.count), 1);
  const step = Math.max(1, Math.ceil(rawMax / 4));
  const max = step * 4;
  const xAt = (i) => cx0 + (i * (cx1 - cx0)) / Math.max(1, pts.length - 1);
  const yAt = (v) => cyBase - (v / max) * ch;

  let grid = '';
  for (let k = 0; k <= 4; k++) {
    const v = step * k;
    const y = yAt(v);
    grid += `
    <line x1="${cx0}" y1="${y}" x2="${cx1}" y2="${y}" stroke="${t.grid}"${k ? ' stroke-dasharray="3 4"' : ''}/>
    <text x="${cx0 - 10}" y="${y + 4}" class="tick" text-anchor="end">${fmt(v)}</text>`;
  }

  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${xAt(i).toFixed(1)} ${yAt(p.count).toFixed(1)}`).join(' ');
  const area = pts.length ? `${line} L${xAt(pts.length - 1).toFixed(1)} ${cyBase} L${xAt(0).toFixed(1)} ${cyBase} Z` : '';
  const dots = pts
    .map(
      (p, i) =>
        `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(p.count).toFixed(1)}" r="${i === pts.length - 1 ? 4 : 2.6}" fill="${i === pts.length - 1 ? t.barNow : t.bar}" stroke="${t.bg}" stroke-width="1.5"><title>${esc(shortDate(p.date))}: ${fmt(p.count)} contributions</title></circle>`,
    )
    .join('');
  const ticks = pts
    .map((p, i) =>
      i % 5 === 0 || i === pts.length - 1
        ? `<text x="${xAt(i).toFixed(1)}" y="${cyBase + 20}" class="tick" text-anchor="middle">${esc(shortDate(p.date, false))}</text>`
        : '',
    )
    .join('');

  const updated = stats.updated
    ? new Date(stats.updated).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title">
  <title id="title">${esc(`${fmt(stats.contributions)} contributions, current streak ${stats.currentStreak} days, longest streak ${stats.longestStreak} days`)}</title>
  <defs>
    <linearGradient id="accent" x1="0" x2="1">
      <stop offset="0" stop-color="${t.accentA}"/>
      <stop offset="1" stop-color="${t.accentB}"/>
    </linearGradient>
    <linearGradient id="area" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="${t.bar}" stop-opacity="0.35"/>
      <stop offset="1" stop-color="${t.bar}" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <style>
    text { font-family: 'Segoe UI', Ubuntu, 'Helvetica Neue', Helvetica, Arial, sans-serif; }
    .num { font-size: 34px; font-weight: 700; fill: ${t.text}; }
    .label { font-size: 11.5px; font-weight: 600; letter-spacing: 1.2px; fill: ${t.muted}; }
    .sub { font-size: 12.5px; fill: ${t.muted}; }
    .tick { font-size: 11px; fill: ${t.muted}; }
    .head { font-size: 13px; fill: ${t.muted}; }
  </style>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="14" fill="${t.bg}" stroke="${t.border}"/>
  <text x="${pad}" y="34" class="head">Streaks · private work included</text>
  <text x="${W - pad}" y="34" class="head" text-anchor="end">${updated ? `Updated ${esc(updated)}` : ''}</text>${tileSvg}
  <text x="${pad}" y="${cyTop - 20}" class="label">CONTRIBUTIONS · LAST 31 DAYS</text>
  <text x="${W - pad}" y="${cyTop - 20}" class="label" text-anchor="end">${fmt(total31)} TOTAL</text>${grid}
  <path d="${area}" fill="url(#area)"/>
  <path d="${line}" fill="none" stroke="${t.bar}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
  ${dots}
  ${ticks}
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
if (stats.last31) {
  await writeFile('assets/activity-dark.svg', renderActivitySvg(stats, 'dark'));
  await writeFile('assets/activity-light.svg', renderActivitySvg(stats, 'light'));
}
if (jsonIdx === -1) await writeFile('assets/stats.json', JSON.stringify(stats, null, 2) + '\n');
await updateReadme(stats);

console.log(
  `commits ${fmt(stats.commits)} · contributions ${fmt(stats.contributions ?? 0)} · active days ${fmt(stats.activeDays)} · longest streak ${fmt(stats.longestStreak ?? 0)}`,
);
