#!/usr/bin/env node
/**
 * Aplyr job-list README generator. Zero dependencies (Node >= 18).
 *
 * Runs inside a public job-list repo (daily GitHub Action) and:
 *   1. fetches the list export  GET https://aplyr.ai/api/public/job-lists/<slug>.json?v=2
 *      (every open row; without v=2 the export is capped for older generators)
 *   2. merges it with data/listings.json (open rows, recently closed rows)
 *   3. rewrites README.md between the APLYR:LISTINGS markers
 *      (creates a full README on first run). The README holds every row while
 *      it fits GitHub's render limit; past that each section shows its newest
 *      rows and links to its full listing in listings/<section>.md, split into
 *      numbered pages (listings/<section>-2.md, …) that each fit the limit.
 *
 * Writes nothing when the listings are unchanged, so the workflow only commits
 * real changes. Refuses to write when the export suddenly shrinks (outage
 * guard) unless --force. Removes listing pages it generated that are no
 * longer needed.
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

import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
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

/** Export versions this generator reads: 1 = capped rows (older API), 2 = every open row. */
export const EXPORT_VERSIONS = new Set([1, 2]);

export function validateExport(exp) {
  if (!exp || typeof exp !== 'object') throw new Error('export: not an object');
  if (!EXPORT_VERSIONS.has(exp.version)) throw new Error(`export: unsupported version ${exp.version}`);
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

/** Size budget for the generated README block. GitHub stops rendering very
 *  large READMEs (~512 KB), so past this the tables first drop the per-company
 *  links (≈30% smaller), then each section shows only its newest rows and
 *  links to its full listing pages. */
export const MAX_BLOCK_BYTES = 450_000;
/** Size budget for each listings/ page (same GitHub render limit). */
export const MAX_PAGE_BYTES = 450_000;
/** Folder for the full per-section listings, relative to the repo root. */
export const LISTINGS_DIR = 'listings';
/** First line of every generated listing page; only files carrying it are
 *  ever rewritten or deleted by the generator. */
export const PAGE_MARKER = '<!-- APLYR:GENERATED listing page. Rebuilt daily by scripts/generate.mjs; edits are overwritten. -->';

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

function tableHead(showLevel) {
  return showLevel
    ? '| Role | Level | Company | Location | Pay | Posted | |\n| --- | --- | --- | --- | --- | --- | --- |'
    : '| Role | Company | Location | Pay | Posted | |\n| --- | --- | --- | --- | --- | --- |';
}

/** One table row, or null when the row has no safe link. `linked` = companies
 *  already linked in this table (each company links on its first row only). */
function rowLine(job, { showLevel, nowMs, compact, linked }) {
  const url = safeUrl(job.url);
  if (!url) return null;
  const role = `${isNew(job, nowMs) ? `${BADGES.new} ` : ''}**${cell(job.title)}**${badges(job)}`;
  const cols = [role];
  if (showLevel) cols.push(cell(job.level ?? ''));
  cols.push(companyCell(job, compact || linked.has(job.company)), locationCell(job), cell(job.pay ?? ''), shortDate(job.posted, nowMs), `[Apply](${url})`);
  linked.add(job.company);
  return `| ${cols.join(' | ')} |`;
}

/** One section's table. Column order + names are ours: Role first, then the
 *  employer, where, pay, when, and the link. The company links to its Aplyr
 *  page on its first row in the section only (keeps the README small).
 *  `limit`: newest rows only. */
export function renderOpenTable(rows, { showLevel, nowMs, compact = false, limit = Infinity }) {
  const lines = [tableHead(showLevel)];
  const linked = new Set();
  for (const job of sortRows([...rows]).slice(0, limit)) {
    const line = rowLine(job, { showLevel, nowMs, compact, linked });
    if (line) lines.push(line);
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

const bytes = (s) => Buffer.byteLength(s);

/** Safe file stem for a section key ("swe" → listings/swe.md). */
export function sectionStem(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section';
}

/** listings/ file for page `n` (1-based) of a section, relative to the repo root. */
export function pagePath(key, n) {
  return `${LISTINGS_DIR}/${sectionStem(key)}${n > 1 ? `-${n}` : ''}.md`;
}

/**
 * Split a section's rows (newest first) into listing pages under
 * MAX_PAGE_BYTES each. Returns arrays of rendered row lines.
 */
function splitPages(rows, { showLevel, nowMs }) {
  // Room for the page's heading, nav, legend and table head.
  const budget = MAX_PAGE_BYTES - 4_000;
  const pages = [];
  let lines = [];
  let size = 0;
  let linked = new Set();
  for (const job of rows) {
    let line = rowLine(job, { showLevel, nowMs, compact: false, linked });
    if (!line) continue;
    if (lines.length && size + bytes(line) + 1 > budget) {
      pages.push(lines);
      lines = [];
      size = 0;
      linked = new Set();
      line = rowLine(job, { showLevel, nowMs, compact: false, linked });
    }
    lines.push(line);
    size += bytes(line) + 1;
  }
  if (lines.length) pages.push(lines);
  return pages;
}

function pageNav(key, n, total) {
  const parts = [`[← Back to the list](../README.md)`];
  if (n > 1) parts.push(`[← Page ${n - 1}](${pagePath(key, n - 1).slice(LISTINGS_DIR.length + 1)})`);
  if (n < total) parts.push(`[Page ${n + 1} →](${pagePath(key, n + 1).slice(LISTINGS_DIR.length + 1)})`);
  return parts.join(' · ');
}

/** Full listing pages for one section: Map(relative path → markdown). */
function renderSectionPages(exp, section, rows, nowMs) {
  const showLevel = !!exp.showLevel;
  const pages = splitPages(rows, { showLevel, nowMs });
  const out = new Map();
  const companies = new Set(rows.map((j) => j.company)).size;
  pages.forEach((lines, i) => {
    const n = i + 1;
    const nav = pageNav(section.key, n, pages.length);
    const pageOf = pages.length > 1 ? ` · page ${n} of ${pages.length}` : '';
    out.set(
      pagePath(section.key, n),
      [
        PAGE_MARKER,
        `# ${sectionHeading(section)}`,
        '',
        `**${plural(rows.length, 'open role')}** at **${plural(companies, 'company', 'companies')}**${pageOf} · ✅ Verified open ${longDate(nowMs)}`,
        '',
        `Part of [${cell(exp.title)}](../README.md), newest first. Every role is re-checked against the employer’s careers site daily.`,
        '',
        nav,
        '',
        `**Legend:** ${LEGEND.map(([b, t]) => `${b} ${t}`).join(' · ')}`,
        '',
        tableHead(showLevel),
        ...lines,
        '',
        nav,
        '',
      ].join('\n'),
    );
  });
  return out;
}

/**
 * Everything the generator writes besides data/listings.json:
 *   block — the README block, markers included, under MAX_BLOCK_BYTES:
 *           every row with company links → every row without them → the
 *           newest N rows per section (largest N that fits) with links to
 *           the full listings;
 *   files — Map(relative path → markdown) of listings/ pages for every
 *           section the README cuts (empty while the README holds every row).
 */
export function renderOutputs(exp, state, nowMs) {
  const open = Object.values(state.open);
  const bySection = new Map(exp.sections.map((s) => [s.key, sortRows(open.filter((j) => j.section === s.key))]));
  const fits = (b) => bytes(b) <= MAX_BLOCK_BYTES;
  const full = renderBlockWith(exp, state, nowMs, { compact: false, bySection });
  if (fits(full)) return { block: full, files: new Map() };
  const compact = renderBlockWith(exp, state, nowMs, { compact: true, bySection });
  if (fits(compact)) return { block: compact, files: new Map() };

  // Every section's full listing pages, so the README's links name the real
  // page count while N is searched; only cut sections' pages are written.
  const sectionPages = new Map(exp.sections.map((s) => [s.key, renderSectionPages(exp, s, bySection.get(s.key) ?? [], nowMs)]));
  const pages = new Map([...sectionPages].map(([k, m]) => [k, m.size]));
  // Largest per-section row count that fits (block size grows with it).
  const most = Math.max(0, ...[...bySection.values()].map((r) => r.length));
  let lo = 0;
  let hi = most;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(renderBlockWith(exp, state, nowMs, { compact: true, bySection, limit: mid, pages }))) lo = mid;
    else hi = mid - 1;
  }
  const files = new Map();
  for (const s of exp.sections) {
    if ((bySection.get(s.key) ?? []).length > lo) for (const [p, md] of sectionPages.get(s.key)) files.set(p, md);
  }
  return { block: renderBlockWith(exp, state, nowMs, { compact: true, bySection, limit: lo, pages }), files };
}

/** The generated README block, markers included. */
export function renderBlock(exp, state, nowMs) {
  return renderOutputs(exp, state, nowMs).block;
}

/** "Showing the newest 300 of 1,234. All 1,234 roles: page 1 · page 2" */
function moreLine(section, shown, total, pageCount) {
  const links = Array.from({ length: Math.max(1, pageCount) }, (_, i) => `[${pageCount > 1 ? `page ${i + 1}` : `all ${total.toLocaleString('en-US')} roles`}](${pagePath(section.key, i + 1)})`);
  const lead = shown ? `Showing the newest ${shown.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}.` : `${plural(total, 'open role')}.`;
  return `**${lead} Full ${section.label} listing:** ${pageCount > 1 ? `${links.join(' · ')} (newest first)` : links[0]}`;
}

function renderBlockWith(exp, state, nowMs, { compact, bySection, limit = Infinity, pages = new Map() }) {
  const open = Object.values(state.open);
  const closed = Object.values(state.closed);
  const companies = new Set(open.map((j) => j.company)).size;
  const autopilot = pageLink(exp, 'autopilotUrl', 'autopilot');
  // alertsUrl: null = public alert signup not live → no email link (older
  // exports without the field fall back to the /l page anchor).
  const alerts = exp.alertsUrl === null ? null : pageLink(exp, 'alertsUrl', 'alerts', '#alerts');
  const out = [START, '<!-- Generated daily by scripts/generate.mjs. Edits inside these markers are overwritten. -->', ''];

  out.push(
    `**${plural(open.length, 'open role')}** at **${plural(companies, 'company', 'companies')}** · ✅ Verified open ${longDate(nowMs)} <!-- updated:${new Date(nowMs).toISOString()} -->`,
  );
  out.push('');
  out.push(
    '> Every role here is re-checked against the employer’s careers site daily. Closed roles drop off.',
  );
  out.push('');
  if (autopilot) out.push(`**Apply to all of these with Autopilot:** [set it up once on Aplyr](${autopilot}) and it applies for you as new roles open.`, '');
  // Owner 2026-10-18: no RSS line in the READMEs (the feed itself stays up).
  if (alerts) out.push(`**Get new roles by [email](${alerts})**, no account needed.`, '');

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
    const rows = bySection.get(s.key) ?? [];
    out.push(`## ${sectionHeading(s)}`, '');
    if (!rows.length) out.push('_Nothing open in this section right now. New postings show up here within a day._');
    else {
      const shown = Math.min(rows.length, limit);
      if (shown) out.push(renderOpenTable(rows, { showLevel: !!exp.showLevel, nowMs, compact, limit: shown }));
      // Cut section → link its full listing pages.
      if (shown < rows.length) out.push('', moreLine(s, shown, rows.length, pages.get(s.key) ?? 1));
    }
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
- When a section gets long, the README shows its newest roles and links to the section's full listing.

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

/** The export URL this generator reads: the configured one with `v=2`
 *  (every open row). Without it the API serves a capped v1 export, kept for
 *  repos still on the older generator. */
export function exportUrlV2(url) {
  const u = new URL(url);
  u.searchParams.set('v', '2');
  return u.toString();
}

export async function fetchExport(url, { attempts = 3, timeoutMs = 60000 } = {}) {
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
  const exp = validateExport(fixture ? JSON.parse(await readFile(fixture, 'utf8')) : await fetchExport(exportUrlV2(config.exportUrl)));

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
  const { block, files } = renderOutputs(exp, state, nowMs);
  const readme = existsSync(readmeFile) ? await readFile(readmeFile, 'utf8') : null;
  const current = readme ? extractBlock(readme) : null;

  // Listing pages: write the ones that changed, delete generated ones no
  // longer needed (only files carrying PAGE_MARKER are ever touched).
  const existing = await generatedPages(dir);
  const writes = [];
  for (const [rel, md] of files) if (existing.get(rel) !== md) writes.push([rel, md]);
  const stale = [...existing.keys()].filter((rel) => !files.has(rel));

  if (current && sameListings(prev, state) && stableBlock(current) === stableBlock(block) && !writes.length && !stale.length) {
    log('No listing changes.');
    return { changed: false, reason: 'unchanged' };
  }

  const next = readme ? replaceBlock(readme, block) : null;
  await mkdir(path.dirname(stateFile), { recursive: true });
  if (writes.length) await mkdir(path.join(dir, LISTINGS_DIR), { recursive: true });
  for (const [rel, md] of writes) await writeFile(path.join(dir, rel), md);
  for (const rel of stale) await unlink(path.join(dir, rel));
  await writeFile(readmeFile, next ?? (readme ? `${readme.trimEnd()}\n\n${block}\n` : initialReadme(exp, block)));
  await writeFile(stateFile, `${JSON.stringify(state, null, 1)}\n`);
  log(
    `Updated: ${Object.keys(state.open).length} open, ${Object.keys(state.closed).length} recently closed, ${files.size} listing page(s)` +
      (stale.length ? `, ${stale.length} removed` : '') +
      '.',
  );
  return { changed: true, reason: readme ? 'updated' : 'created' };
}

/** Generated listing pages on disk: Map(relative path → content). */
async function generatedPages(dir) {
  const out = new Map();
  const folder = path.join(dir, LISTINGS_DIR);
  if (!existsSync(folder)) return out;
  for (const name of await readdir(folder)) {
    if (!/^[a-z0-9-]+\.md$/.test(name)) continue;
    const text = await readFile(path.join(folder, name), 'utf8');
    if (text.startsWith(PAGE_MARKER)) out.set(`${LISTINGS_DIR}/${name}`, text);
  }
  return out;
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
