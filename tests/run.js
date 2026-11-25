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

console.log(`\n${passed} tests passed`);
