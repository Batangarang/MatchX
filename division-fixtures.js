const cheerio = require('cheerio');
const fs = require('fs');

const URL = 'https://www.nwcfl.com/fixtures.php?comp=47';
const DIVISION_NAME = 'First Division South';

async function scrape() {
  const res = await fetch(URL);
  const html = await res.text();
  const $ = cheerio.load(html);

  const fixtures = [];

  $('table').each((i, table) => {
    const headerText = $(table).find('tr').first().text().trim();

    // A genuine fixture-date table's header combines a date and the division
    // name, e.g. "Saturday 8th August 2026 First Division South First Division South"
    const dateMatch = headerText.match(/(\w+day)\s+(\d{1,2})\w*\s+(\w+)\s+(\d{4})/);
    if (!dateMatch || !headerText.includes(DIVISION_NAME)) return;

    // Reject tables that are actually cup competitions, even if they also
    // mention the division name somewhere in the header (the site shows a
    // persistent division badge regardless of which competition is displayed).
    const isCupFixture = /cup|vase|trophy/i.test(headerText);
    if (isCupFixture) return;

    const dateStr = `${dateMatch[1]} ${dateMatch[2]} ${dateMatch[3]} ${dateMatch[4]}`;

    $(table).find('tr').slice(1).each((j, row) => {
      const text = $(row).text().trim();
      if (!text) return;

      const match = text.match(/^(.+?)\s+v\s+(.+?)\s*\((\d{2}:\d{2})\)/);
      if (match) {
        fixtures.push({
          date: dateStr,
          home: match[1].trim(),
          away: match[2].trim(),
          kickoff: match[3].trim(),
        });
      }
    });
  });

  fs.writeFileSync('division-fixtures.json', JSON.stringify({ generatedAt: new Date().toISOString(), fixtures }, null, 2));
  console.log(`Saved ${fixtures.length} division fixtures`);
  console.log('First 5:', fixtures.slice(0, 5));
}

scrape().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});