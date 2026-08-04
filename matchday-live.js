const fs = require('fs');
const CLUBS = require('./division-clubs.js');
const { getUserIdCached } = require('./user-id-cache.js');

const BEARER_TOKEN = process.env.X_BEARER_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

function withinMatchWindow(kickoff) {
  if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') return true; // manual runs always proceed
  if (!kickoff) return false;

  const [hh, min] = kickoff.split(':');
  const now = new Date();
  const kickoffToday = new Date();
  kickoffToday.setUTCHours(parseInt(hh), parseInt(min), 0, 0);

  // UK kickoff times are local — adjust roughly for BST
  const isBST = now.getUTCMonth() > 2 && now.getUTCMonth() < 9;
  if (isBST) kickoffToday.setUTCHours(kickoffToday.getUTCHours() - 1);

  const minutesFromKickoff = (now - kickoffToday) / 60000;
  return minutesFromKickoff >= -30 && minutesFromKickoff <= 150; // 30 min before to 2.5hrs after
}

// For testing against a past date: set MATCHDAY_TEST_DATE="2026-08-01"
function getTargetFixture() {
  const data = JSON.parse(fs.readFileSync('data.json', 'utf-8'));
  const testDate = process.env.MATCHDAY_TEST_DATE;

  if (testDate) {
    return (data.allFixtures || []).find(f => {
      const [, dd, mm, yy] = f.date.match(/(\d{2})\/(\d{2})\/(\d{2})/);
      return `20${yy}-${mm}-${dd}` === testDate;
    }) || null;
  }

  const next = data.nextFixture;
  if (!next) return null;
  const [, dd, mm, yy] = next.date.match(/(\d{2})\/(\d{2})\/(\d{2})/);
  const fixtureDate = new Date(2000 + parseInt(yy), parseInt(mm) - 1, parseInt(dd));
  const today = new Date();
  const isToday = fixtureDate.getFullYear() === today.getFullYear() &&
                   fixtureDate.getMonth() === today.getMonth() &&
                   fixtureDate.getDate() === today.getDate();
  return isToday ? next : null;
}

function findHandle(clubName) {
  const found = CLUBS.find(c => clubName.includes(c.name) || c.name.includes(clubName));
  return found ? found.handle : null;
}

async function getPostsForHandle(handle, dateStr) {
  const userId = await getUserIdCached(handle, BEARER_TOKEN);
  const params = new URLSearchParams({
    max_results: '100',
    exclude: 'retweets,replies',
    'tweet.fields': 'created_at,text',
    start_time: new Date(`${dateStr}T00:00:00Z`).toISOString(),
    end_time: new Date(`${dateStr}T23:59:59Z`).toISOString(),
  });

  const res = await fetch(`https://api.x.com/2/users/${userId}/tweets?${params}`, {
    headers: { Authorization: `Bearer ${BEARER_TOKEN}` },
  });
  const data = await res.json();
  return (data.data || []).map(p => ({ text: p.text, createdAt: p.created_at }));
}

async function run() {
  if (!BEARER_TOKEN) throw new Error('X_BEARER_TOKEN not set');
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY not set');

  const fixture = getTargetFixture();
  if (!fixture) {
    console.log('No matchday fixture found — skipping.');
    return;
  }

  if (!withinMatchWindow(fixture.kickoff)) {
    console.log('Outside the matchday window — skipping.');
    return;
  }

  const [, dd, mm, yy] = fixture.date.match(/(\d{2})\/(\d{2})\/(\d{2})/);
  const dateStr = `20${yy}-${mm}-${dd}`;

  const homeHandle = fixture.homeAway === 'H' ? 'SandbachFC_1st' : findHandle(fixture.opposition);
  const awayHandle = fixture.homeAway === 'H' ? findHandle(fixture.opposition) : 'SandbachFC_1st';

  if (!homeHandle || !awayHandle) {
    console.log(`Could not resolve both handles (home=${homeHandle}, away=${awayHandle}) — skipping.`);
    return;
  }

  console.log(`Pulling matchday posts for ${dateStr}: home=@${homeHandle}, away=@${awayHandle}`);

  const [homePosts, awayPosts] = await Promise.all([
    getPostsForHandle(homeHandle, dateStr),
    getPostsForHandle(awayHandle, dateStr),
  ]);

  const combined = [
    ...homePosts.map(p => ({ ...p, side: 'home', handle: homeHandle })),
    ...awayPosts.map(p => ({ ...p, side: 'away', handle: awayHandle })),
  ].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  if (combined.length === 0) {
    console.log('No posts found from either account — skipping AI extraction.');
    return;
  }

  const postsText = combined.map(p => `[${p.createdAt}] (@${p.handle}, ${p.side} team) ${p.text}`).join('\n');

  const prompt = `Below are X posts from the home and away teams' official accounts on the day of a football match: ${fixture.homeAway === 'H' ? 'Sandbach United' : fixture.opposition} vs ${fixture.homeAway === 'H' ? fixture.opposition : 'Sandbach United'}, played ${fixture.date}.

Posts:
${postsText}

Using ONLY information present in these posts, build a structured match summary. Respond with ONLY a JSON object, no other text, no markdown fences, in exactly this shape:

{
  "score": "string or null",
  "lineups": {
    "home": { "players": [], "substitutes": [], "manager": null, "officials": [] },
    "away": { "players": [], "substitutes": [], "manager": null, "officials": [] }
  },
  "goals": [{ "minute": null, "team": "home or away", "scorer": "string" }],
  "yellowCards": [{ "minute": null, "team": "home or away", "player": "string" }],
  "redCards": [{ "minute": null, "team": "home or away", "player": "string" }],
  "substitutions": [{ "minute": null, "team": "home or away", "playerOff": "string", "playerOn": "string" }],
  "sinBins": [{ "minute": null, "team": "home or away", "player": "string" }],
  "injuries": [{ "minute": null, "team": "home or away", "player": "string", "note": "string" }],
  "addedTime": { "firstHalf": null, "secondHalf": null },
"roughXG": {
    "firstHalf": { "home": number, "away": number, "note": "string" },
    "secondHalf": { "home": number, "away": number, "note": "string" },
    "total": { "home": number, "away": number, "note": "string" },
    "disclaimer": "Rough estimate inferred from social media commentary, not real shot data — not an accurate xG figure. Values are illustrative, not calculated from actual shot data."
  },
  "matchControl": {
    "firstHalf": { "home": number, "away": number, "note": "string" },
    "secondHalf": { "home": number, "away": number, "note": "string" },
    "total": { "home": number, "away": number, "note": "string" },
    "disclaimer": "Inferred from tone/content of posts only, not real possession or shot data."
  }
}

Leave fields as empty arrays, null, or "unknown" if not mentioned. Do not invent details not present in the posts. For matchControl, "home" and "away" should be numbers that sum to 100 (a rough relative split), representing your best estimate of which side had the edge based on the commentary. For roughXG, "home" and "away" should instead be small decimal numbers in the style of real Expected Goals figures (e.g. 0.3, 0.8, 1.4, 2.1) — a rough qualitative impression of good-chance volume/quality per side based on how the posts describe the play, not a real calculated statistic. If a half isn't covered by any posts, use 0.0 for xG and 50/50 for matchControl, and say so in "note".`;

const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await res.json();
  if (!data.content) throw new Error(`Unexpected API response: ${JSON.stringify(data)}`);

  const raw = data.content.map(b => b.text || '').join('').trim();
  const cleaned = raw.replace(/```json|```/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Failed to parse AI response as JSON: ${err.message}\nRaw: ${raw}`);
  }

  cconst output = {
    generatedAt: new Date().toISOString(),
    fixtureDate: dateStr,
    kickoff: fixture.kickoff,
    homeTeam: fixture.homeAway === 'H' ? 'Sandbach United' : fixture.opposition,
    awayTeam: fixture.homeAway === 'H' ? fixture.opposition : 'Sandbach United',
    postsUsed: combined.length,
    match: parsed,
  };

  // Archive this match permanently, keyed by date — never overwritten by future matches
  if (!fs.existsSync('matchday-archive')) fs.mkdirSync('matchday-archive');
  fs.writeFileSync(`matchday-archive/${dateStr}.json`, JSON.stringify(output, null, 2));

  // Maintain an index of every archived match, so pages can link to past ones
  let index = [];
  if (fs.existsSync('matchday-index.json')) {
    index = JSON.parse(fs.readFileSync('matchday-index.json', 'utf-8'));
  }
  const entry = {
    date: dateStr,
    homeTeam: output.homeTeam,
    awayTeam: output.awayTeam,
    score: parsed.score || null,
  };
  const existing = index.find(e => e.date === dateStr);
  if (existing) {
    Object.assign(existing, entry);
  } else {
    index.push(entry);
  }
  index.sort((a, b) => new Date(b.date) - new Date(a.date));
  fs.writeFileSync('matchday-index.json', JSON.stringify(index, null, 2));

  // Also keep as "latest" — what the homepage snapshot card reads
  fs.writeFileSync('matchday-live.json', JSON.stringify(output, null, 2));

  console.log(`Saved matchday-archive/${dateStr}.json (${combined.length} posts used)`);
}

run().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});