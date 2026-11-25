"""Extract reference data + sample event from the workbook into JSON."""
import json, re, sys, datetime
import openpyxl

wb = openpyxl.load_workbook(sys.argv[1])

def fix(s):
    if s is None:
        return None
    s = str(s).strip()
    # workbook has a corrupted find/replace "U" -> "Under " in places
    s = s.replace('JUnder nior', 'Junior').replace('IUnder AA', 'IUAA').replace('JUnder N', 'JUN')
    s = s.replace('SEnior', 'Senior').replace('U11Girls', 'U11 Girls')
    return s

def dob_rule(f):
    if not f or not isinstance(f, str) or not f.startswith('=DATE('):
        return None
    m = re.match(r'=DATE\(COMPYEAR([+-]\d+)?-D\d+([+-]\d+)?,(\d+),(\d+)\)', f)
    if not m:
        return None
    off = int(m.group(1) or 0) + int(m.group(2) or 0)
    return {'yearOffset': off, 'month': int(m.group(3)), 'day': int(m.group(4))}

# ---- age categories
cfg = wb['config_ccrr']
cats = []
for r in cfg.iter_rows(min_row=2, values_only=True):
    name = fix(r[0])
    if not name or name.startswith('='):
        continue
    num = lambda v: int(v) if isinstance(v, (int, float)) else 0
    age = r[3] if isinstance(r[3], (int, float)) else None
    cats.append({
        'name': name,
        'code': fix(r[1]) or '',
        'gender': r[2] or '',
        'age': age,
        'dobFrom': dob_rule(r[4]),
        'dobTo': dob_rule(r[5]),
        'ccDistance': r[6] or '',
        'rrDistance': r[7] or '',
        'cc': {'club': num(r[8]), 'clubMulti': bool(num(r[9])), 'county': num(r[10]), 'countyMulti': bool(num(r[11])),
               'province': num(r[12]), 'provinceMulti': bool(num(r[13]))},
        'rr': {'club': num(r[14]), 'clubMulti': bool(num(r[15])), 'county': num(r[16]), 'countyMulti': bool(num(r[17])),
               'province': num(r[18]), 'provinceMulti': bool(num(r[19]))},
    })
# combined categories: athletes are ranked inside the other categories of the race (from CCScorer.SeparateIndividualResults)
for c in cats:
    n = c['name']
    c['noOwnRanking'] = False
    c['scoresIn'] = []
    if n in ('Novice & U23 Men', 'Novice & U23 Women', 'Senior & Novice Men', 'Senior & Novice Women'):
        c['noOwnRanking'] = True; c['scoresIn'] = ['*']
    elif n.startswith('Intermediate & Masters'):
        c['noOwnRanking'] = True; c['scoresIn'] = [n.replace('Intermediate & ', '')]

# ---- teams
ct = wb['config_team']
teams = {}
for r in ct.iter_rows(min_row=2, max_col=4, values_only=True):
    if r[0]:
        teams[fix(r[0])] = {'name': fix(r[0]), 'code': (r[1] or '').replace('\xa0', '').strip(),
                            'county': fix(r[2]) or '', 'province': fix(r[3]) or ''}
masters = [fix(r[0]) for r in ct.iter_rows(min_row=2, min_col=10, max_col=10, values_only=True) if r[0]]

# ---- intro
intro = wb['Intro']
iv = {intro.cell(i, 1).value: intro.cell(i, 2).value for i in range(1, 16)}
def iso(d):
    return d.date().isoformat() if isinstance(d, datetime.datetime) else (d or '')

# ---- program
program = []
for r in wb['Program'].iter_rows(min_row=2, values_only=True):
    if r[0] is None or r[1] is None:
        continue
    ev = next((p for p in program if p['number'] == r[0]), None)
    if not ev:
        ev = {'number': r[0], 'categories': [], 'type': r[2] or 'CC', 'distance': r[3] or '',
              'time': str(r[4] or ''), 'day': str(r[5] or ''), 'date': iso(r[6])}
        program.append(ev)
    ev['categories'].append(fix(r[1]))

# ---- entries
entries = []
county_of = {}
for r in wb['Entries'].iter_rows(min_row=2, values_only=True):
    if not r[2]:
        continue
    e = {'id': r[0], 'name': fix(r[2]), 'category': fix(r[3]) or '', 'dob': iso(r[4]) if r[4] else '',
         'reg': str(r[5] or ''), 'team': fix(r[6]) or '', 'scoringTeam': fix(r[7]) or '',
         'county': fix(r[8]) or '', 'province': fix(r[9]) or '',
         'cc': 1 if r[10] == 1 else 0, 'rr': 1 if r[11] == 1 else 0,
         'mastersTeam': fix(r[12]) if len(r) > 12 else '', 'mastersCountyTeam': fix(r[13]) if len(r) > 13 else ''}
    e['mastersTeam'] = e['mastersTeam'] or ''
    e['mastersCountyTeam'] = e['mastersCountyTeam'] or ''
    entries.append(e)
    if e['team'] and e['county']:
        county_of[e['team']] = e['county']
for t, c in county_of.items():
    if t not in teams:
        teams[t] = {'name': t, 'code': '', 'county': c, 'province': 'Munster'}

counties = sorted({t['county'] for t in teams.values() if t['county']})
provinces = sorted({'Munster', 'Leinster', 'Connacht', 'Ulster'})

# ---- results (finish order + reference team results)
results = {}
ref = {}
for ws in wb.worksheets:
    if not ws.title.startswith('Results ') or ws.sheet_state != 'visible':
        continue
    cat = ws.title[len('Results '):]
    ev = next((p for p in program if cat in p['categories']), None)
    if not ev:
        continue
    order = []; rowinfo = []
    rows = list(ws.iter_rows(min_row=2, values_only=True))
    for r in rows:
        if r[0] is None:
            break
        t = str(r[1]).strip() if r[1] is not None else ''
        if not re.match(r'^\d{1,2}:\d{2}(:\d{2})?([.,]\d+)?$', t): t = ''
        order.append({'id': r[0], 'time': t})
        rowinfo.append({'id': r[0], 'name': fix(r[3]), 'team': fix(r[4]), 'scoringTeam': fix(r[5]), 'county': fix(r[6]), 'category': fix(r[8])})
    results[str(ev['number'])] = order
    section = None; teams_out = {}
    for r in rows:
        if r[3] in ('Club Team Points', 'County Team Points', 'Province Team Points'):
            section = r[3]; teams_out[section] = []; continue
        if section and isinstance(r[2], int) and r[3]:
            teams_out[section].append({'place': r[2], 'name': r[3], 'positions': r[4], 'points': r[6]})
    teams_out['rows'] = rowinfo
    ref[str(ev['number'])] = teams_out

seed = {
    'ageCategories': cats,
    'mastersTeamCategories': masters,
    'teams': sorted(teams.values(), key=lambda t: t['name'].lower()),
    'counties': counties,
    'provinces': provinces,
}
sample = {
    'format': 'xc-meet-manager', 'version': 1,
    'settings': {
        'title': iv.get('Event') and fix(iv['Event']).replace(' ,', ','), 'venue': iv.get('Venue') or '',
        'date': iso(iv.get('Date')), 'time': str(iv.get('Time') or ''),
        'startId': iv.get('Starting ID Number') or 1, 'autoNumber': iv.get('Auto ID Number') == 'Auto Number',
        'year': iv.get('Year Of Competition'), 'compType': 'CC',
        'regionLevel': iv.get('Competition Region Level') or 'Provincial',
        'region': iv.get('Competition Region') or '', 'checkInExtraRows': 5,
    },
    'program': program, 'entries': entries, 'results': results,
}
json.dump(seed, open(sys.argv[2], 'w'), ensure_ascii=False, indent=1)
json.dump(sample, open(sys.argv[3], 'w'), ensure_ascii=False, indent=1)
json.dump(ref, open(sys.argv[4], 'w'), ensure_ascii=False, indent=1)
print(len(cats), 'cats', len(teams), 'teams', len(program), 'events', len(entries), 'entries',
      {k: len(v) for k, v in results.items()})
