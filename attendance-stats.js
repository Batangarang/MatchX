const cheerio = require('cheerio');
const fs = require('fs');

const URL = 'https://www.nwcfl.com/results.php?comp=47';
const SANDBACH_URL = 'clubpage.php?id=803';

async function scrape() {
  const res = await fetch(URL);
  const html = await res.text();
  const $ = cheerio.load(html);

  const games = [];

  $('tr, li').each((i, el) => {
    const rowText = $(el).text();
    if (!rowText.includes('Att:')) return;

    const links = $(el).find('a[href*="clubpage.php"]');
    if (links.length < 2) return;

    const homeHref = $(links[0]).attr('href');
    const awayHref = $(links[1]).attr('href');
    const homeName = $(links[0]).text().trim();
    const awayName = $(links[1]).text().trim();

    // Only interested in Sandbach's HOME matches for this feature
    if (!homeHref.includes('id=803')) return;

    const scoreMatch = rowText.match(/(\d+)\s*-\s*(\d+)/);
    const attMatch = rowText.match(/Att:\s*(\d+)/);
    if (!scoreMatch || !attMatch) return;

    games.push({
      opponent: awayName,
      score: `${scoreMatch[1]}-${scoreMatch[2]}`,
      attendance: parseInt(attMatch[1]),
    });
  });

  // Dedupe (the page shows both a compact and a detailed version of each match)
  const seen = new Set();
  const deduped = games.filter(g => {
    const key = `${g.opponent}-${g.attendance}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (deduped.length === 0) {
    console.log('No Sandbach home matches with attendance found. Check the page structure — may need adjusting.');
    fs.writeFileSync('attendance-stats.json', JSON.stringify({ generatedAt: new Date().toISOString(), games: [], average: null, lowest: null, highest: null }, null, 2));
    return;
  }

  const average = Math.round(deduped.reduce((sum, g) => sum + g.attendance, 0) / deduped.length);
  const lowest = deduped.reduce((min, g) => g.attendance < min.attendance ? g : min);
  const highest = deduped.reduce((max, g) => g.attendance > max.attendance ? g : max);

  fs.writeFileSync('attendance-stats.json', JSON.stringify({
    generatedAt: new Date().toISOString(),
    games: deduped,
    average,
    lowest,
    highest,
  }, null, 2));

  console.log(`Saved attendance-stats.json — ${deduped.length} home games, avg ${average}`);
  console.log(deduped);
}

scrape().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});