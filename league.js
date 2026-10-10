const cheerio = require('cheerio');
const fs = require('fs');
const { computeSandbachLeagueForm } = require('./sandbach-form.js');

const URL = 'https://www.nwcfl.com/league-tables.php';
const DIVISION_NAME = 'First Division South';

async function scrape() {
  const res = await fetch(URL);
  const html = await res.text();
  const $ = cheerio.load(html);

  let targetTable = null;
  $('table').each((i, table) => {
    const headerRow = $(table).find('tr').first();
    const headerText = headerRow.text();
    const headerCells = headerRow.find('th, td').map((i, el) => $(el).text().trim()).get();

    if (headerText.includes(DIVISION_NAME) && headerCells.includes('W') && headerCells.includes('Pts')) {
      targetTable = table;
      return false;
    }
  });

  if (!targetTable) {
    console.log('Could not find the right table. Headers found on the page:');
    $('table').each((i, table) => {
      console.log(`  Table ${i}: "${$(table).find('tr').first().text().trim().slice(0, 100)}"`);
    });
    throw new Error('League table not found — see list above to help fix the selector.');
  }

  const standings = [];

  $(targetTable).find('tr').slice(1).each((i, row) => {
    const cells = $(row).find('td');
    if (cells.length === 0) return;

    const position = $(cells[0]).text().trim();
    if (!position || isNaN(parseInt(position))) return;

    const teamCell = $(cells[1]);
    const teamName = teamCell.text().trim();
    const clubUrl = teamCell.find('a').attr('href') || null;

    standings.push({
      position: parseInt(position),
      team: teamName,
      played: $(cells[2]).text().trim(),
      won: $(cells[3]).text().trim(),
      drawn: $(cells[4]).text().trim(),
      lost: $(cells[5]).text().trim(),
      for: $(cells[6]).text().trim(),
      against: $(cells[7]).text().trim(),
      goalDifference: $(cells[8]).text().trim(),
      points: $(cells[9]).text().trim(),
      clubUrl,
    });
  });

  // Find the "Last Six" form table — same division name, different table on the same page
  let formTable = null;
  $('table').each((i, table) => {
    const headerText = $(table).find('tr').first().text();
    if (headerText.includes(DIVISION_NAME) && headerText.includes('Last Six')) {
      formTable = table;
      return false;
    }
  });

  const formGuide = {};
  if (formTable) {
    $(formTable).find('tr').slice(1).each((i, row) => {
      const cells = $(row).find('td');
      if (cells.length < 2) return;
      const teamName = $(cells[1]).text().trim();
      const lastSix = $(cells[cells.length - 1]).text().trim();
      if (teamName && lastSix) formGuide[teamName] = lastSix;
    });
  }

  // nwcfl.com's "Last Six" form column includes cup results, not just the
  // league (confirmed 10 Oct against Wolverhampton Casuals: it showed 5 wins
  // when the league record was 4). Sandbach's own league-only form comes from
  // data.json (already scraped every run); every other club's comes from
  // division-results.json, a once-a-day sweep of each club's own page
  // (division-results.js). A club is flagged all-competitions only when
  // neither of those has a verified figure for it yet.
  const sandbachLeagueForm = computeSandbachLeagueForm();
  let divisionResults = {};
  try {
    divisionResults = JSON.parse(fs.readFileSync('division-results.json', 'utf-8')).clubs || {};
  } catch {}

  standings.forEach(team => {
    team.form = formGuide[team.team] || null;
    team.formIncludesCup = true;
    if (team.team.includes('Sandbach') && sandbachLeagueForm) {
      team.form = sandbachLeagueForm;
      team.formIncludesCup = false;
    } else if (divisionResults[team.team] && divisionResults[team.team].form) {
      team.form = divisionResults[team.team].form;
      team.formIncludesCup = false;
    }
  });

  return {
    scrapedAt: new Date().toISOString(),
    division: DIVISION_NAME,
    standings,
  };
}

scrape()
  .then((data) => {
    fs.writeFileSync('league.json', JSON.stringify(data, null, 2));
    console.log(`Saved league.json with ${data.standings.length} teams`);
    console.log(data.standings.find(t => t.team.includes('Sandbach')));
  })
  .catch((err) => {
    console.error('Scrape failed:', err.message);
    process.exit(1);
  });