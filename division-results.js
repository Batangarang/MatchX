const cheerio = require('cheerio');
const fs = require('fs');
const { leagueOnlyForm } = require('./sandbach-form.js');

const OUTPUT_FILE = 'division-results.json';
const FRESHNESS_HOURS = 20; // results only change after matches are played — no need to re-scrape ~20 club pages every hour
const DELAY_BETWEEN_CLUBS_MS = 400; // be polite to nwcfl.com rather than firing ~20 requests at once

function isFreshEnough() {
  if (!fs.existsSync(OUTPUT_FILE)) return false;
  try {
    const existing = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf-8'));
    const ageHours = (Date.now() - new Date(existing.scrapedAt).getTime()) / 3600000;
    return ageHours < FRESHNESS_HOURS;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Same parsing approach as scrape.js's Sandbach-specific scraper (same site
// template: a table whose header row mentions "Opposition" and "K.O.", and a
// competition-note row in brackets that describes the fixture directly above
// it) — generalised here to work for any club's page, not just Sandbach's.
function parseClubFixtures(html) {
  const $ = cheerio.load(html);

  let targetTable = null;
  $('table').each((i, table) => {
    const headerText = $(table).find('tr').first().text();
    if (headerText.includes('Opposition') && headerText.includes('K.O.')) {
      targetTable = table;
      return false;
    }
  });
  if (!targetTable) return null;

  const fixtures = [];
  $(targetTable).find('tr').slice(1).each((i, row) => {
    const cells = $(row).find('td');
    if (cells.length === 0) return;

    const firstCellText = $(cells[0]).text().trim();
    const secondCellText = cells.length > 1 ? $(cells[1]).text().trim() : '';

    const noteText = firstCellText.startsWith('(') ? firstCellText
      : (secondCellText.startsWith('(') && !firstCellText) ? secondCellText
      : null;

    if (noteText) {
      if (fixtures.length > 0) {
        fixtures[fixtures.length - 1].competitionNote = noteText.replace(/[()]/g, '');
      }
      return;
    }

    const date = firstCellText;
    const score = cells.length > 4 ? $(cells[4]).text().trim() : '';

    fixtures.push({ date, score: score || null, competitionNote: null });
  });

  return fixtures;
}

async function run() {
  if (isFreshEnough()) {
    console.log('division-results.json is still fresh — skipping the division-wide re-scrape.');
    return;
  }
  if (!fs.existsSync('league.json')) {
    console.log('No league.json yet — run league.js first.');
    return;
  }

  const { standings } = JSON.parse(fs.readFileSync('league.json', 'utf-8'));
  const clubs = {};
  let failures = 0;

  for (const team of standings) {
    // Sandbach's own league-only form is computed from data.json (already
    // authoritative and already scraped every run) — no need to re-fetch it here.
    if (team.team.includes('Sandbach')) continue;
    if (!team.clubUrl) continue;

    const url = `https://www.nwcfl.com/${team.clubUrl}`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const fixtures = parseClubFixtures(html);
      if (!fixtures) throw new Error('fixtures table not found on club page');

      const form = leagueOnlyForm(fixtures);
      const leagueGamesPlayed = fixtures.filter(f => !f.competitionNote && f.score).length;
      clubs[team.team] = { clubUrl: team.clubUrl, form, leagueGamesPlayed };
      console.log(`${team.team}: ${form || '(no league results yet)'}`);
    } catch (err) {
      failures++;
      console.warn(`Skipping ${team.team} (${team.clubUrl}): ${err.message}`);
    }

    await sleep(DELAY_BETWEEN_CLUBS_MS);
  }

  const output = { scrapedAt: new Date().toISOString(), clubs };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`Saved ${OUTPUT_FILE} — ${Object.keys(clubs).length} club(s) covered, ${failures} failure(s).`);
}

run().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
