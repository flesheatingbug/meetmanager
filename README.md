# XC Meet Manager

A Windows-first app for running cross-country and road-race athletics meets. It replaces the Munster Athletics *Horse & Jockey* Excel workbook (`.xlsm`), so you no longer need Excel or macros.

It's a single offline HTML file that opens in its own Microsoft Edge window. There's nothing to install, and it also runs on Linux.

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

## Using it (Windows)

1. Download the [`app`](app/) folder (or the repo as a ZIP) and put it somewhere permanent.
2. Double-click **`Start XC Meet Manager.bat`**. It opens in its own Edge or Chrome window.
3. Optional: run **`Create desktop shortcut.bat`** to get a desktop icon.

Meets are stored with the app's window (IndexedDB in a dedicated browser profile under `%LOCALAPPDATA%\XCMeetManager`). Always open the app with the launcher or shortcut. Use **Back up all meets** after each meet.

On Linux, run `app/start-linux.sh`. It uses Edge, Chrome, Chromium or Brave.

## Project layout

```
app/        Ready-to-run app: XC-Meet-Manager.html + launchers + user README
src/        Source: index.html (shell), styles.css, core.js (logic), app.js (UI)
data/       seed.json (age categories, team sizes, clubs, counties)
            sample-event.json (example meet, names replaced with made-up ones)
tests/      node tests/run.js — scoring & matching checks
tools/      make_seed.py (extract reference data from the .xlsm),
            vba_extract.py (dump the workbook's VBA macros),
            anonymise_sample.py
build.py    Inlines src/ + data/ into app/XC-Meet-Manager.html
```

`core.js` has no DOM dependencies. It handles parsing pasted tables, matching clubs and categories, validation, scoring, and reading and writing `.xlsx` files. `app.js` is the UI, written in vanilla JS with no build step other than `build.py`.

## Development

```sh
python build.py        # rebuild app/XC-Meet-Manager.html
node tests/run.js      # run the tests
```

Then open `app/XC-Meet-Manager.html` in Edge or Chrome. Re-run `build.py` after editing anything in `src/` or `data/`, and commit the rebuilt HTML.

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
