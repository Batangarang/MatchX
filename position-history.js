const fs = require('fs');

function run() {
  const league = JSON.parse(fs.readFileSync('league.json', 'utf-8'));
  const sandbach = league.standings.find(t => t.team.includes('Sandbach'));
  if (!sandbach) { console.log('Sandbach not found in league.json'); return; }

  const played = parseInt(sandbach.played);

  let history = [];
  if (fs.existsSync('position-history.json')) {
    history = JSON.parse(fs.readFileSync('position-history.json', 'utf-8')).history || [];
  }

  const lastEntry = history[history.length - 1];
  if (lastEntry && lastEntry.gamesPlayed >= played) {
    console.log('No new game since last snapshot — skipping.');
    return;
  }

  let opponent = null, date = null;
  if (fs.existsSync('data.json')) {
    const data = JSON.parse(fs.readFileSync('data.json', 'utf-8'));
    if (data.lastResult) {
      opponent = data.lastResult.opposition;
      date = data.lastResult.date;
    }
  }

  history.push({
    gamesPlayed: played,
    date,
    opponent,
    position: sandbach.position,
    points: parseInt(sandbach.points),
    goalsFor: parseInt(sandbach.for),
    goalsAgainst: parseInt(sandbach.against),
  });

  fs.writeFileSync('position-history.json', JSON.stringify({ generatedAt: new Date().toISOString(), history }, null, 2));
  console.log(`Saved snapshot for game ${played}: position ${sandbach.position}, ${sandbach.points}pts`);
}

run();