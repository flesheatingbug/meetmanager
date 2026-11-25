// Run with:  node tests/run.js
// Checks the scoring engine and the paste/matching helpers. No dependencies.
const assert = require('assert');
const XC = require('../src/core.js');
const seed = require('../data/seed.json');
const meet = require('../data/sample-event.json');
const expected = require('./expected-teams.json');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('ok -', name); };

const state = { ...seed, ...meet, entries: meet.entries.map(e => ({ ...e, scoringTeam: e.scoringTeam || e.team })) };

test('team scores for every race match the reference results', () => {
  for (const ev of meet.program) {
    const res = XC.scoreEvent(state, ev, meet.results[ev.number] || []);
    const got = res.groups.map(g => ({ category: g.category, club: g.teams.club.map(t => [t.name, t.points]), county: g.teams.county.map(t => [t.name, t.points]) }));
    assert.deepStrictEqual(got, expected[ev.number], `event ${ev.number}`);
  }
});

test('Novice Men (event 12) matches the workbook', () => {
  const ev = meet.program.find(p => p.number === 12);
  const g = XC.scoreEvent(state, ev, meet.results[12]).groups[0];
  assert.deepStrictEqual(g.teams.club[0].positions, [4, 6, 8, 18]);
  assert.strictEqual(g.teams.club[0].points, 36);
  assert.deepStrictEqual(g.teams.county.map(t => t.points), [69, 81, 91, 108]);
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

console.log(`\n${passed} tests passed`);
