# XC Organiser

A Windows-first app for running cross-country and road-race athletics meets. It replaces the Munster Athletics *Horse & Jockey* Excel workbook (`.xlsm`), so you no longer need Excel or macros.

It's a Windows app that works offline and keeps meets in sync between computers through OneDrive. The same app also runs as a single HTML file in Edge or Chrome on any OS, but without sync.

## Features

- **Meets library**: create a meet with just a name and date. Older meets stay listed by year to reopen, reprint or copy for next year.
- **Import Excel workbooks**: turn an existing meet workbook (the original `.xlsm` layout) into a meet. This brings in competition details, races, athletes, results, clubs, age categories and team sizes, plus late entries typed only on the results sheets.
- **Program**: races with one or more age categories each. Combined races are still ranked and team-scored per category.
- **Athletes**: copy from Excel, Google Sheets or a website and press **Ctrl+V**. Columns, clubs and age categories are matched automatically. You confirm anything uncertain, and those choices are remembered. `.xlsx` and `.csv` files can be imported directly.
- **Checks**: duplicate numbers, unknown clubs, counties and categories, and possible duplicate athletes. Simple spelling differences can be fixed in one click.
- **Lists**: booklet, club lists and check-in sheets. Print them or export to Excel or CSV.
- **Results**: type bib numbers in finishing order, or paste the timing system's list. Unknown numbers, duplicates and wrong-race runners are flagged.
- **Scoring**: club, county, province and masters teams, with optional B/C teams. Team size is set per age category. Lowest total wins, and ties are split by the last scoring runner.
- **Export**: everything goes to a real `.xlsx`, and you can back up all meets to one file.
- **Sync between computers** (Windows app): meets are mirrored to a OneDrive folder. It works offline at events and catches up when back online. If the same meet is edited on two computers, nothing is lost: the later version wins and the earlier one is kept as a copy.

## Installing (Windows)

Download **[XC-Organiser-setup.exe](https://github.com/flesheatingbug/meetmanager/releases/download/latest-windows/XC-Organiser-setup.exe)** (from the [latest release](https://github.com/flesheatingbug/meetmanager/releases/latest)) and run it. It installs per user, so no admin rights are needed. The installer isn't code-signed, so SmartScreen may warn: choose **More info → Run anyway**.

**Updates are automatic.** The app checks on startup and every few hours, downloads new versions in the background (checking the installer's SHA-256 against the release's `latest.json`), and shows **↺ Restart to update**. Clicking it closes the app, installs silently and reopens it. There's also **Check for updates** at the bottom of the Meets screen.

When it first opens, it offers to sync through OneDrive. Turn it on with the same folder on every computer.

**Moving from the browser version (v1.0–1.2):** in the old version use **Meets → Back up all meets**, then in the app use **Meets → Import meet file…**. Do this on one computer and sync brings it to the others.

### Browser version (no install, no sync)

The [`app`](app/) folder still works on its own. Run `Start XC Organiser.bat` (Windows) or `start-linux.sh`. Meets are stored in that browser window's profile, so use **Back up all meets** regularly.

## How sync works

Each meet is one file, `<id>.json`, in the sync folder. The app's own local database is always the main copy, so nothing depends on the folder being reachable. Every save gets a new revision ID, and each file records the revisions it was built from. When the app runs (at start, every 15 s, and after changes), it compares the two sides:

- **Folder version builds on ours**: take it. The open meet updates live, but not while someone is typing.
- **Ours is newer**: write it to the folder.
- **Edited separately on both computers** (e.g. laptop offline at an event): the later edit becomes the meet, and the earlier one becomes a separate *kept copy* meet. Both computers reach the same result independently.
- **Deleted on one computer**: deleted on the other too, unless it was edited there in the meantime (edits beat deletes).
- **Extra copies left by OneDrive** (`<id>-LAPTOP.json`): read, resolved and tidied away.

The rules are in `planSync()` in `src/core.js`, with tests in `tests/run.js`.

## Project layout

```
app/        Browser version: XC-Organiser.html + launchers + user README
src-tauri/  Windows app shell (Tauri 2, Rust): sync-folder access, Save dialogs
.github/    CI: builds the installer and publishes the rolling latest-windows release
src/        Source: index.html (shell), styles.css, core.js (logic), app.js (UI)
data/       seed.json (age categories, team sizes, clubs, counties)
            sample-event.json (example meet, names replaced with made-up ones)
tests/      node tests/run.js — scoring & matching checks
tools/      make_seed.py (extract reference data from the .xlsm),
            vba_extract.py (dump the workbook's VBA macros),
            anonymise_sample.py
build.py    Inlines src/ + data/ into app/XC-Organiser.html
```

`core.js` has no DOM dependencies. It handles parsing pasted tables, matching clubs and categories, validation, scoring, and reading and writing `.xlsx` files. `app.js` is the UI, written in vanilla JS with no build step other than `build.py`.

## Development

```sh
python build.py        # rebuild app/XC-Organiser.html and tauri-dist/
node tests/run.js      # run the tests
npx @tauri-apps/cli@2 dev     # run the Windows app from source (needs Rust)
npx @tauri-apps/cli@2 build   # build the installer locally
```

Re-run `build.py` after editing anything in `src/` or `data/`, and commit the rebuilt `app/XC-Organiser.html`.

**Releases:** every push to `main` builds the installer on GitHub Actions and replaces the rolling **`latest-windows`** release (`XC-Organiser-setup.exe` + `latest.json`). Installed apps pick it up automatically. Versions are `major.minor` from `src-tauri/tauri.conf.json` plus the build number as the patch (e.g. `1.4.12`). Bump `major.minor` there for bigger releases.

To refresh the reference data from a newer workbook:

```sh
python tools/make_seed.py workbook.xlsm data/seed.json private-sample.json reference.json
python tools/anonymise_sample.py private-sample.json data/sample-event.json
```

The extracted sample contains real athletes' names. Only commit the anonymised version.

## Scoring rules (from the workbook's macros)

- Positions are finishing positions in the race. An unknown or wrong-race number still takes a position by default (this can be changed in Competition settings), but never scores.
- A team scores the positions of its first *N* finishers, where *N* comes from the age category's club, county or province setting. Teams with fewer than *N* finishers are not placed.
- With multi-team on, a club's next *N* finishers form a B team, then a C team, and so on.
- In combined races, each category is ranked and scored separately. Categories marked *Combined* (e.g. *Novice & U23 Men*) are ranked inside the race's other categories.
- County teams are scored at Provincial or National level, province teams at National level.
