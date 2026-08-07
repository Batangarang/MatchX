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

  let opponent = null, date = null, gameGoalsFor = null, gameGoalsAgainst = null;
  if (fs.existsSync('data.json')) {
    const data = JSON.parse(fs.readFileSync('data.json', 'utf-8'));
    const leagueResults = (data.allFixtures || []).filter(f => f.score && !f.competitionNote);
    const lastLeagueResult = leagueResults[leagueResults.length - 1];

    if (lastLeagueResult) {
      opponent = lastLeagueResult.opposition;
      date = lastLeagueResult.date;
      const [homeScore, awayScore] = lastLeagueResult.score.replace(/^[WDL]\s*/, '').split('-').map(Number);
      gameGoalsFor = lastLeagueResult.homeAway === 'H' ? homeScore : awayScore;
      gameGoalsAgainst = lastLeagueResult.homeAway === 'H' ? awayScore : homeScore;
    }
  }

  const cumGoalsFor = parseInt(sandbach.for);
  const cumGoalsAgainst = parseInt(sandbach.against);

  history.push({
    gamesPlayed: played,
    date,
    opponent,
    position: sandbach.position,
    points: parseInt(sandbach.points),
    // Per-game — used for the bar chart, always small, can go up or down game to game
    gameGoalsFor: gameGoalsFor,
    gameGoalsAgainst: gameGoalsAgainst,
    // Cumulative — used for the running-total lines, always flat-or-rising
    cumGoalsFor,
    cumGoalsAgainst,
    cumGoalDifference: cumGoalsFor - cumGoalsAgainst,
  });

  fs.writeFileSync('position-history.json', JSON.stringify({ generatedAt: new Date().toISOString(), history }, null, 2));
  console.log(`Saved snapshot for game ${played}: pos ${sandbach.position}, ${sandbach.points}pts, game ${gameGoalsFor}-${gameGoalsAgainst} vs ${opponent}, cumulative GD ${cumGoalsFor - cumGoalsAgainst}`);
}

run();