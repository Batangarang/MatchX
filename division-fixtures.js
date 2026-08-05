const cheerio = require('cheerio');
const fs = require('fs');

const URL = 'https://www.nwcfl.com/fixtures.php?comp=47';

async function scrape() {
  const res = await fetch(URL);
  const html = await res.text();
  const $ = cheerio.load(html);

  let targetTable = null;
  $('table').each((i, table) => {
    const text = $(table).text();
    if (text.includes('No Format') || (text.includes(' v ') && /\d{2}:\d{2}/.test(text))) {
      targetTable = table;
      return false;
    }
  });

  if (!targetTable) {
    console.log('Could not find the plain fixtures table. Headers found on the page:');
    $('table').each((i, table) => {
      console.log(`  Table ${i}: "${$(table).find('tr').first().text().trim().slice(0, 100)}"`);
    });
    throw new Error('Fixtures table not found — see list above to help fix the selector.');
  }

  const fixtures = [];
  let currentDate = null;

  $(targetTable).find('tr').each((i, row) => {
    const text = $(row).text().trim();
    if (!text) return;

    if (!text.includes(' v ') && /\d{4}/.test(text)) {
      currentDate = text;
      return;
    }

    const match = text.match(/^(.+?)\s+v\s+(.+?)\s*\((\d{2}:\d{2})\)/);
    if (match && currentDate) {
      fixtures.push({
        date: currentDate,
        home: match[1].trim(),
        away: match[2].trim(),
        kickoff: match[3].trim(),
      });
    }
  });

  fs.writeFileSync('division-fixtures.json', JSON.stringify({ generatedAt: new Date().toISOString(), fixtures }, null, 2));
  console.log(`Saved ${fixtures.length} division fixtures`);
  console.log('First 5:', fixtures.slice(0, 5));
}

scrape().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
