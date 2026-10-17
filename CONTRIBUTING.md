# Contributing

Thanks for helping keep this list accurate. A few things to know first.

## The tables are generated

Everything between the `APLYR:LISTINGS` markers in `README.md` is rebuilt every day by `scripts/generate.mjs` from [Aplyr](https://aplyr.ai)'s job index. Pull requests that edit rows by hand will be overwritten on the next run, so please open an issue instead. Fixes to the index show up here automatically the next day.

Text outside the markers (this file, the intro, the how-to) is written by people, and PRs to it are welcome.

## Reporting a listing

Open an issue using the **Report a listing** template if a role:

- is closed or the link is broken,
- is a duplicate of another row,
- doesn't belong on this list (wrong season, not entry level, outside the U.S.),
- has the wrong sponsorship or citizenship badge.

Include the company and role title, plus what's wrong. A link to the employer's own posting helps a lot.

## Suggesting a company or role

If a company you care about is missing, open an issue with the name and a link to its careers page. We add sources in batches, and once a company is in the index its new roles appear here on their own.

## How rows are chosen

- U.S. roles only, newest first, deduplicated (one row per company and title, with all locations listed).
- Postings come from employers' own careers sites, and a role leaves the main table as soon as it stops being listed.
- "Recently closed" keeps closed roles for 14 days so you can tell a role closed rather than vanished.
- Undated titles count as this cycle's roles only when they were posted inside the current recruiting window and don't name another term (fall, spring, winter, co-op, another year).
- Badges: `Sponsors visas` the company has sponsored H-1B visas before (a company-level signal), `No sponsorship` the posting itself rules it out, `U.S. citizens` the title asks for U.S. citizenship or a clearance, 🆕 added in the last 48 hours.
