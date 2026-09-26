// Run by the "Apply overrides" workflow. Takes the JSON payload sent from the
// admin page (env PAYLOAD), validates it strictly, writes overrides.json, and
// immediately patches the already-generated score files so the change shows
// straight away — even for a game that has finished. (The live scripts also
// honour overrides.json on every run while a game is on.)
const fs = require('fs');

const TEXT_KEYS = ['fanBriefing', 'preview:sandbachFocus', 'preview:divisionWide', 'recap:sandbachFocus', 'recap:divisionWide'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function fail(msg) { console.error('Rejected: ' + msg); process.exit(1); }
function readJSON(f) { try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return null; } }
function writeJSON(f, d) { fs.writeFileSync(f, JSON.stringify(d, null, 2)); }

let incoming;
try { incoming = JSON.parse(process.env.PAYLOAD || ''); } catch { fail('payload is not valid JSON'); }
if (!incoming || typeof incoming !== 'object') fail('payload must be an object');

// ---------- validate ----------
const next = { updatedAt: new Date().toISOString(), score: { enabled: false }, texts: {} };

const s = incoming.score || {};
if (s.date !== undefined && !DATE_RE.test(String(s.date))) fail('bad score date');
if (s.enabled) {
  const h = Number(s.home), a = Number(s.away);
  if (!DATE_RE.test(String(s.date))) fail('score override needs a date');
  if (!Number.isInteger(h) || !Number.isInteger(a) || h < 0 || a < 0 || h > 99 || a > 99) fail('scores must be whole numbers 0-99');
  next.score = { enabled: true, date: s.date, home: h, away: a };
} else if (s.date) {
  next.score = { enabled: false, date: s.date };
}

for (const [key, t] of Object.entries(incoming.texts || {})) {
  if (!TEXT_KEYS.includes(key)) continue;
  if (!t || typeof t.text !== 'string' || !t.text.trim()) continue;
  next.texts[key] = {
    enabled: !!t.enabled,
    hold: !!t.hold,
    text: t.text.slice(0, 6000),
    base: String(t.base || '').slice(0, 40),
  };
}

// ---------- patch generated score files ----------
const prev = readJSON('overrides.json') || {};
const prevScore = prev.score || {};

const isSandbachFixture = f => /sandbach/i.test(f.home || '') || /sandbach/i.test(f.away || '');

function setMatchScore(m, scoreStr) {
  if (m.scoreSource !== 'manual_override') m.scoreBeforeOverride = m.score ?? null;
  m.score = scoreStr;
  m.scoreSource = 'manual_override';
  m.scoreConfirmed = true;
  m.scoreDiscrepancy = null;
}
function restoreMatchScore(m) {
  if (m.scoreSource !== 'manual_override') return;
  if ('scoreBeforeOverride' in m) { m.score = m.scoreBeforeOverride; delete m.scoreBeforeOverride; }
  m.scoreSource = 'restored_after_manual_override';
}

function patchScoreFiles(dateStr, scoreStr /* null = restore */) {
  const apply = m => (scoreStr ? setMatchScore(m, scoreStr) : restoreMatchScore(m));

  const archiveFile = `matchday-archive/${dateStr}.json`;
  const archive = readJSON(archiveFile);
  let finalScore = null;
  if (archive && archive.match) {
    apply(archive.match);
    finalScore = archive.match.score;
    writeJSON(archiveFile, archive);
  }

  const live = readJSON('matchday-live.json');
  if (live && live.match && live.fixtureDate === dateStr) {
    apply(live.match);
    finalScore = live.match.score;
    writeJSON('matchday-live.json', live);
  }

  const index = readJSON('matchday-index.json');
  if (Array.isArray(index) && finalScore !== null) {
    const e = index.find(x => x.date === dateStr);
    if (e) { e.score = finalScore; writeJSON('matchday-index.json', index); }
  }

  const ds = readJSON('division-scores.json');
  if (ds && ds.date === dateStr && Array.isArray(ds.fixtures)) {
    ds.fixtures.filter(isSandbachFixture).forEach(f => {
      if (scoreStr) {
        if (f.scoreSource !== 'manual_override') f.scoreBeforeOverride = f.score ?? null;
        f.score = scoreStr; f.scoreSource = 'manual_override';
      } else if (f.scoreSource === 'manual_override') {
        if ('scoreBeforeOverride' in f) { f.score = f.scoreBeforeOverride; delete f.scoreBeforeOverride; }
        f.scoreSource = 'restored_after_manual_override';
      }
    });
    writeJSON('division-scores.json', ds);
  }
}

// switched off, or moved to a different date -> put the old date back
if (prevScore.enabled && prevScore.date && (!next.score.enabled || next.score.date !== prevScore.date)) {
  patchScoreFiles(prevScore.date, null);
  console.log(`Score override removed for ${prevScore.date}`);
}
if (next.score.enabled) {
  patchScoreFiles(next.score.date, `${next.score.home}-${next.score.away}`);
  console.log(`Score override applied for ${next.score.date}: ${next.score.home}-${next.score.away}`);
}

writeJSON('overrides.json', next);
console.log('Saved overrides.json —', Object.keys(next.texts).length, 'text block(s) stored.');
