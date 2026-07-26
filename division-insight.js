const fs = require('fs');

const API_KEY = process.env.ANTHROPIC_API_KEY;

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
  if (fs.existsSync('league.json')) {
    const leagueData = JSON.parse(fs.readFileSync('league.json', 'utf-8'));
    leagueContext = (leagueData.standings || [])
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
        content: `Here is the current North West Counties First Division South league table, including each team's form over their last 6 matches (most recent result last in the string, e.g. "LWWDLW"):

${leagueContext}

Here are the last 7 days of X posts from clubs in the division that posted anything:

${postsText || '(No clubs posted anything this week.)'}

Write a weekly round-up for Sandbach United fans covering the division. Only discuss teams that are genuinely worth mentioning — either because they had a notable X post (signing, big win, team news) or because their current form/table position is notably strong or poor (e.g. on a long winning or losing streak, near the top or bottom of the table). Do NOT list every team in the division — skip anyone with nothing interesting happening. Prioritise, in this order:
1. Teams in unusually good or bad current form, referencing their actual form string and league position
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