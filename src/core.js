/* XC Meet Manager — core logic (no DOM). Works in browser and Node. */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- helpers
  const norm = s => String(s == null ? '' : s).replace(/ /g, ' ').replace(/[’`]/g, "'").replace(/\s+/g, ' ').trim();
  const lc = s => norm(s).toLowerCase();
  const stripAccents = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

  function levenshtein(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    let prev = new Array(n + 1), cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      [prev, cur] = [cur, prev];
    }
    return prev[n];
  }

  // ---------------------------------------------------------------- clubs
  const CLUB_NOISE = /\b(a\.?\s?c\.?|athletics?|athletic|club|harriers?|running|road ?runners?|track|triathlon|t\.?c\.?|r\.?c\.?|and|&|the)\b/g;
  function clubKey(name) {
    let s = stripAccents(lc(name)).replace(/[.']/g, '').replace(/[^a-z0-9& ]+/g, ' ');
    return s.replace(/\s+/g, ' ').trim();
  }
  function clubCore(name) {
    return clubKey(name).replace(CLUB_NOISE, ' ').replace(/\s+/g, ' ').trim();
  }

  /** Build a matcher over known club names. match(text) -> {team, score, exact} | null */
  function makeClubMatcher(teams, aliases) {
    const list = teams.map(t => ({ t, key: clubKey(t.name), core: clubCore(t.name), code: lc(t.code) }));
    const byKey = new Map(), byCore = new Map(), byCode = new Map();
    for (const x of list) {
      if (!byKey.has(x.key)) byKey.set(x.key, x.t);
      if (x.core && !byCore.has(x.core)) byCore.set(x.core, x.t);
      if (x.code) byCode.set(x.code, x.t);
    }
    const alias = new Map(Object.entries(aliases || {}).map(([k, v]) => [clubKey(k), v]));
    return function match(text) {
      const raw = norm(text);
      if (!raw) return null;
      const k = clubKey(raw);
      if (alias.has(k)) {
        const t = teams.find(t => t.name === alias.get(k));
        if (t) return { team: t, score: 1, exact: true };
      }
      if (byKey.has(k)) return { team: byKey.get(k), score: 1, exact: true };
      if (byCode.has(lc(raw))) return { team: byCode.get(lc(raw)), score: 1, exact: true };
      const core = clubCore(raw);
      if (core && byCore.has(core)) return { team: byCore.get(core), score: 0.97, exact: false };
      let best = null;
      for (const x of list) {
        if (!x.core || !core) continue;
        const d = levenshtein(core, x.core);
        const score = 1 - d / Math.max(core.length, x.core.length);
        let s2 = score;
        // prefix / containment bonus ("Leevale" vs "Leevale A.C.")
        if (x.core.startsWith(core) || core.startsWith(x.core)) s2 = Math.max(s2, 0.9);
        if (!best || s2 > best.score) best = { team: x.t, score: s2, exact: false };
      }
      return best && best.score >= 0.6 ? best : null;
    };
  }

  // ---------------------------------------------------------------- gender / categories
  function parseGender(v) {
    const s = lc(v);
    if (!s) return '';
    if (/^(m|male|man|men|boy|boys|b|mens?|m\/b)$/.test(s)) return 'M';
    if (/^(f|w|female|woman|women|girl|girls|g|ladies|womens?|f\/g)$/.test(s)) return 'W';
    return '';
  }

  const CAT_WORDS = { snr: 'senior', sen: 'senior', jnr: 'junior', jr: 'junior', jun: 'junior', int: 'inter', nov: 'novice',
    vets: 'masters', vet: 'masters', veterans: 'masters', master: 'masters', mst: 'masters', mas: 'masters' };
  function catTokens(text) {
    let s = stripAccents(lc(text))
      .replace(/under[\s-]*(\d+)/g, 'u$1').replace(/over[\s-]*(\d+)/g, 'o$1')
      .replace(/\b([uo])[\s-]+(\d+)/g, '$1$2')
      .replace(/\b([uo])(\d+)(?:'?s)\b/g, '$1$2')            // U12s / U12's
      .replace(/\b([uo])(\d+)([gbmfw])\b/g, '$1$2 $3')         // U12G / U12B / O35M
      .replace(/\b([mwf])(\d{2})\b/g, (m, g, n) => (+n >= 30 && +n <= 95 ? `masters ${g} o${n}` : m)) // M35 / W40 / F45
      .replace(/[^a-z0-9& ]+/g, ' ');
    const out = new Set();
    let gender = '', style = '';
    for (let w of s.split(/\s+/)) {
      if (!w || w === '&' || w === 'and') continue;
      w = CAT_WORDS[w] || w;
      const g = parseGender(w);
      if (/^(men|mens|women|womens|ladies|male|female)$/.test(w)) style = 'adult';
      else if (/^(boys|girls|boy|girl)$/.test(w)) style = 'youth';
      if (g) { gender = gender && gender !== g ? 'X' : g; continue; }
      out.add(w);
    }
    // "Masters Men 35" -> o35
    if (out.has('masters')) for (const w of [...out]) if (/^\d{2}$/.test(w) && +w >= 30 && +w <= 95) { out.delete(w); out.add('o' + w); }
    return { tokens: out, gender, style };
  }

  /** match(text, genderHint) -> category name or ''. prefer: Set of names to favour when several fit (e.g. on the program). */
  function makeCategoryMatcher(cats, prefer) {
    const exact = new Map(cats.map(c => [lc(c.name), c.name]));
    const list = cats.map(c => {
      const t = catTokens(c.name);
      return { name: c.name, tokens: t.tokens, gender: c.gender || t.gender, style: t.style, code: lc(c.code) };
    });
    const pick = (cands, g, style) => {
      if (cands.length > 1 && g) { const gc = cands.filter(c => c.gender === g); if (gc.length) cands = gc; }
      if (cands.length > 1 && style) { const sc = cands.filter(c => c.style === style); if (sc.length) cands = sc; }
      if (cands.length > 1 && prefer && prefer.size) { const pc = cands.filter(c => prefer.has(c.name)); if (pc.length) cands = pc; }
      return cands.length === 1 ? cands[0].name : '';
    };
    return function match(text, genderHint) {
      const raw = norm(text);
      if (!raw) return '';
      if (exact.has(lc(raw))) return exact.get(lc(raw));
      const t = catTokens(raw);
      const g = (t.gender === 'X' ? '' : t.gender) || parseGender(genderHint);
      // team categories (e.g. "Men O35 Team") are only for team scoring, never an athlete's own category
      const pool = list.filter(c => (t.tokens.has('team') || !c.tokens.has('team')) && (!g || !c.gender || c.gender === g));
      const same = (a, b) => a.size === b.size && [...a].every(x => b.has(x));
      let cands = pool.filter(c => same(c.tokens, t.tokens));
      if (!cands.length && t.tokens.size) {
        // text tokens are a subset (e.g. "U12" + gender, "O35 Men" -> Masters Men O35)
        cands = pool.filter(c => [...t.tokens].every(x => c.tokens.has(x)) && (!g || c.gender === g));
        if (cands.length > 1) { const min = Math.min(...cands.map(c => c.tokens.size)); cands = cands.filter(c => c.tokens.size === min); }
      }
      return pick(cands, g, t.style);
    };
  }

  function catDobRange(cat, year) {
    if (!cat.dobFrom || !cat.dobTo || cat.age == null) return null;
    const mk = r => new Date(Date.UTC(year + r.yearOffset - cat.age, r.month - 1, r.day));
    // offsets are relative to (year - age); stored as yearOffset where date year = year + yearOffset - age
    return [mk(cat.dobFrom), mk(cat.dobTo)];
  }

  /** Pick the narrowest category whose DOB range contains dob, matching gender. preferNames: categories in program. */
  function categoryFromDob(cats, dobIso, gender, year, preferNames) {
    if (!dobIso || !gender) return '';
    const d = new Date(dobIso + 'T00:00:00Z');
    if (isNaN(d)) return '';
    let best = null;
    for (const c of cats) {
      if (c.gender !== gender) continue;
      const r = catDobRange(c, year);
      if (!r || d < r[0] || d > r[1]) continue;
      const span = r[1] - r[0];
      const pref = preferNames && preferNames.has(c.name) ? 0 : 1;
      if (!best || pref < best.pref || (pref === best.pref && span < best.span)) best = { c, span, pref };
    }
    return best ? best.c.name : '';
  }

  // ---------------------------------------------------------------- dates
  function parseDate(v) {
    if (v == null || v === '') return '';
    if (typeof v === 'number' && v > 1000 && v < 80000) { // Excel serial
      const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
      return d.toISOString().slice(0, 10);
    }
    const s = norm(v);
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/); // Irish/UK: d/m/y
    if (m) {
      let y = +m[3]; if (y < 100) y += y > 30 ? 1900 : 2000;
      let d = +m[1], mo = +m[2];
      if (mo > 12 && d <= 12) [d, mo] = [mo, d];
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s\-\/.]+([a-z]{3,})[\s\-\/.,]+(\d{2,4})$/i);
    if (m) {
      const mo = 'janfebmaraprmayjunjulaugsepoctnovdec'.indexOf(m[2].slice(0, 3).toLowerCase()) / 3 + 1;
      let y = +m[3]; if (y < 100) y += y > 30 ? 1900 : 2000;
      if (mo > 0) return `${y}-${String(mo).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    }
    if (/^\d{5}$/.test(s)) return parseDate(+s);
    return '';
  }
  const looksDate = v => !!parseDate(v) && !/^\d{1,4}$/.test(norm(v));

  // ---------------------------------------------------------------- names
  function titleCase(w) {
    return w.toLowerCase().replace(/(^|[\s\-'])(\p{L})/gu, (m, a, b) => a + b.toUpperCase())
      .replace(/\bMc(\p{L})/gu, (m, a) => 'Mc' + a.toUpperCase());
  }
  /** returns "First SURNAME" */
  function formatName(first, last, upperSurname) {
    first = norm(first); last = norm(last);
    if (upperSurname) {
      last = last.toUpperCase();
      if (first === first.toUpperCase() && first.length > 1) first = titleCase(first);
    }
    return [first, last].filter(Boolean).join(' ');
  }
  function splitFullName(full) {
    full = norm(full);
    if (!full) return ['', ''];
    if (full.includes(',')) { // "SURNAME, First"
      const [l, f] = full.split(',').map(norm);
      return [f, l];
    }
    const w = full.split(' ');
    if (w.length === 1) return [w[0], ''];
    const isUp = x => x.length > 1 && x === x.toUpperCase() && /\p{L}/u.test(x);
    // "SURNAME First" (surname in capitals first)
    if (isUp(w[0]) && !isUp(w[w.length - 1])) {
      let i = 0; while (i < w.length - 1 && isUp(w[i])) i++;
      return [w.slice(i).join(' '), w.slice(0, i).join(' ')];
    }
    // "First SURNAME" with multi-word capitals at end
    if (isUp(w[w.length - 1])) {
      let i = w.length - 1; while (i > 0 && isUp(w[i - 1])) i--;
      return [w.slice(0, i).join(' '), w.slice(i).join(' ')];
    }
    // surname particles
    const parts = ['o', "o'", 'mac', 'mc', 'de', 'ni', 'nic', 'ui', 'van', 'von', 'di', 'da', 'le', 'la', 'ó', 'ní', 'uí'];
    let i = w.length - 1;
    while (i > 1 && parts.includes(w[i - 1].toLowerCase())) i--;
    return [w.slice(0, i).join(' '), w.slice(i).join(' ')];
  }

  // ---------------------------------------------------------------- tabular parsing
  function parseDelimited(text) {
    text = String(text || '').replace(/\r\n?/g, '\n');
    const lines = text.split('\n');
    const hasTab = lines.some(l => l.includes('\t'));
    if (hasTab) return lines.map(l => l.split('\t').map(norm));
    const nonEmpty = lines.filter(l => l.trim());
    const commaRows = nonEmpty.filter(l => l.includes(',')).length;
    if (nonEmpty.length && commaRows / nonEmpty.length > 0.8 && nonEmpty.some(l => l.split(',').length > 2)) return parseCSV(text);
    // runs of 2+ spaces as separators (copied from PDF / fixed width)
    if (nonEmpty.some(l => / {2,}/.test(l.trim()))) return lines.map(l => l.trim().split(/ {2,}/).map(norm));
    return lines.map(l => [norm(l)]);
  }
  function parseCSV(text) {
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(norm(cell)); cell = ''; }
      else if (ch === '\n') { row.push(norm(cell)); rows.push(row); row = []; cell = ''; }
      else if (ch !== '\r') cell += ch;
    }
    row.push(norm(cell)); rows.push(row);
    return rows;
  }
  /** rows from clipboard HTML (tables). Non-table block lines become 1-cell rows (section headings). */
  function parseHtmlTables(html, DOMParserCtor) {
    const doc = new (DOMParserCtor || root.DOMParser)().parseFromString(html, 'text/html');
    const tables = doc.querySelectorAll('table');
    if (!tables.length) return null;
    const rows = [];
    const walk = node => {
      for (const ch of node.children) {
        const tag = ch.tagName;
        if (tag === 'TABLE') {
          const cap = ch.querySelector('caption');
          if (cap && norm(cap.textContent)) rows.push([norm(cap.textContent)]);
          for (const tr of ch.querySelectorAll('tr')) {
            if (tr.closest('table') !== ch) continue;
            const cells = [...tr.children].filter(c => c.tagName === 'TD' || c.tagName === 'TH');
            const r = [];
            for (const c of cells) {
              const v = norm(c.textContent);
              const span = Math.min(+c.getAttribute('colspan') || 1, 20);
              r.push(v); for (let k = 1; k < span; k++) r.push('');
            }
            if (r.some(Boolean)) rows.push(r);
          }
        } else if (/^H[1-6]$|^P$|^CAPTION$|^STRONG$|^B$/.test(tag) && !ch.querySelector('table')) {
          const t = norm(ch.textContent);
          if (t && t.length < 80) rows.push([t]);
        } else walk(ch);
      }
    };
    walk(doc.body);
    return rows;
  }

  // ---------------------------------------------------------------- column detection
  const FIELDS = [
    ['ignore', '— ignore —'], ['id', 'ID / Bib #'], ['name', 'Full name'], ['first', 'First name'], ['last', 'Surname'],
    ['gender', 'Gender'], ['dob', 'Date of birth'], ['category', 'Age category'], ['team', 'Club / Team'],
    ['scoringTeam', 'Scoring team'], ['county', 'County'], ['province', 'Province'], ['reg', 'Reg / Licence #'],
    ['mastersTeam', 'Masters club team'], ['mastersCountyTeam', 'Masters county team'], ['position', 'Position (skip)'],
  ];
  const HEADER_SYNONYMS = {
    id: /^(id|bib|bib ?no|bib ?number|number|no\.?|#|comp ?#|comp ?no|race ?no|race ?number|competitor ?(no|number))$/,
    name: /^(name|full ?name|athlete|athlete ?name|competitor|runner|participant|athlete'?s name)$/,
    first: /^(first|first ?name|firstname|forename|given ?name|christian ?name)$/,
    last: /^(last|last ?name|lastname|surname|family ?name|second ?name)$/,
    gender: /^(gender|sex|m\/f|g|male\/female)$/,
    dob: /^(dob|d\.o\.b\.?|date ?of ?birth|birth ?date|birthdate|born|yob)$/,
    category: /^(cat|category|age ?cat|age ?category|age ?group|agegroup|class|division|race|event|grade)$/,
    team: /^(club|team|club ?name|team ?name|affiliation|display ?team|club\/team|club \/ school|school)$/,
    scoringTeam: /^(scoring ?team|team ?scoring|team ?scoring ?name|scoring ?club)$/,
    county: /^(county|county ?scoring ?name|co\.?)$/,
    province: /^(province|province ?scoring ?name|region)$/,
    reg: /^(reg|reg ?#|reg ?no|registration|registration ?(no|number)|licence|license|licence ?no|aai ?(no|number)|member ?(no|number|id)|membership ?(no|number))$/,
    mastersTeam: /^(masters ?club ?team|masters ?team)$/,
    mastersCountyTeam: /^(masters ?county ?team)$/,
    position: /^(pos|position|place|plc|rank)$/,
  };
  function headerField(h) {
    const s = lc(h).replace(/[:*]/g, '').trim();
    for (const [f, re] of Object.entries(HEADER_SYNONYMS)) if (re.test(s)) return f;
    return null;
  }

  /**
   * Analyse pasted rows. Returns {headerIndex, mapping[], width}
   * ctx: {clubMatch, catMatch}
   */
  function detectColumns(rows, ctx) {
    const width = Math.max(0, ...rows.map(r => r.length));
    let headerIndex = -1, mapping = new Array(width).fill('ignore');
    for (let i = 0; i < Math.min(rows.length, 15); i++) {
      const r = rows[i];
      if (r.filter(Boolean).length < 2) continue;
      const fs = r.map(headerField);
      if (fs.filter(Boolean).length >= 2) {
        headerIndex = i;
        const used = new Set();
        mapping = new Array(width).fill('ignore').map((_, j) => {
          const f = fs[j];
          if (!f || used.has(f)) return 'ignore';
          used.add(f); return f;
        });
        break;
      }
    }
    if (headerIndex < 0) mapping = guessByContent(rows, width, ctx);
    // a "category"/"event" column that actually holds clubs? leave to user.
    return { headerIndex, mapping, width };
  }

  function guessByContent(rows, width, ctx) {
    const data = rows.filter(r => r.filter(Boolean).length >= 2).slice(0, 200);
    const score = [];
    for (let j = 0; j < width; j++) {
      const vals = data.map(r => r[j] || '').filter(Boolean);
      const n = vals.length || 1;
      const frac = f => vals.filter(f).length / n;
      score.push({
        j, n: vals.length,
        num: frac(v => /^\d{1,6}$/.test(v)),
        seq: (() => { const nums = vals.map(Number); let s = 0; for (let k = 1; k < nums.length; k++) if (nums[k] === nums[k - 1] + 1) s++; return nums.length > 2 ? s / (nums.length - 1) : 0; })(),
        date: frac(looksDate),
        gender: frac(v => !!parseGender(v)),
        club: ctx && ctx.clubMatch ? frac(v => { const m = ctx.clubMatch(v); return m && m.score > 0.85; }) : 0,
        cat: ctx && ctx.catMatch ? frac(v => !!ctx.catMatch(v)) : 0,
        alpha: frac(v => /\p{L}/u.test(v) && !/\d/.test(v)),
        words: vals.reduce((a, v) => a + v.split(' ').length, 0) / n,
        time: frac(v => /^\d{1,2}:\d{2}(:\d{2})?([.,]\d+)?$/.test(v)),
      });
    }
    const mapping = new Array(width).fill('ignore');
    const take = (field, pick) => {
      const c = score.filter(s => mapping[s.j] === 'ignore' && s.n > 0).sort((a, b) => pick(b) - pick(a))[0];
      if (c && pick(c) > 0.6) mapping[c.j] = field;
    };
    take('dob', s => s.date);
    take('gender', s => s.gender);
    take('category', s => s.cat);
    take('team', s => s.club);
    // positions are sequential numbers in the first column; ids are numbers
    const firstNum = score.find(s => s.num > 0.9 && mapping[s.j] === 'ignore');
    if (firstNum && firstNum.seq > 0.9 && score.filter(s => s.num > 0.9 && mapping[s.j] === 'ignore').length > 1) mapping[firstNum.j] = 'position';
    take('id', s => s.num);
    // names: alphabetic columns not yet used
    const alphaCols = score.filter(s => mapping[s.j] === 'ignore' && s.alpha > 0.8);
    if (alphaCols.length >= 2 && alphaCols[0].words < 1.6 && alphaCols[1].words < 2.2 && alphaCols[1].j === alphaCols[0].j + 1) {
      // two adjacent single-word columns -> first/last (or last/first if first col is ALL CAPS)
      const a = alphaCols[0], b = alphaCols[1];
      const upA = data.filter(r => r[a.j] && r[a.j] === r[a.j].toUpperCase()).length / (a.n || 1);
      const upB = data.filter(r => r[b.j] && r[b.j] === r[b.j].toUpperCase()).length / (b.n || 1);
      if (upA > 0.7 && upB < 0.5) { mapping[a.j] = 'last'; mapping[b.j] = 'first'; }
      else { mapping[a.j] = 'first'; mapping[b.j] = 'last'; }
    } else if (alphaCols.length) {
      const best = alphaCols.sort((x, y) => Math.abs(x.words - 2) - Math.abs(y.words - 2))[0];
      mapping[best.j] = 'name';
    }
    return mapping;
  }

  /**
   * Convert pasted rows to athlete records.
   * opts: {mapping, headerIndex, upperSurname, defaultCategory, defaultTeam, detectFromDob, year, programCats:Set, clubMatch, catMatch, cats, teams}
   * returns [{rowIndex, raw, rec:{...}, section:{category, team}}]
   */
  function rowsToRecords(rows, opts) {
    const out = [];
    const m = opts.mapping;
    const colOf = f => m.indexOf(f);
    const headerRow = opts.headerIndex >= 0 ? rows[opts.headerIndex].map(lc).join('|') : null;
    let secCat = '', secTeam = '', secGender = '';
    for (let i = 0; i < rows.length; i++) {
      if (i === opts.headerIndex) continue;
      const r = rows[i];
      const filled = r.filter(Boolean);
      if (!filled.length) continue;
      if (headerRow && r.map(lc).join('|') === headerRow) continue; // repeated header
      // section headings (one or two cells): category or club
      if (filled.length <= 2 && !(colOf('name') >= 0 && filled.length === 2 && r[colOf('name')])) {
        const text = filled.join(' ');
        const c = opts.catMatch(text);
        if (c) { secCat = c; continue; }
        const g = catTokens(text).gender;
        const cm = opts.clubMatch(text);
        if (cm && cm.score >= 0.85 && filled.length === 1) { secTeam = cm.team.name; continue; }
        if (filled.length === 1 && !/\d{3,}/.test(text) && text.split(' ').length > 1 && text.split(' ').length < 8 && colOf('name') !== r.indexOf(filled[0]) && colOf('first') < 0) {
          // unknown heading: maybe gender-only heading like "Girls"
          if (g && g !== 'X') secGender = g;
          continue;
        }
        if (filled.length === 1 && colOf('name') < 0 && colOf('first') < 0) continue;
      }
      const get = f => { const j = colOf(f); return j >= 0 ? norm(r[j]) : ''; };
      let first = get('first'), last = get('last');
      if (!first && !last) [first, last] = splitFullName(get('name'));
      else if (!last && first) [first, last] = splitFullName(first);
      if (!first && !last) continue;
      if (/^(total|totals|entries|count)\b/i.test(first)) continue;
      const gender = parseGender(get('gender')) || secGender;
      const dob = parseDate(colOf('dob') >= 0 ? r[colOf('dob')] : '');
      let catText = get('category');
      let category = catText ? opts.catMatch(catText, gender) : '';
      let catSource = category ? 'column' : '';
      if (!category && secCat) {
        // section heading may be generic (e.g. "U12") -> combine with gender
        category = opts.catMatch(secCat, gender) || secCat; catSource = 'heading';
      }
      if (!category && opts.detectFromDob && dob && gender) { category = categoryFromDob(opts.cats, dob, gender, opts.year, opts.programCats); if (category) catSource = 'dob'; }
      if (!category && opts.defaultCategory) { category = opts.defaultCategory; catSource = 'default'; }
      const teamText = get('team') || secTeam || opts.defaultTeam || '';
      const idText = get('id');
      const rec = {
        id: /^\d+$/.test(idText) ? +idText : null,
        name: formatName(first, last, opts.upperSurname),
        first, last, gender, dob, category, categoryText: catText || (catSource === 'heading' ? secCat : ''), catSource,
        teamText, reg: get('reg'), county: get('county'), province: get('province'),
        scoringTeamText: get('scoringTeam'), mastersTeam: get('mastersTeam'), mastersCountyTeam: get('mastersCountyTeam'),
      };
      out.push({ rowIndex: i, raw: r, rec });
    }
    return out;
  }

  // ---------------------------------------------------------------- scoring
  function teamKey(entry, type) {
    if (type === 'county') return norm(entry.county);
    if (type === 'province') return norm(entry.province);
    return norm(entry.scoringTeam || entry.team);
  }

  /** results: [{pos, entry}] already in finish order. Returns sorted team list. */
  function computeTeams(results, type, toScore, multi) {
    const teams = new Map();
    if (!toScore || toScore < 1) return [];
    for (const r of results) {
      const base = teamKey(r.entry, type);
      if (!base) continue;
      let t = teams.get(base);
      if (!t) { t = { name: base, positions: [], athletes: [] }; teams.set(base, t); }
      if (t.positions.length >= toScore) {
        if (!multi) continue;
        let i = 2;
        for (;;) {
          const k = base + ' ' + String.fromCharCode(64 + i); // "Club B", "Club C"
          let t2 = teams.get(k);
          if (!t2) { t2 = { name: k, positions: [], athletes: [] }; teams.set(k, t2); }
          if (t2.positions.length < toScore) { t = t2; break; }
          i++;
        }
      }
      t.positions.push(r.pos); t.athletes.push(r.entry);
    }
    const full = [...teams.values()].filter(t => t.positions.length === toScore).map(t => ({
      ...t, points: t.positions.reduce((a, b) => a + b, 0), last: t.positions[t.positions.length - 1],
    }));
    full.sort((a, b) => a.points - b.points || a.last - b.last);
    full.forEach((t, i) => { t.place = i + 1; t.tie = i > 0 && full[i - 1].points === t.points && full[i - 1].last === t.last; });
    return full;
  }

  /**
   * Score one race.
   * state: {settings, ageCategories, mastersTeamCategories, entries}
   * ev: program event {number, categories[], type}
   * rows: [{id, time}]
   */
  function scoreEvent(state, ev, rows, opts) {
    opts = opts || {};
    const unknownTakes = opts.unknownTakesPosition != null ? opts.unknownTakesPosition : state.settings.unknownTakesPosition !== false;
    const byId = new Map(state.entries.map(e => [String(e.id), e]));
    const catCfg = new Map(state.ageCategories.map(c => [c.name, c]));
    const evCats = new Set(ev.categories);
    const seen = new Map();
    const lines = [];
    let pos = 0;
    rows.forEach((r, i) => {
      const id = String(r.id == null ? '' : r.id).trim();
      const line = { index: i, id, time: r.time || '', entry: null, pos: null, error: '' };
      const e = byId.get(id);
      if (!id) line.error = 'No number';
      else if (seen.has(id)) { line.entry = e || null; line.error = `Duplicate — already in position ${seen.get(id)}`; }
      else if (!e) { line.error = 'Unknown number'; if (unknownTakes) { pos++; line.pos = pos; line.unscored = true; seen.set(id, pos); } }
      else if (!evCats.has(e.category)) { line.entry = e; line.error = `Wrong race — entered in ${e.category || 'no category'}`; if (unknownTakes) { pos++; line.pos = pos; line.unscored = true; seen.set(id, pos); } }
      else { line.entry = e; pos++; line.pos = pos; seen.set(id, pos); }
      lines.push(line);
    });
    const valid = lines.filter(l => l.pos && !l.unscored);
    const type = (ev.type || 'CC').toUpperCase() === 'RR' ? 'rr' : 'cc';
    const level = state.settings.regionLevel || 'Provincial';
    const doCounty = level === 'National' || level === 'Provincial';
    const doProvince = level === 'National';

    // ranking groups
    const groups = [];
    if (ev.categories.length > 1) {
      for (const c of ev.categories) {
        const cfg = catCfg.get(c);
        if (cfg && cfg.noOwnRanking) continue;
        groups.push({ category: c, results: [] });
      }
      for (const l of valid) {
        const cat = l.entry.category;
        const cfg = catCfg.get(cat) || {};
        const targets = new Set();
        if (!cfg.noOwnRanking) targets.add(cat);
        for (const s of cfg.scoresIn || []) {
          if (s === '*') groups.forEach(g => targets.add(g.category));
          else groups.forEach(g => { if (g.category === s || lc(cat).includes(lc(g.category)) && lc(g.category).includes(lc(s))) targets.add(g.category); });
        }
        for (const g of groups) if (targets.has(g.category)) g.results.push({ pos: g.results.length + 1, overall: l.pos, entry: l.entry, time: l.time });
      }
    } else {
      groups.push({ category: ev.categories[0], results: valid.map(l => ({ pos: l.pos, overall: l.pos, entry: l.entry, time: l.time })) });
    }
    for (const g of groups) {
      const cfg = (catCfg.get(g.category) || {})[type] || { club: 4, county: 6, province: 6 };
      g.config = cfg;
      g.teams = {
        club: computeTeams(g.results, 'club', cfg.club, cfg.clubMulti),
        county: doCounty ? computeTeams(g.results, 'county', cfg.county, cfg.countyMulti) : [],
        province: doProvince ? computeTeams(g.results, 'province', cfg.province, cfg.provinceMulti) : [],
      };
    }
    // masters team categories (positions = overall race positions, like the workbook)
    const masters = [];
    for (const mc of state.mastersTeamCategories || []) {
      const cfg = (catCfg.get(mc) || {})[type] || { club: 4, county: 4 };
      const clubRes = valid.filter(l => l.entry.mastersTeam === mc).map(l => ({ pos: l.pos, entry: l.entry }));
      const countyRes = valid.filter(l => l.entry.mastersCountyTeam === mc).map(l => ({ pos: l.pos, entry: l.entry }));
      if (!clubRes.length && !countyRes.length) continue;
      masters.push({
        category: mc,
        club: computeTeams(clubRes, 'club', cfg.club, cfg.clubMulti),
        county: doCounty ? computeTeams(countyRes, 'county', cfg.county || cfg.club, cfg.countyMulti) : [],
      });
    }
    return { lines, finishers: valid.length, errors: lines.filter(l => l.error).length, groups, masters };
  }

  // ---------------------------------------------------------------- validation
  function validate(state) {
    const issues = [];
    const cats = new Set(state.ageCategories.map(c => c.name));
    const teams = new Set(state.teams.map(t => t.name));
    const counties = new Set(state.counties);
    const provinces = new Set(state.provinces);
    const masters = new Set(state.mastersTeamCategories);
    const progCats = new Set(state.program.flatMap(p => p.categories));
    const idCount = new Map(), nameCat = new Map();
    for (const e of state.entries) {
      idCount.set(String(e.id), (idCount.get(String(e.id)) || 0) + 1);
      const k = lc(e.name) + '|' + e.category;
      nameCat.set(k, (nameCat.get(k) || 0) + 1);
    }
    for (const e of state.entries) {
      const add = (field, level, msg) => issues.push({ id: e.id, uid: e.uid, field, level, msg });
      if (e.id == null || e.id === '') add('id', 'error', 'Missing number');
      else if (idCount.get(String(e.id)) > 1) add('id', 'error', `Number ${e.id} is used more than once`);
      if (!norm(e.name)) add('name', 'error', 'Missing name');
      if (!e.category) add('category', 'error', 'No age category');
      else if (!cats.has(e.category)) add('category', 'error', `Unknown age category "${e.category}"`);
      else if (progCats.size && !progCats.has(e.category)) add('category', 'warn', `"${e.category}" is not in any race on the program`);
      if (e.team && !teams.has(e.team)) add('team', 'error', `Unknown club "${e.team}"`);
      if (e.scoringTeam && !teams.has(e.scoringTeam)) add('scoringTeam', 'error', `Unknown scoring team "${e.scoringTeam}"`);
      if (e.county && !counties.has(e.county)) add('county', 'error', `Unknown county "${e.county}"`);
      if (e.province && !provinces.has(e.province)) add('province', 'error', `Unknown province "${e.province}"`);
      if (e.mastersTeam && !masters.has(e.mastersTeam)) add('mastersTeam', 'error', `Unknown masters team category "${e.mastersTeam}"`);
      if (e.mastersCountyTeam && !masters.has(e.mastersCountyTeam)) add('mastersCountyTeam', 'error', `Unknown masters team category "${e.mastersCountyTeam}"`);
      if (norm(e.name) && nameCat.get(lc(e.name) + '|' + e.category) > 1) add('name', 'warn', 'Possible duplicate: same name in same category');
    }
    return issues;
  }

  // ---------------------------------------------------------------- XLSX writer (stored zip)
  const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function zipStore(files) {
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name);
      const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
      const crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true);
      parts.push(new Uint8Array(lh.buffer), name, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((a, b) => a + b.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    const all = [...parts, ...central, new Uint8Array(end.buffer)];
    const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
    let p = 0; for (const a of all) { out.set(a, p); p += a.length; }
    return out;
  }
  const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  function colName(i) { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
  /** sheets: [{name, rows:[[cell]], bold:Set(rowIndex), widths:[]}] ; cell: string|number|{v, b:true} */
  function buildXlsx(sheets) {
    const used = new Set();
    const safe = sheets.map((s, i) => {
      let n = String(s.name || 'Sheet' + (i + 1)).replace(/[\[\]:*?\/\\]/g, ' ').slice(0, 31).trim() || 'Sheet' + (i + 1);
      let base = n, k = 2; while (used.has(n.toLowerCase())) n = base.slice(0, 28) + ' ' + k++;
      used.add(n.toLowerCase()); return n;
    });
    const files = [];
    files.push({ name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` });
    files.push({ name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` });
    files.push({ name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${safe.map((n, i) => `<sheet name="${xmlEsc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` });
    files.push({ name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` });
    files.push({ name: 'xl/styles.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="3"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="13"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>` });
    sheets.forEach((s, si) => {
      const rowsXml = s.rows.map((row, ri) => {
        const cells = (row || []).map((c, ci) => {
          if (c == null || c === '') return '';
          let v = c, st = 0;
          if (typeof c === 'object') { v = c.v; st = c.h ? 2 : c.b ? 1 : 0; }
          if (s.bold && s.bold.has(ri) && !st) st = 1;
          const ref = colName(ci) + (ri + 1);
          const sAttr = st ? ` s="${st}"` : '';
          if (typeof v === 'number' && isFinite(v)) return `<c r="${ref}"${sAttr}><v>${v}</v></c>`;
          return `<c r="${ref}" t="inlineStr"${sAttr}><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
        }).join('');
        return `<row r="${ri + 1}">${cells}</row>`;
      }).join('');
      const cols = s.widths ? `<cols>${s.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
      files.push({ name: `xl/worksheets/sheet${si + 1}.xml`, data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${rowsXml}</sheetData></worksheet>` });
    });
    return zipStore(files);
  }

  // ---------------------------------------------------------------- XLSX reader (needs DecompressionStream)
  async function inflateRaw(data) {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([data]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  async function unzip(buf) {
    const u8 = new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let e = u8.length - 22; while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
    if (e < 0) throw new Error('Not a zip / xlsx file');
    const count = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true);
    const files = {}; const dec = new TextDecoder();
    for (let i = 0; i < count; i++) {
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const off = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
      const lnl = dv.getUint16(off + 26, true), lxl = dv.getUint16(off + 28, true);
      const data = u8.subarray(off + 30 + lnl + lxl, off + 30 + lnl + lxl + csize);
      files[name] = { method, data };
      p += 46 + nlen + xlen + clen;
    }
    return {
      async text(name) {
        const f = files[name]; if (!f) return null;
        const d = f.method === 8 ? await inflateRaw(f.data) : f.data;
        return dec.decode(d);
      }, names: Object.keys(files),
    };
  }
  /** returns [{name, rows:[[...]]}] */
  async function readXlsx(buf, DOMParserCtor) {
    const z = await unzip(buf);
    const P = DOMParserCtor || root.DOMParser;
    const xml = s => new P().parseFromString(s, 'application/xml');
    const wb = xml(await z.text('xl/workbook.xml'));
    const rels = xml(await z.text('xl/_rels/workbook.xml.rels'));
    const relMap = {};
    for (const r of rels.getElementsByTagName('Relationship')) relMap[r.getAttribute('Id')] = r.getAttribute('Target');
    const ssText = await z.text('xl/sharedStrings.xml');
    const shared = [];
    if (ssText) for (const si of xml(ssText).getElementsByTagName('si')) shared.push([...si.getElementsByTagName('t')].map(t => t.textContent).join(''));
    const out = [];
    for (const sh of wb.getElementsByTagName('sheet')) {
      const rid = sh.getAttribute('r:id') || sh.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
      let target = relMap[rid] || ''; target = target.replace(/^\//, '');
      if (!target.startsWith('xl/')) target = 'xl/' + target;
      const t = await z.text(target); if (!t) continue;
      const doc = xml(t); const rows = [];
      for (const row of doc.getElementsByTagName('row')) {
        const ri = +row.getAttribute('r') - 1; const r = [];
        for (const c of row.getElementsByTagName('c')) {
          const ref = c.getAttribute('r'); const col = ref.replace(/\d+/g, '');
          let ci = 0; for (const ch of col) ci = ci * 26 + (ch.charCodeAt(0) - 64); ci--;
          const type = c.getAttribute('t'); const vEl = c.getElementsByTagName('v')[0];
          let v = vEl ? vEl.textContent : '';
          if (type === 's') v = shared[+v] || '';
          else if (type === 'inlineStr') v = [...c.getElementsByTagName('t')].map(x => x.textContent).join('');
          else if (type !== 'str' && type !== 'b' && v !== '' && !isNaN(+v)) v = +v;
          r[ci] = v;
        }
        rows[ri] = [...r].map(x => x == null ? '' : x);
      }
      out.push({ name: sh.getAttribute('name'), state: sh.getAttribute('state') || 'visible', rows: [...rows].map(r => r || []) });
    }
    return out;
  }


  // ---------------------------------------------------------------- full workbook import (Horse & Jockey style .xlsm)
  const fixWb = v => typeof v === 'string'
    ? norm(v).replace('JUnder nior', 'Junior').replace('IUnder AA', 'IUAA').replace('JUnder N', 'JUN').replace(/^SEnior/, 'Senior').replace('U11Girls', 'U11 Girls')
    : v;
  const serialDate = v => {
    if (typeof v === 'number' && v > 1000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + Math.round(v * 86400000));
    const iso = parseDate(v); return iso ? new Date(iso + 'T00:00:00Z') : null;
  };
  function wbTime(v, clock) {
    if (v == null || v === '') return '';
    if (typeof v === 'number') {
      if (clock && Number.isInteger(v) && v >= 0 && v < 24) return String(v).padStart(2, '0') + ':00';
      const frac = v % 1 === 0 && !clock ? null : v % 1;
      if (frac == null) return '';
      let secs = Math.round(frac * 86400 * 100) / 100;
      const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), sec = secs % 60;
      if (clock) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      const ss = (Math.round(sec * 100) / 100).toFixed(sec % 1 ? 2 : 0).padStart(sec % 1 ? 5 : 2, '0');
      return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
    }
    const t = norm(v);
    return /^\d{1,2}:\d{2}(:\d{2})?([.,]\d+)?$/.test(t) ? t : '';
  }
  /** Is this a meet workbook (has Program + Entries sheets)? */
  function isMeetWorkbook(sheets) {
    const names = new Set(sheets.map(s => s.name.toLowerCase()));
    return names.has('entries') && names.has('program');
  }
  /**
   * Convert a Horse & Jockey style workbook (from readXlsx) to a meet.
   * Returns {meet, report} where meet has settings, program, entries, results, and reference data.
   */
  function importWorkbook(sheets) {
    const by = new Map(sheets.map(s => [s.name.toLowerCase(), s]));
    const rowsOf = n => (by.get(n) || { rows: [] }).rows;
    const report = { warnings: [], lateEntries: [] };
    // --- intro
    const intro = {};
    for (const r of rowsOf('intro')) if (r && r[0]) intro[lc(r[0])] = r[1];
    const dateObj = serialDate(intro['date']);
    const date = dateObj ? dateObj.toISOString().slice(0, 10) : '';
    const year = +intro['year of competition'] || (dateObj ? dateObj.getUTCFullYear() : new Date().getFullYear());
    const level = ['Club', 'County', 'Provincial', 'National'].find(x => lc(x) === lc(intro['competition region level'])) || 'Provincial';
    const settings = {
      title: fixWb(intro['event'] || '').replace(/\s+,/g, ',') || 'Imported meet', venue: fixWb(intro['venue'] || ''), date,
      time: wbTime(intro['time'], true), year, startId: +intro['starting id number'] || 1,
      autoNumber: lc(intro['auto id number']) !== 'manual', regionLevel: level, region: fixWb(intro['competition region'] || ''),
    };
    // --- age categories
    const num = v => (typeof v === 'number' ? v : +v) || 0;
    const ageCategories = [];
    const cc = rowsOf('config_ccrr');
    for (let i = 1; i < cc.length; i++) {
      const r = cc[i] || []; const name = fixWb(r[0]);
      if (!name || /^=|#REF/i.test(name) || ageCategories.some(c => c.name === name)) continue;
      const age = typeof r[3] === 'number' ? r[3] : null;
      const rule = v => { const d = serialDate(v); return d && age != null ? { yearOffset: d.getUTCFullYear() - year + age, month: d.getUTCMonth() + 1, day: d.getUTCDate() } : null; };
      const c = {
        name, code: fixWb(r[1]) || '', gender: ['M', 'W'].includes(norm(r[2])) ? norm(r[2]) : '', age,
        dobFrom: rule(r[4]), dobTo: rule(r[5]), ccDistance: norm(r[6]), rrDistance: norm(r[7]),
        cc: { club: num(r[8]), clubMulti: !!num(r[9]), county: num(r[10]), countyMulti: !!num(r[11]), province: num(r[12]), provinceMulti: !!num(r[13]) },
        rr: { club: num(r[14]), clubMulti: !!num(r[15]), county: num(r[16]), countyMulti: !!num(r[17]), province: num(r[18]), provinceMulti: !!num(r[19]) },
        noOwnRanking: false, scoresIn: [],
      };
      if (/^(novice & u23|senior & novice) (men|women)$/i.test(name)) { c.noOwnRanking = true; c.scoresIn = ['*']; }
      else if (/^intermediate & masters/i.test(name)) { c.noOwnRanking = true; c.scoresIn = [name.replace(/^intermediate & /i, '')]; }
      ageCategories.push(c);
    }
    // --- clubs, masters team categories
    const teams = [], seenTeam = new Set(), mastersTeamCategories = [];
    const ct = rowsOf('config_team');
    for (let i = 1; i < ct.length; i++) {
      const r = ct[i] || [];
      const name = fixWb(r[0]);
      if (name && !seenTeam.has(name)) { seenTeam.add(name); teams.push({ name, code: norm(r[1]), county: fixWb(r[2]) || '', province: fixWb(r[3]) || '' }); }
      const m = fixWb(r[9]); if (m && !mastersTeamCategories.includes(m)) mastersTeamCategories.push(m);
    }
    // --- program
    const program = [];
    const pr = rowsOf('program');
    for (let i = 1; i < pr.length; i++) {
      const r = pr[i] || [];
      if (r[0] === '' || r[0] == null || !r[1]) continue;
      const number = typeof r[0] === 'number' ? r[0] : norm(r[0]);
      let ev = program.find(p => String(p.number) === String(number));
      if (!ev) { ev = { number, categories: [], type: lc(r[2]) === 'rr' ? 'RR' : 'CC', distance: norm(r[3]), time: wbTime(r[4], true) }; program.push(ev); }
      const cat = fixWb(r[1]); if (!ev.categories.includes(cat)) ev.categories.push(cat);
    }
    // --- entries
    const entries = [], idSeen = new Set();
    const en = rowsOf('entries');
    for (let i = 1; i < en.length; i++) {
      const r = en[i] || [];
      if (!norm(r[2])) continue;
      const d = r[4] !== '' && r[4] != null ? serialDate(r[4]) : null;
      const e = {
        id: typeof r[0] === 'number' ? r[0] : (/^\d+$/.test(norm(r[0])) ? +norm(r[0]) : null),
        name: fixWb(r[2]), category: fixWb(r[3]) || '', dob: d ? d.toISOString().slice(0, 10) : '', reg: norm(r[5]),
        team: fixWb(r[6]) || '', scoringTeam: fixWb(r[7]) || '', county: fixWb(r[8]) || '', province: fixWb(r[9]) || '',
        mastersTeam: fixWb(r[12]) || '', mastersCountyTeam: fixWb(r[13]) || '',
      };
      if (e.scoringTeam === e.team) e.scoringTeam = '';
      entries.push(e); if (e.id != null) idSeen.add(String(e.id));
    }
    // --- results sheets
    const results = {}; const resultSheets = [];
    for (const sh of sheets) {
      if (!/^results /i.test(sh.name) || sh.state !== 'visible') continue;
      const label = fixWb(sh.name.slice(8));
      const firstCat = fixWb((sh.rows[1] || [])[8]);
      let ev = program.find(p => p.categories.includes(label))
        || program.find(p => p.categories.some(c => c.startsWith(label) || label.startsWith(c)))
        || (firstCat && program.find(p => p.categories.includes(firstCat)));
      if (!ev) { report.warnings.push(`Sheet “${sh.name}” doesn't match a race on the program — skipped`); continue; }
      const order = [];
      for (let i = 1; i < sh.rows.length; i++) {
        const r = sh.rows[i] || [];
        if (r[0] === '' || r[0] == null) break;
        const id = String(typeof r[0] === 'number' ? r[0] : norm(r[0]));
        order.push({ id, time: wbTime(r[1], false) });
        if (!idSeen.has(id) && norm(r[3]) && /^\d+$/.test(id)) {
          const cat = fixWb(r[8]) || (ev.categories.length === 1 ? ev.categories[0] : '');
          const late = { id: +id, name: fixWb(r[3]), category: cat, dob: '', reg: '', team: fixWb(r[4]) || '', scoringTeam: fixWb(r[5]) || '', county: fixWb(r[6]) || '', province: '', mastersTeam: '', mastersCountyTeam: '', late: true };
          if (late.scoringTeam === late.team) late.scoringTeam = '';
          report.lateEntries.push(late); idSeen.add(id);
        }
      }
      const key = String(ev.number);
      if (!results[key] || order.length > results[key].length) results[key] = order;
      resultSheets.push(sh.name);
    }
    const counties = [...new Set([...teams.map(t => t.county), ...entries.map(e => e.county)].filter(Boolean))].sort();
    const provinces = [...new Set(['Connacht', 'Leinster', 'Munster', 'Ulster', ...teams.map(t => t.province), ...entries.map(e => e.province)].filter(Boolean))].sort();
    Object.assign(report, {
      races: program.length, athletes: entries.length, finishers: Object.values(results).reduce((a, r) => a + r.length, 0),
      resultSheets: resultSheets.length, categories: ageCategories.length, clubs: teams.length,
    });
    return { meet: { settings, program, entries, results, ageCategories, teams, mastersTeamCategories, counties, provinces }, report };
  }

  // ---------------------------------------------------------------- folder sync (OneDrive etc.)
  /*
   * Each meet is one file "<id>.json" in the sync folder:
   *   {format:'xc-meet-sync', id, rev, deleted?, updatedAt, device, title, date, state}
   * Every local save gives the meet a new random rev. Locally we remember, per meet,
   *   rev      – the current local version
   *   baseRev  – the version last known to be in the folder (common ancestor)
   *   dirty    – changed locally since baseRev
   *   deleted  – deleted locally (tombstone)
   * OneDrive may leave extra copies like "<id>-LAPTOP.json" when both PCs wrote while
   * offline; files are grouped by the id inside them, not by file name.
   */
  /*
   * Versions carry history: a file's `ancestors` lists the revs it was built from, and each local meta
   * keeps `history` (revs up to the last synced one) and `at` (when the current version was made).
   * A version that has our rev among its ancestors is simply newer -> take it. Two versions that
   * don't contain each other were edited separately (e.g. laptop offline while desktop edited):
   * both computers pick the same winner (latest `at`, then rev) and keep the loser as a copy with the
   * predictable id "<id>~<rev>", so both computers end up with exactly the same two meets.
   */
  const newer = (a, b) => (a.at || '') > (b.at || '') || ((a.at || '') === (b.at || '') && a.rev > b.rev);
  /** Plan what to do. locals: Map id -> meta; remotes: [{file,id,rev,deleted,updatedAt,ancestors}] */
  function planSync(locals, remotes) {
    const byId = new Map();
    for (const r of remotes) { if (!r || !r.id || !r.rev) continue; if (!byId.has(r.id)) byId.set(r.id, []); byId.get(r.id).push(r); }
    const actions = [];
    for (const id of new Set([...locals.keys(), ...byId.keys()])) {
      const L = locals.get(id), R = byId.get(id) || [];
      const canonical = id + '.json';
      const versions = [...new Map(R.map(r => [r.rev, { ...r, at: r.updatedAt || '', ancestors: r.ancestors || [] }])).values()];
      const known = new Set(L ? [...(L.history || []), L.rev, L.baseRev].filter(Boolean) : []);
      const superseded = new Set(versions.flatMap(v => v.ancestors));
      const incoming = versions.filter(v => !known.has(v.rev) && !superseded.has(v.rev))
        .sort((a, b) => (newer(a, b) ? -1 : newer(b, a) ? 1 : 0));
      const [main, ...others] = incoming;
      const copyOthers = () => others.filter(o => !o.deleted).forEach(o => actions.push({ type: 'copyRemote', id, file: o.file, rev: o.rev }));
      const take = v => actions.push(v.deleted ? { type: L && !L.deleted ? 'deleteLocal' : 'tombstone', id, file: v.file, rev: v.rev } : { type: 'pull', id, file: v.file, rev: v.rev });
      let final = null; // 'local' or a remote version that should end up as <id>.json
      if (!L) {
        if (!main) continue;
        take(main); final = main; copyOthers();
      } else if (!main) {
        const hasMine = versions.some(v => v.rev === L.rev);
        if (L.dirty || (!hasMine && !(L.deleted && !versions.length))) { actions.push({ type: 'push', id, merged: [] }); final = 'local'; }
        else final = versions.find(v => v.rev === L.rev) || null;
      } else if (!L.dirty && main.ancestors.includes(L.rev)) {
        take(main); final = main; copyOthers(); // simply a newer version of ours
      } else {
        // edited separately on both computers
        const mine = { rev: L.rev, at: L.at || '' };
        if (L.deleted && main.deleted) { actions.push({ type: 'tombstone', id, file: main.file, rev: main.rev }); final = main; }
        else if (L.deleted) { take(main); final = main; }                                     // their edits beat our delete
        else if (main.deleted) { actions.push({ type: 'push', id, merged: [main.rev] }); final = 'local'; } // our edits beat their delete
        else if (newer(mine, main)) {
          actions.push({ type: 'copyRemote', id, file: main.file, rev: main.rev });
          actions.push({ type: 'push', id, merged: [main.rev] }); final = 'local';
        } else {
          actions.push({ type: 'copyLocal', id, rev: L.rev, file: main.file });
          take(main); final = main;
        }
        copyOthers();
      }
      if (final && final !== 'local' && final.file !== canonical) actions.push({ type: 'copy', id, from: final.file, to: canonical });
      for (const r of R) if (r.file !== canonical) actions.push({ type: 'remove', id, file: r.file });
    }
    const order = { copyLocal: 0, copyRemote: 1, tombstone: 2, deleteLocal: 2, pull: 2, push: 3, copy: 3, remove: 4 };
    return actions.sort((a, b) => order[a.type] - order[b.type]);
  }
  /** Order-independent JSON for comparing two meets' content. */
  function stableStringify(v) {
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
    return JSON.stringify(v);
  }

  root.XC = {
    norm, lc, levenshtein, clubKey, clubCore, makeClubMatcher, parseGender, catTokens, makeCategoryMatcher,
    catDobRange, categoryFromDob, parseDate, formatName, splitFullName, titleCase, parseDelimited, parseCSV,
    parseHtmlTables, FIELDS, headerField, detectColumns, rowsToRecords, computeTeams, scoreEvent, validate,
    buildXlsx, readXlsx, crc32, colName, isMeetWorkbook, importWorkbook, wbTime, planSync, stableStringify,
  };
  if (typeof module !== 'undefined') module.exports = root.XC;
})(typeof window !== 'undefined' ? window : globalThis);
