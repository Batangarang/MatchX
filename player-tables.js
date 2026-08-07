const cheerio = require('cheerio');
const fs = require('fs');

const URL = 'https://www.nwcfl.com/player-tables.php';
const DIVISION_NAME = 'First Division South';

// Only need the "hidden-xs" (desktop) copy of each table — the visible-xs
// version is an identical duplicate for mobile layout.
const TABLE_CLASSES = {
  appearances: 'appstable',
  goalscorers: 'goalstable', // best guess, based on the appstable/momtable pattern — confirmed or corrected below
  manOfTheMatch: 'momtable',
};

function parseTable($, table) {
  const rows = [];
  $(table).find('tr').slice(1).each((j, row) => {
    const cells = $(row).find('td');
    if (cells.length < 3) return;
    const rank = $(cells[0]).text().trim();
    const player = $(cells[1]).text().trim();
    const club = $(cells[2]).text().trim();
    const total = cells.length > 3 ? $(cells[3]).text().trim() : '';
    if (!player) return;
    rows.push({ rank: rank || null, player, club, total });
  });
  return rows;
}

async function scrape() {
  const res = await fetch(URL);
  const html = await res.text();
  const $ = cheerio.load(html);

  const result = {};
  const foundTableClasses = new Set();

  // Log every table class actually present, so we can confirm/correct
  // the goalscorers guess in one pass if it's wrong.
  $('table').each((i, table) => {
    const cls = $(table).attr('class');
    if (cls) foundTableClasses.add(cls);
  });
  console.log('Table classes found on the page:', [...foundTableClasses].join(', '));

  Object.entries(TABLE_CLASSES).forEach(([key, className]) => {
    $(`table.${className}`).each((i, table) => {
      // Only take the desktop ("hidden-xs" container) copy, and confirm
      // the preceding <h3> matches our target division.
      const inHiddenXs = $(table).closest('.hidden-xs').length > 0;
      if (!inHiddenXs) return;

      const heading = $(table).prevAll('h3').first().text().trim();
      if (heading === DIVISION_NAME && !result[key]) {
        result[key] = parseTable($, table);
      }
    });
  });

  const output = {
    generatedAt: new Date().toISOString(),
    division: DIVISION_NAME,
    ...result,
  };

  fs.writeFileSync('player-tables.json', JSON.stringify(output, null, 2));

  const foundCategories = Object.keys(result);
  console.log(`Saved player-tables.json with categories: ${foundCategories.join(', ')}`);
  Object.entries(result).forEach(([key, rows]) => {
    console.log(`${key}: ${rows.length} players`);
    if (rows.length > 0) console.log('  Sample:', rows[0]);
  });
}

scrape().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});