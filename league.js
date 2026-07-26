const cheerio = require('cheerio');
const fs = require('fs');

const URL = 'https://www.nwcfl.com/league-tables.php';
const DIVISION_NAME = 'First Division South';

async function scrape() {
  const res = await fetch(URL);
  const html = await res.text();
  const $ = cheerio.load(html);

  // Several tables on this page are titled "First Division South" (full stats,
  // condensed, home/away split, form, discipline). We want the one whose header
  // row has the FULL set of columns — spotted by checking for "W" as a header,
  // which the condensed and other variants don't have.
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
    if (!position || isNaN(parseInt(position))) return; // skip blank spacer rows

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