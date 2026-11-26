// Run with:  node tests/run.js
// Checks the scoring engine and the paste/matching helpers. No dependencies.
const assert = require('assert');
const XC = require('../src/core.js');
const seed = require('../data/seed.json');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('ok -', name); };

// A small invented race: club teams of 3, county teams of 4.
const cat = (name, gender, club, county) => ({ name, gender, cc: { club, clubMulti: false, county, countyMulti: false, province: 6, provinceMulti: false }, rr: {} });
const race = {
  settings: { regionLevel: 'Provincial', unknownTakesPosition: true },
  ageCategories: [cat('Test Girls', 'W', 3, 4), cat('Test Boys', 'M', 2, 4)],
  mastersTeamCategories: [],
  entries: [
    ['Alpha', 'Cork'], ['Bravo', 'Cork'], ['Alpha', 'Cork'], ['Charlie', 'Kerry'], ['Bravo', 'Cork'], ['Alpha', 'Cork'],
    ['Charlie', 'Kerry'], ['Bravo', 'Cork'], ['Charlie', 'Kerry'], ['Alpha', 'Cork'], ['Bravo', 'Cork'],
  ].map(([team, county], i) => ({ id: i + 1, name: 'Runner ' + (i + 1), category: 'Test Girls', team, scoringTeam: team, county }))
    .concat([{ id: 50, name: 'Boy A', category: 'Test Boys', team: 'Alpha', scoringTeam: 'Alpha', county: 'Cork' },
      { id: 51, name: 'Boy B', category: 'Test Boys', team: 'Alpha', scoringTeam: 'Alpha', county: 'Cork' }]),
};
const finish = ids => ids.map(id => ({ id: String(id), time: '' }));

test('club and county team scoring', () => {
  const res = XC.scoreEvent(race, { number: 1, categories: ['Test Girls'] }, finish([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]));
  const g = res.groups[0];
  assert.deepStrictEqual(g.teams.club.map(t => [t.name, t.positions.join(','), t.points]), [['Alpha', '1,3,6', 10], ['Bravo', '2,5,8', 15], ['Charlie', '4,7,9', 20]]);
  assert.deepStrictEqual(g.teams.county.map(t => [t.name, t.points]), [['Cork', 11]]); // Kerry has only 3 finishers
});

test('unknown numbers take a place but never score; duplicates are ignored', () => {
  const res = XC.scoreEvent(race, { number: 1, categories: ['Test Girls'] }, finish([1, 999, 2, 3, 2, 4, 5, 6, 7, 8, 9]));
  assert.deepStrictEqual(res.lines.map(l => l.pos), [1, 2, 3, 4, null, 5, 6, 7, 8, 9, 10]);
  assert.strictEqual(res.errors, 2);
  assert.deepStrictEqual(res.groups[0].teams.club.map(t => [t.name, t.points]), [['Alpha', 12], ['Bravo', 18], ['Charlie', 23]]);
});

test('combined race ranks each category separately', () => {
  const res = XC.scoreEvent(race, { number: 1, categories: ['Test Girls', 'Test Boys'] }, finish([50, 1, 2, 51, 3]));
  const boys = res.groups.find(g => g.category === 'Test Boys'), girls = res.groups.find(g => g.category === 'Test Girls');
  assert.deepStrictEqual(boys.results.map(r => [r.pos, r.overall]), [[1, 1], [2, 4]]);
  assert.deepStrictEqual(girls.results.map(r => [r.pos, r.overall]), [[1, 2], [2, 3], [3, 5]]);
  assert.deepStrictEqual(boys.teams.club.map(t => [t.name, t.points]), [['Alpha', 3]]);
});

test('incomplete teams are dropped and ties split on last scorer', () => {
  const entries = [['A', 1], ['B', 2], ['A', 3], ['B', 4], ['C', 5], ['A', 6], ['B', 5]]
    .map(([team], i) => ({ id: i + 1, team, category: 'X' }));
  const results = entries.map((e, i) => ({ pos: i + 1, entry: e }));
  const t = XC.computeTeams(results.slice(0, 6), 'club', 2, false);
  assert.deepStrictEqual(t.map(x => [x.name, x.points]), [['A', 4], ['B', 6]]);
  const tie = XC.computeTeams([{ pos: 1, entry: { team: 'A' } }, { pos: 2, entry: { team: 'B' } }, { pos: 3, entry: { team: 'B' } }, { pos: 4, entry: { team: 'A' } }], 'club', 2, false);
  assert.deepStrictEqual(tie.map(x => x.name), ['B', 'A']); // both 5 points, B's last scorer was 3rd
});

test('B teams are formed when multi-team is on', () => {
  const r = [1, 2, 3, 4].map(p => ({ pos: p, entry: { team: 'A' } }));
  assert.deepStrictEqual(XC.computeTeams(r, 'club', 2, true).map(t => t.name), ['A', 'A B']);
});

test('category matching from pasted text', () => {
  const m = XC.makeCategoryMatcher(seed.ageCategories);
  assert.strictEqual(m('U12 Girls'), 'U12 Girls');
  assert.strictEqual(m('girls u12'), 'U12 Girls');
  assert.strictEqual(m('Under 12 Girls'), 'U12 Girls');
  assert.strictEqual(m('U12', 'F'), 'U12 Girls');
  assert.strictEqual(m('U14', 'Boys'), 'U14 Boys');
  // shorthand used in club spreadsheets
  for (const [txt, want] of [['U12G', 'U12 Girls'], ['U12B', 'U12 Boys'], ["U12's Girls", 'U12 Girls'], ['M35', 'Masters Men O35'], ['W40', 'Masters Women O40'],
    ['O35 Men', 'Masters Men O35'], ['Masters Men 35', 'Masters Men O35'], ['Snr Women', 'Senior Women'], ['Snr Girls', 'Senior Girls'], ['Jnr Boys', 'Junior Boys']]) assert.strictEqual(m(txt), want, txt);
  assert.strictEqual(m('U12'), '');                        // no gender: can't tell
  const prefer = XC.makeCategoryMatcher(seed.ageCategories, new Set(['U12 Girls']));
  assert.strictEqual(prefer('U12'), 'U12 Girls');          // only one U12 race on the program
});

test('club matching tolerates spelling differences', () => {
  const m = XC.makeClubMatcher(seed.teams);
  assert.strictEqual(m('leevale ac').team.name, 'Leevale A.C.');
  assert.strictEqual(m('Bandon A.C').team.name, 'Bandon A.C.');
  assert.ok(m('Carrig na bhFear').team.name.startsWith('Carraig'));
});

test('names and dates', () => {
  assert.deepStrictEqual(XC.splitFullName('MURPHY Tess'), ['Tess', 'MURPHY']);
  assert.deepStrictEqual(XC.splitFullName('Smith, John'), ['John', 'Smith']);
  assert.strictEqual(XC.formatName('aoife', "o'brien", true), "aoife O'BRIEN");
  assert.strictEqual(XC.parseDate('03/05/2014'), '2014-05-03');
  assert.strictEqual(XC.parseDate('3-May-14'), '2014-05-03');
  assert.strictEqual(XC.parseDate(41762), '2014-05-03');
});

test('importing a meet workbook (Horse & Jockey layout)', () => {
  const sheets = [
    { name: 'Intro', state: 'visible', rows: [['Event', 'Test Meet'], ['Venue', 'Conna'], ['Date', 45942], ['Time', 11], ['Starting ID Number', 1], ['Auto ID Number', 'Auto Number'], ['Year Of Competition', 2025], ['Competition Region Level', 'Provincial'], ['Competition Region', 'Munster']] },
    { name: 'Program', state: 'visible', rows: [['Event', 'Age Category', 'Type', 'Distance', 'Time'], [1, 'U10 Girls', 'CC', '1000m', ''], [2, 'U18 Girls', 'CC', '4000m', ''], [2, 'U20 Girls', 'CC', '4000m', '']] },
    { name: 'Entries', state: 'visible', rows: [['ID', 'Comp #', 'Name', 'Age Category', 'DOB', 'Reg #', 'Team', 'Team Scoring Name', 'County', 'Province', 'CC', 'RR', 'Masters', 'Masters County'],
      [1, 1, 'Ann ONE', 'U10 Girls', '', '', 'Leevale A.C.', 'Leevale A.C.', 'Cork', '', 1], [2, 2, 'Bea TWO', 'U10 Girls', 41762, 'R9', 'Bandon A.C.', 'Bandon A.C.', 'Cork', '', 1]] },
    { name: 'config_ccrr', state: 'visible', rows: [['Name'], ['U10 Girls', 'Under 10', 'W', 10, 42370, 42735, '1000m', '', 4, 0, 6, 0, 6, 0]] },
    { name: 'config_team', state: 'visible', rows: [['Name'], ['Leevale A.C.', 'LEEV', 'Cork', 'Munster'], ['Bandon A.C.', 'BAND', 'Cork', 'Munster']] },
    { name: 'Results U10 Girls', state: 'visible', rows: [['ID', 'Time'], [2, 0.003125], [9, '', '', 'Late RUNNER', 'Leevale A.C.', 'Leevale A.C.', 'Cork', '', 'U10 Girls'], [1, '']] },
    { name: 'Results Old', state: 'hidden', rows: [['ID'], [1]] },
  ];
  assert.ok(XC.isMeetWorkbook(sheets));
  const { meet, report } = XC.importWorkbook(sheets);
  assert.strictEqual(meet.settings.title, 'Test Meet');
  assert.strictEqual(meet.settings.date, '2025-10-12');
  assert.strictEqual(meet.settings.time, '11:00');
  assert.deepStrictEqual(meet.program[1].categories, ['U18 Girls', 'U20 Girls']);
  assert.strictEqual(meet.entries[1].dob, '2014-05-03');
  assert.deepStrictEqual(meet.results['1'], [{ id: '2', time: '4:30' }, { id: '9', time: '' }, { id: '1', time: '' }]);
  assert.deepStrictEqual(report.lateEntries.map(e => [e.id, e.name, e.category]), [[9, 'Late RUNNER', 'U10 Girls']]);
  assert.deepStrictEqual(meet.ageCategories[0].cc, { club: 4, clubMulti: false, county: 6, countyMulti: false, province: 6, provinceMulti: false });
  assert.deepStrictEqual(meet.ageCategories[0].dobFrom, { yearOffset: 1, month: 1, day: 1 });
  assert.strictEqual(report.resultSheets, 1); // hidden sheet ignored
});

test('sync planning', () => {
  const plan = (locals, remotes) => XC.planSync(new Map(Object.entries(locals)), remotes).map(a => [a.type, a.file || a.from || '', a.to || '', a.merged && a.merged.length ? '+' + a.merged.join(',') : ''].filter(Boolean).join(' '));
  const R = (id, rev, at, ancestors = [], extra = {}) => ({ file: id + '.json', id, rev, updatedAt: at, ancestors, ...extra });
  const M = (rev, baseRev, dirty, at, history = [], extra = {}) => ({ rev, baseRev, dirty, at, history: baseRev ? [...history, baseRev] : history, ...extra });
  // new on this PC -> push; new in folder -> pull; in sync -> nothing
  assert.deepStrictEqual(plan({ a: M('r1', null, true, 't1') }, []), ['push']);
  assert.deepStrictEqual(plan({}, [R('b', 'x1', 't1')]), ['pull b.json']);
  assert.deepStrictEqual(plan({ a: M('r1', 'r1', false, 't1') }, [R('a', 'r1', 't1')]), []);
  // edited here -> push; newer version from the other PC (built on ours) -> pull
  assert.deepStrictEqual(plan({ a: M('r2', 'r1', true, 't2') }, [R('a', 'r1', 't1')]), ['push']);
  assert.deepStrictEqual(plan({ a: M('r1', 'r1', false, 't1') }, [R('a', 'r2', 't2', ['r1'])]), ['pull a.json']);
  // several edits there since we last looked
  assert.deepStrictEqual(plan({ a: M('r1', 'r1', false, 't1') }, [R('a', 'r4', 't4', ['r1', 'r2', 'r3'])]), ['pull a.json']);
  // an older copy of ours turning up (e.g. OneDrive restore) is ignored, then ours is re-written
  assert.deepStrictEqual(plan({ a: M('r3', 'r3', false, 't3', ['r1', 'r2']) }, [R('a', 'r2', 't2', ['r1'])]), ['push']);
  // edited separately on both: newer wins, older kept as a copy — same result on both PCs
  assert.deepStrictEqual(plan({ a: M('L2', 'r1', true, 't5') }, [R('a', 'D2', 't3', ['r1'])]), ['copyRemote a.json', 'push +D2']);
  assert.deepStrictEqual(plan({ a: M('D2', 'r1', true, 't3') }, [R('a', 'L2', 't5', ['r1'])]), ['copyLocal a.json', 'pull a.json']);
  // the laptop case: it "pushed" to its own OneDrive folder while offline, so it isn't dirty
  assert.deepStrictEqual(plan({ a: M('L2', 'L2', false, 't5', ['r1']) }, [R('a', 'D2', 't3', ['r1'])]), ['copyRemote a.json', 'push +D2']);
  assert.deepStrictEqual(plan({ a: M('D2', 'D2', false, 't3', ['r1']) }, [R('a', 'D2', 't3', ['r1']), { ...R('a', 'L2', 't5', ['r1']), file: 'a-LAPTOP.json' }]),
    ['copyLocal a-LAPTOP.json', 'pull a-LAPTOP.json', 'copy a-LAPTOP.json a.json', 'remove a-LAPTOP.json']);
  // after the winner merged the loser, the other PC just takes it
  assert.deepStrictEqual(plan({ a: M('D2', 'D2', false, 't3', ['r1']) }, [R('a', 'L2', 't5', ['r1', 'D2'])]), ['pull a.json']);
  // deleted there, untouched here -> delete here; deleted there but edited here -> keep ours
  assert.deepStrictEqual(plan({ a: M('r1', 'r1', false, 't1') }, [R('a', 'd1', 't2', ['r1'], { deleted: true })]), ['deleteLocal a.json']);
  assert.deepStrictEqual(plan({ a: M('r2', 'r1', true, 't2') }, [R('a', 'd1', 't3', ['r1'], { deleted: true })]), ['push +d1']);
  // deleted here, untouched there -> push tombstone; deleted here but edited there -> keep theirs
  assert.deepStrictEqual(plan({ a: M('d2', 'r1', true, 't2', [], { deleted: true }) }, [R('a', 'r1', 't1')]), ['push']);
  assert.deepStrictEqual(plan({ a: M('d2', 'r1', true, 't2', [], { deleted: true }) }, [R('a', 'r5', 't3', ['r1'])]), ['pull a.json']);
  // file missing from the folder -> put it back
  assert.deepStrictEqual(plan({ a: M('r1', 'r1', false, 't1') }, []), ['push']);
  assert.strictEqual(XC.stableStringify({ b: 1, a: [1, { d: 2, c: 3 }] }), XC.stableStringify({ a: [1, { c: 3, d: 2 }], b: 1 }));
});

console.log(`\n${passed} tests passed`);
