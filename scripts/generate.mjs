#!/usr/bin/env node
/**
 * Aplyr job-list README generator. Zero dependencies (Node >= 18).
 *
 * Runs inside a public job-list repo (daily GitHub Action) and:
 *   1. fetches the list export  GET https://aplyr.ai/api/public/job-lists/<slug>.json
 *   2. merges it with data/listings.json (open rows, recently closed rows)
 *   3. rewrites README.md between the APLYR:LISTINGS markers
 *      (creates a full README on first run)
 *
 * Writes nothing when the listings are unchanged, so the workflow only commits
 * real changes. Refuses to write when the export suddenly shrinks (outage
 * guard) unless --force.
 *
 * Usage (from the repo root):
 *   node scripts/generate.mjs                      # reads ./aplyr-list.json
 *   node scripts/generate.mjs --fixture f.json     # offline, from a saved export
 *   node scripts/generate.mjs --dir out --now 2026-10-17T13:00:00Z --force
 *
 * aplyr-list.json: { "slug": "...", "exportUrl": "https://aplyr.ai/api/public/job-lists/<slug>.json" }
 *
 * The same file lives in the Aplyr monorepo at
 * web/scripts/github-job-lists/generate.mjs (unit tested there); repos get a
 * copy via scaffold.mjs. Edit it there, not in the repos.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const START = '<!-- APLYR:LISTINGS:START -->';
export const END = '<!-- APLYR:LISTINGS:END -->';
const UPDATED_RE = /<!-- updated:[^>]*-->/g;

export const CLOSED_RETENTION_DAYS = 14;
export const MAX_CLOSED_ROWS = 300;
/** Outage guard: refuse when open rows drop below this share of yesterday's. */
export const MIN_KEEP_RATIO = 0.4;
const ALLOWED_HOSTS = new Set(['aplyr.ai', 'www.aplyr.ai']);
const DAY_MS = 86400000;

// ─── Small helpers ────────────────────────────────────────────────────────

/** Escape text for a GitHub-flavored markdown table cell. Titles come from
 *  employer careers sites, so neutralize links, images, HTML and emphasis. */
export function cell(text) {
  return String(text ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\\/g, '\\\\')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
    .replace(/([[\]*_`~])/g, '\\$1');
}

/** Only https links to Aplyr make it into the README. */
export function safeUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname)) return null;
    return u.toString().replace(/\(/g, '%28').replace(/\)/g, '%29');
  } catch {
    return null;
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-10-15" → "Oct 15" (adds the year when it isn't the current one). */
export function shortDate(isoDay, nowMs) {
  const [y, m, d] = String(isoDay).split('-').map(Number);
  if (!y || !m || !d) return '';
  const thisYear = new Date(nowMs).getUTCFullYear();
  return `${MONTHS[m - 1]} ${d}${y !== thisYear ? `, ${y}` : ''}`;
}

export function longDate(nowMs) {
  const t = new Date(nowMs);
  return `${MONTHS[t.getUTCMonth()]} ${t.getUTCDate()}, ${t.getUTCFullYear()}`;
}

function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** GitHub heading anchor (github-slugger behaviour for our headings). */
export function anchor(heading) {
  return (
    '#' +
    heading
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/ /g, '-')
  );
}

// ─── Validation ───────────────────────────────────────────────────────────

export function validateExport(exp) {
  if (!exp || typeof exp !== 'object') throw new Error('export: not an object');
  if (exp.version !== 1) throw new Error(`export: unsupported version ${exp.version}`);
  if (!Array.isArray(exp.jobs) || !Array.isArray(exp.sections)) throw new Error('export: missing jobs/sections');
  for (const j of exp.jobs) {
    if (!j || typeof j.key !== 'string' || typeof j.title !== 'string' || typeof j.company !== 'string') {
      throw new Error('export: malformed job row');
    }
  }
  return exp;
}

// ─── State merge ──────────────────────────────────────────────────────────

const KEEP = ['id', 'company', 'companyUrl', 'title', 'locations', 'remote', 'level', 'section', 'posted', 'added', 'pay', 'url', 'sponsorsH1B', 'noSponsorship', 'usCitizenship'];

function slim(job) {
  const out = {};
  for (const k of KEEP) if (job[k] !== undefined && job[k] !== false) out[k] = job[k];
  return out;
}

export function emptyState(slug) {
  return { version: 1, slug, open: {}, closed: {} };
}

/**
 * Merge today's export into yesterday's state.
 *  - every exported row is open (a closed row that reappears re-opens)
 *  - a previously-open row that's missing is CLOSED, unless it simply aged out
 *    of the freshness window or was pushed past the export's row cap — those
 *    are dropped quietly, because "closed" must mean closed
 *  - closed rows are kept CLOSED_RETENTION_DAYS, newest MAX_CLOSED_ROWS
 *
 * @typedef {{ version: number, slug: string, open: Record<string, any>, closed: Record<string, any> }} ListState
 * @param {ListState | null | undefined} prev
 * @param {any} exp
 * @param {number} nowMs
 * @returns {ListState}
 */
export function mergeState(prev, exp, nowMs) {
  const today = isoDay(nowMs);
  const open = {};
  /** @type {Record<string, any>} */
  const closed = { ...(prev?.closed ?? {}) };
  const prevOpen = prev?.open ?? {};

  for (const job of exp.jobs) {
    const before = prevOpen[job.key] ?? closed[job.key];
    open[job.key] = { ...slim(job), firstSeen: before?.firstSeen ?? today };
    delete closed[job.key];
  }

  const ageCutoff = isoDay(nowMs - (exp.maxAgeDays ?? 120) * DAY_MS);
  for (const [key, old] of Object.entries(prevOpen)) {
    if (open[key]) continue;
    if (old.posted && old.posted < ageCutoff) continue; // aged out
    if (exp.truncated && exp.oldestPosted && old.posted && old.posted <= exp.oldestPosted) continue; // pushed out
    closed[key] = { ...old, closedAt: today };
  }

  const retainCutoff = isoDay(nowMs - CLOSED_RETENTION_DAYS * DAY_MS);
  const keptClosed = Object.entries(closed)
    .filter(([, c]) => c.closedAt && c.closedAt >= retainCutoff)
    .sort(([, a], [, b]) => `${b.closedAt}${b.posted ?? ''}`.localeCompare(`${a.closedAt}${a.posted ?? ''}`))
    .slice(0, MAX_CLOSED_ROWS);

  return { version: 1, slug: exp.slug, open, closed: Object.fromEntries(keptClosed) };
}

/** Same listings (ignores key order)? */
export function sameListings(a, b) {
  const norm = (s) =>
    JSON.stringify({
      open: Object.keys(s?.open ?? {}).sort().map((k) => [k, s.open[k]]),
      closed: Object.keys(s?.closed ?? {}).sort().map((k) => [k, s.closed[k]]),
    });
  return norm(a) === norm(b);
}

/** Outage guard. Returns a reason string when the export looks broken. */
export function collapseReason(prev, exp) {
  const before = Object.keys(prev?.open ?? {}).length;
  const now = exp.jobs.length;
  if (before >= 25 && now < before * MIN_KEEP_RATIO) {
    return `export has ${now} open rows vs ${before} yesterday (< ${MIN_KEEP_RATIO * 100}%)`;
  }
  return null;
}

// ─── Rendering ────────────────────────────────────────────────────────────

/** Size budget for the generated block. GitHub stops rendering very large
 *  READMEs, so past this the tables drop the per-company links (≈30% smaller). */
export const MAX_BLOCK_BYTES = 450_000;

/** "New" = entered Aplyr's index within this window. */
export const NEW_WINDOW_HOURS = 48;
/** "This week" summary window. */
export const WEEK_DAYS = 7;

/** Badges are text, rendered as inline code (grey pills on GitHub). */
export const BADGES = {
  new: '🆕',
  sponsors: '`Sponsors visas`',
  noSponsorship: '`No sponsorship`',
  citizens: '`U.S. citizens`',
  closed: '`Closed`',
};

export const LEGEND = [
  [BADGES.new, `added in the last ${NEW_WINDOW_HOURS} hours`],
  [BADGES.sponsors, 'the company has sponsored H-1B visas before'],
  [BADGES.noSponsorship, 'the posting says it can’t sponsor a visa'],
  [BADGES.citizens, 'needs U.S. citizenship or a security clearance'],
];

/** When the row entered the index (ms): export `added`, else the posted day. */
export function addedMs(job) {
  const t = job.added ? Date.parse(job.added) : NaN;
  return Number.isFinite(t) ? t : Date.parse(`${job.posted}T00:00:00Z`);
}

export function isNew(job, nowMs) {
  const t = addedMs(job);
  return Number.isFinite(t) && nowMs - t < NEW_WINDOW_HOURS * 3600000 && t <= nowMs + 3600000;
}

/** Day the row first showed up: the earlier of the index's `added` day and
 *  this repo's own firstSeen (state), so day one of a repo isn't "all new". */
function arrivedDay(job) {
  const a = job.added ? String(job.added).slice(0, 10) : null;
  const f = job.firstSeen ?? null;
  return a && f ? (a < f ? a : f) : a ?? f ?? job.posted ?? '';
}

/** Open rows that arrived in the last WEEK_DAYS days + their top companies. */
export function weekSummary(openRows, nowMs, topN = 5) {
  const since = isoDay(nowMs - WEEK_DAYS * DAY_MS);
  const fresh = openRows.filter((j) => arrivedDay(j) > since);
  const byCompany = new Map();
  for (const j of fresh) byCompany.set(j.company, (byCompany.get(j.company) ?? 0) + 1);
  const top = [...byCompany.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, topN)
    .map(([company, count]) => ({ company, count }));
  return { count: fresh.length, companies: byCompany.size, top };
}

function badges(job) {
  const f = [];
  if (job.sponsorsH1B) f.push(BADGES.sponsors);
  if (job.noSponsorship) f.push(BADGES.noSponsorship);
  if (job.usCitizenship) f.push(BADGES.citizens);
  return f.length ? ` ${f.join(' ')}` : '';
}

function locationCell(job) {
  const locs = [...(job.locations ?? [])];
  if (job.remote && !locs.some((l) => /remote/i.test(l))) locs.push('Remote');
  if (!locs.length) return '';
  if (locs.length <= 2) return locs.map(cell).join('<br>');
  return `<details><summary>${cell(locs[0])} +${locs.length - 1}</summary>${locs.slice(1).map(cell).join('<br>')}</details>`;
}

function companyCell(job, linked) {
  const url = linked ? null : safeUrl(job.companyUrl);
  return url ? `[${cell(job.company)}](${url})` : cell(job.company);
}

function sortRows(rows) {
  // Newest first; ties keep the same company together.
  return rows.sort(
    (a, b) => (b.posted ?? '').localeCompare(a.posted ?? '') || a.company.localeCompare(b.company) || a.title.localeCompare(b.title),
  );
}

/** One section's table. Column order + names are ours: Role first, then the
 *  employer, where, pay, when, and the link. The company links to its Aplyr
 *  page on its first row in the section only (keeps the README small). */
export function renderOpenTable(rows, { showLevel, nowMs, compact = false }) {
  const head = showLevel
    ? '| Role | Level | Company | Location | Pay | Posted | |\n| --- | --- | --- | --- | --- | --- | --- |'
    : '| Role | Company | Location | Pay | Posted | |\n| --- | --- | --- | --- | --- | --- |';
  const lines = [head];
  const linked = new Set();
  for (const job of sortRows([...rows])) {
    const url = safeUrl(job.url);
    if (!url) continue;
    const role = `${isNew(job, nowMs) ? `${BADGES.new} ` : ''}**${cell(job.title)}**${badges(job)}`;
    const cols = [role];
    if (showLevel) cols.push(cell(job.level ?? ''));
    cols.push(companyCell(job, compact || linked.has(job.company)), locationCell(job), cell(job.pay ?? ''), shortDate(job.posted, nowMs), `[Apply](${url})`);
    linked.add(job.company);
    lines.push(`| ${cols.join(' | ')} |`);
  }
  return lines.join('\n');
}

function renderClosedTable(rows, nowMs) {
  const lines = ['| Role | Company | Location | Posted | Closed |', '| --- | --- | --- | --- | --- |'];
  const sorted = rows.sort((a, b) => b.closedAt.localeCompare(a.closedAt) || (b.posted ?? '').localeCompare(a.posted ?? ''));
  for (const job of sorted) {
    lines.push(
      `| ${BADGES.closed} ${cell(job.title)} | ${cell(job.company)} | ${locationCell(job)} | ${shortDate(job.posted, nowMs)} | ${shortDate(job.closedAt, nowMs)} |`,
    );
  }
  return lines.join('\n');
}

function sectionHeading(s) {
  return `${s.emoji} ${s.label}`;
}

const CLOSED_HEADING = 'Recently closed';

/** Deep links on the /l page, derived from pageUrl for older exports. */
function pageLink(exp, field, content, hash = '') {
  const own = exp[field] ? safeUrl(exp[field]) : null;
  if (own) return own;
  const page = safeUrl(exp.pageUrl);
  if (!page) return null;
  const u = new URL(page);
  u.searchParams.set('utm_content', content);
  return safeUrl(u.toString() + hash);
}

function plural(n, word, many = `${word}s`) {
  return `${n.toLocaleString('en-US')} ${n === 1 ? word : many}`;
}

/** The generated block, markers included (compact past MAX_BLOCK_BYTES). */
export function renderBlock(exp, state, nowMs) {
  const full = renderBlockWith(exp, state, nowMs, false);
  return Buffer.byteLength(full) > MAX_BLOCK_BYTES ? renderBlockWith(exp, state, nowMs, true) : full;
}

function renderBlockWith(exp, state, nowMs, compact) {
  const open = Object.values(state.open);
  const closed = Object.values(state.closed);
  const companies = new Set(open.map((j) => j.company)).size;
  const autopilot = pageLink(exp, 'autopilotUrl', 'autopilot');
  const alerts = pageLink(exp, 'alertsUrl', 'alerts', '#alerts');
  const feed = safeUrl(exp.feedUrl);
  const out = [START, '<!-- Generated daily by scripts/generate.mjs. Edits inside these markers are overwritten. -->', ''];

  out.push(
    `**${plural(open.length, 'open role')}** at **${plural(companies, 'company', 'companies')}** · ✅ Verified open ${longDate(nowMs)} <!-- updated:${new Date(nowMs).toISOString()} -->`,
  );
  out.push('');
  out.push(
    '> Every role here was live on the employer’s careers site within the last 3 days.',
  );
  out.push('');
  if (autopilot) out.push(`**Apply to all of these with Autopilot:** [set it up once on Aplyr](${autopilot}) and it applies for you as new roles open.`, '');
  const subscribe = [alerts && `[email](${alerts})`, feed && `[RSS](${feed})`].filter(Boolean);
  if (subscribe.length) out.push(`**Get new roles by ${subscribe.join(' or ')}**, no account needed.`, '');

  const week = weekSummary(open, nowMs);
  out.push(`### This week`, '');
  if (week.count) {
    const top = week.top.map((t) => `${cell(t.company)} (${t.count})`);
    const lead = top.length > 1 ? `${top.slice(0, -1).join(', ')} and ${top[top.length - 1]}` : top[0];
    out.push(
      `**${plural(week.count, 'new role')}** from ${plural(week.companies, 'company', 'companies')} in the last ${WEEK_DAYS} days. Most new openings: ${lead}.`,
    );
  } else {
    out.push(`No new roles in the last ${WEEK_DAYS} days. New postings show up here within a day.`);
  }
  out.push('');

  out.push(`**Legend:** ${LEGEND.map(([b, t]) => `${b} ${t}`).join(' · ')}`);
  out.push('');

  const toc = exp.sections
    .map((s) => `[${s.label} (${open.filter((j) => j.section === s.key).length})](${anchor(sectionHeading(s))})`)
    .concat(closed.length ? [`[${CLOSED_HEADING} (${closed.length})](${anchor(CLOSED_HEADING)})`] : []);
  out.push(`**Sections:** ${toc.join(' · ')}`);
  out.push('');

  for (const s of exp.sections) {
    const rows = open.filter((j) => j.section === s.key);
    out.push(`## ${sectionHeading(s)}`, '');
    if (!rows.length) out.push('_Nothing open in this section right now. New postings show up here within a day._');
    else out.push(renderOpenTable(rows, { showLevel: !!exp.showLevel, nowMs, compact }));
    out.push('', `<sub>[Back to top](#readme)</sub>`, '');
  }

  if (closed.length) {
    out.push(`## ${CLOSED_HEADING}`, '');
    out.push(
      `<details>\n<summary>${plural(closed.length, 'role')} closed in the last ${CLOSED_RETENTION_DAYS} days</summary>\n`,
    );
    out.push(renderClosedTable(closed, nowMs));
    out.push('', '</details>', '');
  }

  out.push(END);
  return out.join('\n');
}

/** Replace the marked block; returns null when the markers are missing. */
export function replaceBlock(readme, block) {
  const a = readme.indexOf(START);
  const b = readme.indexOf(END);
  if (a === -1 || b === -1 || b < a) return null;
  return readme.slice(0, a) + block + readme.slice(b + END.length);
}

export function extractBlock(readme) {
  const a = readme.indexOf(START);
  const b = readme.indexOf(END);
  return a === -1 || b === -1 || b < a ? null : readme.slice(a, b + END.length);
}

/** Block text minus the volatile time-of-day stamp, for change detection.
 *  The "Verified open <date>" line is kept on purpose: a new day always
 *  rewrites the README, so that date never goes stale. */
export function stableBlock(block) {
  return (block ?? '').replace(UPDATED_RE, '');
}

/** Full README for a brand-new repo. Everything outside the markers is the
 *  owner's to edit afterwards; the generator never touches it again. */
export function initialReadme(exp, block) {
  const page = safeUrl(exp.pageUrl) ?? 'https://aplyr.ai';
  return `# ${exp.title}

${exp.description}

${exp.readmeIntro}

## How to use this list

- **Apply** opens the role on Aplyr, with the full description and a link to the employer's application.
- ${LEGEND.map(([b, t]) => `${b} ${t}`).join('\n- ')}
- Closed roles move to **${CLOSED_HEADING}** for ${CLOSED_RETENTION_DAYS} days.

Found a closed role or a mistake? [Open an issue](CONTRIBUTING.md).

${block}

---

Listings come from [Aplyr](${page}), straight from employers' own careers sites. Not affiliated with the companies listed.
`;
}

// ─── IO ───────────────────────────────────────────────────────────────────

async function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function fetchExport(url, { attempts = 3, timeoutMs = 30000 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'aplyr-github-joblists/1 (+https://github.com)' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 5000 * (i + 1)));
    }
  }
  throw new Error(`fetch ${url} failed: ${lastErr?.message ?? lastErr}`);
}

/**
 * One generator run. Returns { changed, reason }.
 * @param {{ dir?: string, fixture?: string, nowMs?: number, force?: boolean, log?: (msg: string) => void }} [opts]
 */
export async function run({ dir = process.cwd(), fixture, nowMs = Date.now(), force = false, log = console.log } = {}) {
  const config = await readJson(path.join(dir, 'aplyr-list.json'), null);
  if (!config && !fixture) throw new Error('aplyr-list.json not found (or pass --fixture)');
  const exp = validateExport(fixture ? JSON.parse(await readFile(fixture, 'utf8')) : await fetchExport(config.exportUrl));

  const stateFile = path.join(dir, 'data', 'listings.json');
  const readmeFile = path.join(dir, 'README.md');
  const prev = await readJson(stateFile, emptyState(exp.slug));

  const collapse = collapseReason(prev, exp);
  if (collapse && !force) {
    // Annotate the Actions run; keep yesterday's README.
    log(`::warning::Skipping update: ${collapse}. Re-run with --force if the drop is real.`);
    return { changed: false, reason: 'collapse' };
  }

  const state = mergeState(prev, exp, nowMs);
  const block = renderBlock(exp, state, nowMs);
  const readme = existsSync(readmeFile) ? await readFile(readmeFile, 'utf8') : null;
  const current = readme ? extractBlock(readme) : null;

  if (current && sameListings(prev, state) && stableBlock(current) === stableBlock(block)) {
    log('No listing changes.');
    return { changed: false, reason: 'unchanged' };
  }

  const next = readme ? replaceBlock(readme, block) : null;
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(readmeFile, next ?? (readme ? `${readme.trimEnd()}\n\n${block}\n` : initialReadme(exp, block)));
  await writeFile(stateFile, `${JSON.stringify(state, null, 1)}\n`);
  log(`Updated: ${Object.keys(state.open).length} open, ${Object.keys(state.closed).length} recently closed.`);
  return { changed: true, reason: readme ? 'updated' : 'created' };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') out.force = true;
    else if (a === '--fixture') out.fixture = argv[++i];
    else if (a === '--dir') out.dir = argv[++i];
    else if (a === '--now') out.nowMs = Date.parse(argv[++i]);
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(parseArgs(process.argv.slice(2))).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
