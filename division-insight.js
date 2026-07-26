const fs = require('fs');
const CLUBS = require('./division-clubs.js');

const API_KEY = process.env.ANTHROPIC_API_KEY;
const CURRENT_CLUB_NAMES = new Set(CLUBS.map(c => c.name));

async function run() {
  if (!API_KEY) {
    throw new Error('ANTHROPIC_API_KEY environment variable not set');
  }

  if (!fs.existsSync('division-posts.json')) {
    console.log('No division-posts.json found — skipping.');
    return;
  }

  const postsData = JSON.parse(fs.readFileSync('division-posts.json', 'utf-8'));
  const clubs = postsData.clubs || [];

  let leagueContext = '';
  let seasonHasStarted = false;

  if (fs.existsSync('data.json')) {
    const mainData = JSON.parse(fs.readFileSync('data.json', 'utf-8'));
    seasonHasStarted = (mainData.allFixtures || []).some(f => !!f.score);
  }

  if (fs.existsSync('league.json')) {
    const leagueData = JSON.parse(fs.readFileSync('league.json', 'utf-8'));

    // Only include clubs that are actually in this season's roster —
    // this drops promoted/relegated clubs like Runcorn Town automatically.
    const currentStandings = (leagueData.standings || [])
      .filter(t => CURRENT_CLUB_NAMES.has(t.team) || t.team.includes('Sandbach'));

    leagueContext = currentStandings
      .map(t => `${t.position}. ${t.team} — P${t.played} W${t.won} D${t.drawn} L${t.lost} GD${t.goalDifference} Pts${t.points}${t.form ? ' — form: ' + t.form : ''}`)
      .join('\n');
  }

  const postsText = clubs
    .filter(c => c.posts.length > 0)
    .map(c => `--- ${c.name} ---\n` + c.posts.map(p => `[${p.createdAt}] ${p.text}`).join('\n'))
    .join('\n\n');

  if (!postsText && !leagueContext) {
    console.log('No posts or league data available — skipping insight generation.');
    return;
  }

  const leagueLabel = seasonHasStarted
    ? 'the current North West Counties First Division South league table'
    : "last season's FINAL North West Counties First Division South league table — the new season has not started yet, so treat this as historical context only (e.g. who was strong last season), NOT as this season's current standings or form. Do not describe any position, points, or form here as \"current\"";

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      messages: [{
        role: 'user',
        content: `Here is ${leagueLabel} (already filtered to only include clubs actually in this season's First Division South):

${leagueContext || '(no table data available)'}

Here are the last 7 days of X posts from clubs in the division that posted anything:

${postsText || '(No clubs posted anything this week.)'}

Write a weekly round-up for Sandbach United fans covering the division. Only discuss teams that are genuinely worth mentioning — either because they had a notable X post (signing, big win, team news) or because the data given shows something notably strong or poor about them. Do NOT list every team in the division — skip anyone with nothing interesting happening. Do NOT mention any club that isn't in the table/posts provided above. Prioritise, in this order:
1. Teams in unusually good or bad current form (only if the season has actually started — see note above)
2. Any high-scoring or notable results mentioned in the posts
3. Player signings, departures, or squad news

Group by theme, not club-by-club. Plain text only, no markdown, no headers. Length should reflect how much is genuinely worth saying this week — don't pad it out if it's a quiet week.`,
      }],
    }),
  });

  const data = await res.json();

  if (!data.content) {
    throw new Error(`Unexpected API response: ${JSON.stringify(data)}`);
  }

  const summary = data.content.map(b => b.text || '').join('').trim();

  const output = {
    generatedAt: new Date().toISOString(),
    seasonHasStarted,
    clubsCovered: clubs.filter(c => c.posts.length > 0).length,
    summary,
  };

  fs.writeFileSync('division-insights.json', JSON.stringify(output, null, 2));
  console.log('Saved division insight:', summary.slice(0, 200) + '...');
}

run().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});