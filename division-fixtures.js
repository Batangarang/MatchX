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

    const dateMatch = headerText.match(/(\w+day)\s+(\d{1,2})\w*\s+(\w+)\s+(\d{4})/);
    if (!dateMatch || !headerText.includes(DIVISION_NAME)) return;

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
          postponed: false,
        });
        return;
      }

      // A postponed fixture reads like "Barnton P-P Cheadle Heath Nomads"
      const ppMatch = text.match(/^(.+?)\s+P-P\s+(.+)$/);
      if (ppMatch) {
        fixtures.push({
          date: dateStr,
          home: ppMatch[1].trim(),
          away: ppMatch[2].trim(),
          kickoff: null,
          postponed: true,
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