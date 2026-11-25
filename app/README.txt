XC MEET MANAGER  v1.2
=====================
A Windows app for running cross-country and road-race meets. It does what the
"DAY 1 Horse & Jockey" Excel workbook does, without macros or Excel:
  - Competition setup, program of races (several age categories can share a race)
  - Athlete entries with automatic numbering
  - PASTE ATHLETES straight from a website, Excel, Google Sheets or CSV:
    columns, clubs and age categories are matched automatically
  - Checks entries (duplicate numbers, unknown clubs/counties/categories)
    and fixes simple spelling differences in one click
  - Booklet, club lists, check-in sheets (print or Excel)
  - Results by bib number in finishing order, or paste the timing system's list
  - Club, county, province and masters team scoring, B/C teams optional
  - Export everything to Excel

GETTING STARTED (Windows)
  1. Unzip this folder somewhere permanent, e.g. Documents\XC Meet Manager.
  2. Double-click "Start XC Meet Manager.bat".
     It opens in its own window using Microsoft Edge (already on Windows 10/11).
  3. Optional: double-click "Create desktop shortcut.bat" for a desktop icon.
  Nothing is installed and it works offline.

  Linux: run ./start-linux.sh (uses Edge, Chrome, Chromium or Brave).
  Any OS: you can also just open XC-Meet-Manager.html in Edge or Chrome.

MEETS
  - The Meets tab lists every meet, newest first (upcoming ones at the top,
    older ones grouped by year). Click one to open it.
  - "+ New meet" just asks for a name and date. You can copy the races and
    settings from an earlier meet, e.g. for next year's edition.
  - Clubs, age categories and remembered club spellings carry over from your
    most recent meet.
  - Everything saves automatically as you work.

IMPORTING AN OLD EXCEL MEET WORKBOOK
  Meets tab -> "Import Excel workbook..." -> choose the .xlsm/.xlsx.
  Competition details, races, athletes, results, clubs, age categories and
  team sizes all come across as a new meet. Athletes added only on a results
  sheet (late entries) are offered too. The workbook itself isn't changed.

BACKUPS
  - "Back up all meets" (Meets tab) saves every meet into one file. Do this
    after each meet and keep it somewhere safe, e.g. a USB stick or cloud drive.
  - "Import meet file..." restores a backup or a single meet on any PC.
  - "Export" next to a meet saves just that meet, to send to someone else.
  - Always open the app with the launcher/shortcut: your meets are stored with
    that window, so opening the HTML file another way shows an empty list.

COPYING ATHLETES FROM EXCEL (or a website)
  In Excel, select the athletes (include the heading row if there is one) and
  press Ctrl+C. In the app go to the Athletes tab and press Ctrl+V.
  Or use "Import file..." to read a whole .xlsx / .csv, every sheet at once.
  Headings such as "U12 Girls" or a club name above a group are understood.
  Anything it isn't sure about (a club spelled differently, say) is shown for you
  to confirm, and your choice is remembered next time.
  You can also just press Ctrl+V anywhere on the Athletes tab.

RESULTS
  Results tab -> pick the race -> type each bib number and press Enter.
  Unknown numbers, duplicates and athletes in the wrong race are flagged.
  Team scores update as you go: the first N finishers per club count
  (N is set per age category under Reference data), lowest total wins,
  ties are split by the last scoring runner.

Reference data (clubs, counties, age categories, team sizes) is pre-loaded from
the workbook and can be edited under "Reference data".
"Add an example meet" on the empty Meets screen loads a full example meet
(real clubs, numbers and results from a 2025 Munster meet, with made-up names).
