const fs = require('fs');

// nwcfl.com's own "Last Six" form column mixes cup games in with league games
// (confirmed 10 Oct: Wolverhampton Casuals showed "WWWWWD" — 5 wins — when
// their actual league record was 4 wins, the 5th being a cup win).
//
// Shared helper: given a list of played fixtures (each with a `score` like
// "W 4-1" and a `competitionNote` that is null/empty for a league match),
// returns a league-only form string, newest result first (e.g. "WDWWL"), or
// null if there's nothing usable. Used both for Sandbach (from data.json,
// which already has this shape) and, via division-results.js, for every
// other club in the division (scraped from their own club page).
function leagueOnlyForm(fixtures, maxGames = 6) {
  const leagueResults = (fixtures || [])
    .filter(f => !f.competitionNote && f.score && /^[WDL]\s/.test(f.score))
    .map(f => ({ ...f, _sortKey: parseUkDate(f.date) }))
    .filter(f => f._sortKey)
    .sort((a, b) => a._sortKey - b._sortKey);

  if (leagueResults.length === 0) return null;

  const latest = leagueResults.slice(-maxGames).reverse(); // newest first
  return latest.map(f => f.score.trim()[0]).join('');
}

// Sandbach United specifically: we already hold a full, competition-tagged
// fixture history for our own club in data.json, so there is no need to
// scrape anything extra — just read it and compute the league-only form.
function computeSandbachLeagueForm(maxGames = 6) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync('data.json', 'utf-8'));
  } catch {
    return null;
  }
  return leagueOnlyForm(data.allFixtures || [], maxGames);
}

function parseUkDate(dateStr) {
  // "Sat 19/09/26" style
  const m = String(dateStr).match(/(\d{2})\/(\d{2})\/(\d{2})/);
  if (!m) return null;
  return new Date(2000 + parseInt(m[3], 10), parseInt(m[2], 10) - 1, parseInt(m[1], 10));
}

module.exports = { computeSandbachLeagueForm, leagueOnlyForm, parseUkDate };
