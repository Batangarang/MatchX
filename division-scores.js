const fs = require('fs');
const CLUBS = require('./division-clubs.js');
const { getUserTweets } = require('./getxapi-client.js');
const API_KEY = process.env.GETXAPI_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const { getUKNow, getUKDateString } = require('./uk-time.js');
const REAL_NOW = new Date();
const { logCost } = require('./cost-tracker.js');

function findHandle(clubName) {
  if (clubName.includes('Sandbach')) return 'SandbachFC_1st';
  const found = CLUBS.find(c => clubName.includes(c.name) || c.name.includes(clubName));
  return found ? found.handle : null;
}

function parseFixtureDate(dateStr) {
  const match = dateStr.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/);
  if (!match) return null;
  const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const monthIndex = months.indexOf(match[2].toLowerCase());
  if (monthIndex === -1) return null;
  return new Date(parseInt(match[3]), monthIndex, parseInt(match[1]));
}

function isSameDate(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function isToday(date) {
  return date && isSameDate(date, getUKNow());
}

function isBST() {
  const m = getUKNow().getUTCMonth();
  return m > 2 && m < 9;
}

function getTodaysWindow(fixtures) {
  if (fixtures.length === 0) return null;
  const kickoffs = fixtures.map(f => {
    const [hh, min] = f.kickoff.split(':');
    const d = getUKNow();
    d.setUTCHours(parseInt(hh), parseInt(min), 0, 0);
    if (isBST()) d.setUTCHours(d.getUTCHours() - 1);
    return d;
  });
  const earliest = new Date(Math.min(...kickoffs));
  const latest = new Date(Math.max(...kickoffs));
  return {
    start: new Date(earliest.getTime() - 15 * 60000),
    // Shortened from 165 to 105 minutes after the latest kickoff — most
    // league matches are fully done well before then, cutting wasted polls
    // in the final third of the old window.
    end: new Date(latest.getTime() + 105 * 60000),
  };
}

function findTargetFixtures(fixtures, testDate) {
  if (testDate) {
    const dayFixtures = fixtures.filter(f => {
      const d = parseFixtureDate(f.date);
      return d && d.toISOString().slice(0, 10) === testDate;
    });
    return { fixtures: dayFixtures, isToday: false, targetDate: testDate };
  }

  const now = getUKNow();
  const todaysFixtures = fixtures.filter(f => isToday(parseFixtureDate(f.date)));
  if (todaysFixtures.length > 0) {
    return { fixtures: todaysFixtures, isToday: true, targetDate: getUKDateString(now) };
  }

  const futureDates = [...new Set(fixtures
    .map(f => parseFixtureDate(f.date))
    .filter(d => d && d >= now)
    .map(d => d.toISOString().slice(0, 10)))]
    .sort();

  if (futureDates.length === 0) {
    return { fixtures: [], isToday: false, targetDate: null };
  }

  const nextDateStr = futureDates[0];
  const nextDayFixtures = fixtures.filter(f => {
    const d = parseFixtureDate(f.date);
    return d && d.toISOString().slice(0, 10) === nextDateStr;
  });
  return { fixtures: nextDayFixtures, isToday: false, targetDate: nextDateStr };
}

async function run() {
  if (!API_KEY) throw new Error('GETXAPI_KEY not set');
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  if (!fs.existsSync('division-fixtures.json')) {
    console.log('No division-fixtures.json — run division-fixtures.js first.');
    return;
  }

  const { fixtures } = JSON.parse(fs.readFileSync('division-fixtures.json', 'utf-8'));
  const testDate = process.env.DIVISION_SCORES_TEST_DATE;

  const target = findTargetFixtures(fixtures, testDate);
  const todaysFixtures = target.fixtures;

  const now = getUKNow();
  const isManual = !!testDate;
  const nowUK = now.getUTCHours();

  if (target.isToday && nowUK < 11 && !isManual) {
    fs.writeFileSync('division-scores.json', JSON.stringify({
      generatedAt: REAL_NOW.toISOString(),
      date: target.targetDate,
      isToday: target.isToday,
      fixtures: todaysFixtures.map(f => ({ home: f.home, away: f.away, kickoff: f.kickoff, score: null, goals: [], redCards: [] })),
      ticker: null,
    }, null, 2));
    console.log(`Before 11am — showing ${todaysFixtures.length} fixtures, no scores yet.`);
    return;
  }

  if (todaysFixtures.length === 0) {
    fs.writeFileSync('division-scores.json', JSON.stringify({
      generatedAt: REAL_NOW.toISOString(),
      date: null,
      isToday: false,
      fixtures: [],
      ticker: null,
    }, null, 2));
    console.log('No division fixtures today or upcoming.');
    return;
  }

  if (!target.isToday) {
    fs.writeFileSync('division-scores.json', JSON.stringify({
      generatedAt: REAL_NOW.toISOString(),
      date: target.targetDate,
      isToday: false,
      fixtures: todaysFixtures.map(f => ({ home: f.home, away: f.away, kickoff: f.kickoff, score: null, goals: [], redCards: [] })),
      ticker: null,
    }, null, 2));
    console.log(`Showing next matchday (${target.targetDate}) — ${todaysFixtures.length} fixtures, ready ahead of time.`);
    return;
  }

  const window = getTodaysWindow(todaysFixtures);
  if (!isManual && window && (now < window.start || now > window.end)) {
    console.log('Outside today\'s match window — skipping poll.');
    return;
  }

  const handlesNeeded = new Set();
  todaysFixtures.forEach(f => {
    const h1 = findHandle(f.home);
    const h2 = findHandle(f.away);
    if (h1) handlesNeeded.add(h1);
    if (h2) handlesNeeded.add(h2);
  });

  const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
  const postsByHandle = {};
  for (const handle of handlesNeeded) {
    try {
      const posts = await getUserTweets(handle, API_KEY, { maxPages: 2, sinceDate: dayStart });
      postsByHandle[handle] = posts.filter(p => new Date(p.createdAt) >= dayStart);
    } catch (err) {
      console.warn(`Skipping @${handle}: ${err.message}`);
      postsByHandle[handle] = [];
    }
  }

  const allPosts = Object.entries(postsByHandle).flatMap(([handle, posts]) =>
    posts.map(p => ({ ...p, handle }))
  ).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const totalPostCount = allPosts.length;

  let previous = null;
  if (fs.existsSync('division-scores.json')) {
    previous = JSON.parse(fs.readFileSync('division-scores.json', 'utf-8'));
  }
  if (previous && previous.postCount === totalPostCount && previous.date === target.targetDate) {
    console.log('Nothing new since last check — skipping AI call.');
    return;
  }

  if (allPosts.length === 0) {
    console.log('No posts found from any club playing today.');
    return;
  }

  const postsText = allPosts.map(p => `[${p.createdAt}] (@${p.handle}) ${p.text}`).join('\n');
  const fixtureList = todaysFixtures.map(f => `${f.home} v ${f.away} (KO ${f.kickoff})`).join('\n');

  const prompt = `Here are today's First Division South fixtures:
${fixtureList}

Here are today's X posts from clubs playing today:
${postsText}

Scorelines in these posts may be written without a dash, e.g. "2 1" instead of "2-1". Recognise these as valid too, and normalise to "X-Y" form.

IMPORTANT: A club's score can change multiple times as goals are scored throughout the match. Always use the MOST RECENT scoreline mentioned for each fixture — do not use an early or outdated scoreline just because it was clearly stated, if a later post shows a different, more current score for the same fixture.

For each fixture above, determine ONLY if a score has been EXPLICITLY stated in a post — do not guess or infer from goal mentions alone, but always prefer the LATEST such mention. Also extract individual goals with minute and scorer where explicitly mentioned, matching each goal to the correct fixture. Also note any red card sent-offs explicitly mentioned, with team and player if given.

Respond with ONLY a JSON object, no other text, no markdown fences:
{
  "fixtures": [
    { "home": "string", "away": "string", "kickoff": "string", "score": "string or null", "goals": [{ "minute": null, "team": "home or away", "scorer": "string" }], "redCards": [{ "team": "home or away", "player": "string or null" }] }
  ]
}

Only include a score if explicitly stated in the posts. Leave as null if not mentioned. Match each fixture from the list above exactly.`;

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
  const parsed = JSON.parse(cleaned);

  const latestPost = allPosts[0];
  const ticker = latestPost ? `@${latestPost.handle}: ${latestPost.text}` : null;

  // If no explicit scoreline was stated but goals were extracted, derive a
  // score from the goals count rather than showing nothing at all.
  const fixturesWithDerivedScores = (parsed.fixtures || []).map(f => {
    if (f.score) return f;
    const goals = f.goals || [];
    if (goals.length === 0) return f;
    const home = goals.filter(g => g.team === 'home').length;
    const away = goals.filter(g => g.team === 'away').length;
    return { ...f, score: `${home}-${away}` };
  });

  const output = {
    generatedAt: REAL_NOW.toISOString(),
    date: target.targetDate,
    isToday: true,
    postCount: totalPostCount,
    fixtures: fixturesWithDerivedScores,
    ticker,
  };

  fs.writeFileSync('division-scores.json', JSON.stringify(output, null, 2));
  logCost('division-scores', {
    getxapiCalls: handlesNeeded.size,
    claudeCalls: 1,
    inputTokens: data.usage?.input_tokens || 0,
    outputTokens: data.usage?.output_tokens || 0,
  });
  console.log(`Saved division-scores.json with ${output.fixtures.length} fixtures`);
}

run().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
