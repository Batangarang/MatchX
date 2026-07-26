const cheerio = require('cheerio');
const fs = require('fs');

const URL = 'https://www.nwcfl.com/clubpage.php?id=803'; // Sandbach United club page

async function scrape() {
  const res = await fetch(URL);
  const html = await res.text();
  const $ = cheerio.load(html);

  // Find the fixtures table by looking for one whose header row
  // mentions "Opposition" and "K.O." — avoids relying on exact class names.
  let targetTable = null;
  $('table').each((i, table) => {
    const headerText = $(table).find('tr').first().text();
    if (headerText.includes('Opposition') && headerText.includes('K.O.')) {
      targetTable = table;
      return false; // stop looping once found
    }
  });

  if (!targetTable) {
    console.log('Could not find the fixtures table. Table headers found on the page:');
    $('table').each((i, table) => {
      console.log(`  Table ${i}: "${$(table).find('tr').first().text().trim().slice(0, 80)}"`);
    });
    throw new Error('Fixtures table not found — see list above to help fix the selector.');
  }

  const fixtures = [];
  let currentNote = null;

  $(targetTable).find('tr').slice(1).each((i, row) => {
    const cells = $(row).find('td');
    if (cells.length === 0) return;

    // Rows like "(The Isuzu FA Vase 1Q)" are a note about the row above, not a fixture
    const firstCellText = $(cells[0]).text().trim();
    if (firstCellText.startsWith('(')) {
      currentNote = firstCellText.replace(/[()]/g, '');
      return;
    }

    const date = firstCellText;
    const oppCell = $(cells[1]);
    const opposition = oppCell.text().trim();
    const opponentUrl = oppCell.find('a').attr('href') || null;
    const homeAway = cells.length > 2 ? $(cells[2]).text().trim() : '';
    const kickoff = cells.length > 3 ? $(cells[3]).text().trim() : '';
    const score = cells.length > 4 ? $(cells[4]).text().trim() : '';
    const scorers = cells.length > 5 ? $(cells[5]).text().trim() : '';

    fixtures.push({
      date,
      opposition,
      opponentUrl,
      homeAway,
      kickoff,
      score: score || null,
      scorers: scorers || null,
      competitionNote: currentNote,
    });

    currentNote = null;
  });

  const played = fixtures.filter(f => f.score);
  const upcoming = fixtures.filter(f => !f.score);

  return {
    scrapedAt: new Date().toISOString(),
    nextFixture: upcoming[0] || null,
    lastResult: played[played.length - 1] || null,
    allFixtures: fixtures,
  };
}

scrape()
  .then((data) => {
    fs.writeFileSync('data.json', JSON.stringify(data, null, 2));
    console.log('Saved data.json');
    console.log('Next fixture:', data.nextFixture);
    console.log('Last result:', data.lastResult);
  })
  .catch((err) => {
    console.error('Scrape failed:', err.message);
    process.exit(1);
  });