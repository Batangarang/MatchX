const cheerio = require('cheerio');
const fs = require('fs');

const URL = 'https://www.nwcfl.com/player-tables.php';
const DIVISION_NAME = 'First Division South';
const CATEGORIES = [
  { key: 'appearances', label: 'Appearances' },
  { key: 'goalscorers', label: 'Goalscorers' },
  { key: 'manOfTheMatch', label: 'Man of the Match' },
];

function findNearbyHeading($, table) {
  // Look at preceding siblings for a heading or bold text containing both
  // the category and division — same pattern used for league.js's
  // "Last Six" form table detection.
  let text = '';
  let el = $(table).prev();
  let hops = 0;
  while (el.length && hops < 5) {
    text += ' ' + el.text();
    el = el.prev();
    hops++;
  }
  return text;
}

async function scrape() {
  const res = await fetch(URL);
  const html = await res.text();
  const $ = cheerio.load(html);

  const result = {};

  $('table').each((i, table) => {
    const nearbyText = findNearbyHeading($, table);
    const tableOwnFirstRowText = $(table).find('tr').first().text();
    const combinedContext = nearbyText + ' ' + tableOwnFirstRowText;

    const matchedCategory = CATEGORIES.find(c => combinedContext.includes(c.label));
    const isSouthDivision = combinedContext.includes(DIVISION_NAME);

    if (matchedCategory && isSouthDivision && !result[matchedCategory.key]) {
      const rows = [];
      $(table).find('tr').slice(1).each((j, row) => {
        const cells = $(row).find('td');
        if (cells.length < 3) return;
        const rank = $(cells[0]).text().trim();
        const player = $(cells[1]).text().trim();
        const club = $(cells[2]).text().trim();
        const total = cells.length > 3 ? $(cells[3]).text().trim() : $(cells[2]).text().trim();
        if (!player) return;
        rows.push({ rank: rank || null, player, club, total });
      });
      result[matchedCategory.key] = rows;
    }
  });

  const foundCategories = Object.keys(result);
  if (foundCategories.length < 3) {
    console.log(`Only found ${foundCategories.length}/3 categories via heading detection: ${foundCategories.join(', ')}`);
    console.log('Table headers found on the page, for debugging:');
    $('table').each((i, table) => {
      console.log(`  Table ${i}: "${$(table).find('tr').first().text().trim().slice(0, 100)}"`);
    });
  }

  const output = {
    generatedAt: new Date().toISOString(),
    division: DIVISION_NAME,
    ...result,
  };

  fs.writeFileSync('player-tables.json', JSON.stringify(output, null, 2));
  console.log(`Saved player-tables.json with categories: ${foundCategories.join(', ')}`);
  Object.entries(result).forEach(([key, rows]) => {
    console.log(`${key}: ${rows.length} players`);
    console.log(rows.find(r => r.player.toLowerCase().includes('bevan') || r.club === 'SAN'));
  });
}

scrape().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});