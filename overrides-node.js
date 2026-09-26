const fs = require('fs');

// Manual overrides set from the admin page live in overrides.json.
// Scripts only ever READ this file; apply-overrides.js (run by the
// "Apply overrides" workflow) is what writes it.
function readOverrides() {
  try {
    return JSON.parse(fs.readFileSync('overrides.json', 'utf-8'));
  } catch {
    return {};
  }
}

// Returns { home, away } (home-first) when a manual score override is switched on
// for the given match date (YYYY-MM-DD), otherwise null.
function activeScoreOverride(dateStr) {
  const s = readOverrides().score;
  if (s && s.enabled && s.date === dateStr && Number.isInteger(s.home) && Number.isInteger(s.away)) {
    return { home: s.home, away: s.away };
  }
  return null;
}

module.exports = { readOverrides, activeScoreOverride };
