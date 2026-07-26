const fs = require('fs');

function run() {
  if (!fs.existsSync('data.json')) {
    throw new Error('data.json not found — run scrape.js first');
  }

  const data = JSON.parse(fs.readFileSync('data.json', 'utf-8'));
  const allFixtures = data.allFixtures || [];

  // Only genuine league fixtures — cup ties (which have a competitionNote)
  // can be against clubs outside First Division South, so we exclude them
  // to keep the roster accurate to the actual division membership.
  const leagueFixtures = allFixtures.filter(f => !f.competitionNote);

  const rosterMap = {};
  leagueFixtures.forEach(f => {
    if (!f.opponentUrl) return;
    const idMatch = f.opponentUrl.match(/id=(\d+)/);
    const clubId = idMatch ? idMatch[1] : null;
    if (!clubId) return;

    if (!rosterMap[clubId]) {
      rosterMap[clubId] = {
        clubId,
        name: f.opposition,
        clubUrl: `https://www.nwcfl.com/${f.opponentUrl}`,
      };
    }
  });

  const roster = Object.values(rosterMap).sort((a, b) => a.name.localeCompare(b.name));

  const output = {
    generatedAt: new Date().toISOString(),
    division: 'First Division South',
    clubCount: roster.length,
    roster,
  };

  fs.writeFileSync('division-roster.json', JSON.stringify(output, null, 2));
  console.log(`Derived roster of ${roster.length} clubs:`);
  roster.forEach(c => console.log(`  ${c.name} (id=${c.clubId})`));
}

run();