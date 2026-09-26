const fs = require('fs');
const CLUBS = require('./division-clubs.js');
const { getUserTweetsIncremental, getCallCount } = require('./getxapi-client.js');
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
    if (!f.kickoff || typeof f.kickoff !== 'string') return getUKNow();
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
    // Widened back from 105 to 150 minutes — 105 was cutting off genuinely
    // still-live matches (confirmed 12 Sep: game still running at 16:28
    // real time, well past the old 105-min cutoff from a 15:00 kickoff).
    end: new Date(latest.getTime() + 240 * 60000),
  };
}

// Once today's fixtures have been seen, remember them in their own small file.
// nwcfl.com stops listing a fixture once it kicks off, and division-fixtures.js's
// "keep today's fixtures" logic depends on the previous file surviving intact —
// a single bad scrape or push-conflict resolution used to wipe them for the
// rest of the day. This file only ever GROWS during a day, so it can't be wiped.
const TODAY_FIXTURES_FILE = 'division-fixtures-today.json';

function fixtureKey(f) {
  return `${(f.home || '').toLowerCase()}|${(f.away || '').toLowerCase()}`;
}

function loadSavedTodayFixtures(dateStr) {
  try {
    if (!fs.existsSync(TODAY_FIXTURES_FILE)) return [];
    const saved = JSON.parse(fs.readFileSync(TODAY_FIXTURES_FILE, 'utf-8'));
    return saved.date === dateStr && Array.isArray(saved.fixtures) ? saved.fixtures : [];
  } catch {
    return [];
  }
}

function saveTodayFixtures(dateStr, fixtures) {
  const payload = JSON.stringify({ date: dateStr, fixtures }, null, 2);
  try {
    if (fs.existsSync(TODAY_FIXTURES_FILE) && fs.readFileSync(TODAY_FIXTURES_FILE, 'utf-8') === payload) return;
  } catch {}
  fs.writeFileSync(TODAY_FIXTURES_FILE, payload);
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
  const todayStr = getUKDateString(now);
  const freshToday = fixtures.filter(f => isToday(parseFixtureDate(f.date)));
  const savedToday = loadSavedTodayFixtures(todayStr);

  // DEBUG: shows exactly what the fixture lookup saw, so a mid-match failure
  // can be diagnosed from the run log instead of guessed at.
  const distinctDates = [...new Set(fixtures.map(f => f.date))].slice(0, 4);
  console.log(`DEBUG fixtures: UK today=${todayStr} | in division-fixtures.json=${fixtures.length} (first dates: ${JSON.stringify(distinctDates)}) | matching today=${freshToday.length} | saved-today file=${savedToday.length}`);

  // Fresh scrape + anything already saved for today (a fixture that has kicked
  // off drops off the source page, but stays known via the saved file).
  const freshKeys = new Set(freshToday.map(fixtureKey));
  const todaysFixtures = [...freshToday, ...savedToday.filter(f => !freshKeys.has(fixtureKey(f)))];
  if (todaysFixtures.length > 0) {
    if (todaysFixtures.length !== savedToday.length) saveTodayFixtures(todayStr, todaysFixtures);
    if (todaysFixtures.length !== freshToday.length) {
      console.log(`Today's fixture list restored from saved-today file (${todaysFixtures.length - freshToday.length} fixture(s) had dropped off the scrape).`);
    }
    return { fixtures: todaysFixtures, isToday: true, targetDate: todayStr };
  }

  // Genuine race condition: division-fixtures.js briefly wipes today's
  // fixtures mid-match before its own preservation logic restores them.
  // If our own previous output still shows today as a live matchday,
  // trust that over an empty fixture list this one cycle, rather than
  // jumping ahead to next Saturday's fixtures.
  if (fs.existsSync('division-scores.json')) {
    try {
      const previousOutput = JSON.parse(fs.readFileSync('division-scores.json', 'utf-8'));
      if (previousOutput.isToday && previousOutput.date === getUKDateString(now)) {
        console.log('Today\'s fixtures missing from BOTH the scrape and the saved-today file — reusing previous division-scores.json fixture list for this cycle.');
        return { fixtures: previousOutput.fixtures.map(f => ({ home: f.home, away: f.away, kickoff: f.kickoff })), isToday: true, targetDate: getUKDateString(now) };
      }
    } catch {}
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
  // MANUAL_RUN is only set when the admin page's "Run now" passes manual=true.
  // cron-job.org dispatches the same workflow WITHOUT it, so automated runs stay gated.
  const isManual = !!testDate || process.env.MANUAL_RUN === 'true';
  if (isManual) console.log('Manual run — bypassing time-window and "nothing new" gates.');
  const nowUK = now.getUTCHours();

  if (target.isToday && nowUK < 11 && !isManual) {
    fs.writeFileSync('division-scores.json', JSON.stringify({
      generatedAt: REAL_NOW.toISOString(),
      date: target.targetDate,
      isToday: target.isToday,
      fixtures: todaysFixtures.map(f => ({ home: f.home, away: f.away, kickoff: f.kickoff, score: null, goals: [], yellowCards: [], redCards: [] })),
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
  console.log('DEBUG window check — now:', now.toISOString(), '| window start:', window?.start?.toISOString(), '| window end:', window?.end?.toISOString(), '| fixtures used:', JSON.stringify(todaysFixtures.map(f => f.kickoff)));
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

  // Incremental fetch: keep today's posts in a cache file and only ask
  // GetXAPI for anything newer, so a normal poll is ~1 call per club instead
  // of re-paging the whole day for every club on every run.
  const CACHE_FILE = 'division-scores-cache.json';
  let cache = { date: null, posts: {} };
  try {
    if (fs.existsSync(CACHE_FILE)) cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
  } catch {}
  if (cache.date !== target.targetDate) cache = { date: target.targetDate, posts: {} };

  const postsByHandle = {};
  for (const handle of handlesNeeded) {
    try {
      const posts = await getUserTweetsIncremental(handle, API_KEY, {
        cached: cache.posts[handle] || [],
        floorDate: dayStart,
        maxPagesFresh: 2,
        maxPagesIncremental: 2,
      });
      postsByHandle[handle] = posts;
      cache.posts[handle] = posts;
    } catch (err) {
      console.warn(`Skipping @${handle}: ${err.message}`);
      // keep whatever we already had rather than treating a failed call as "posted nothing"
      postsByHandle[handle] = cache.posts[handle] || [];
    }
  }
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));

  const allPosts = Object.entries(postsByHandle).flatMap(([handle, posts]) =>
    posts.map(p => ({ ...p, handle }))
  ).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const totalPostCount = allPosts.length;
  const latestPostTimestamp = allPosts[0]?.createdAt || null;
  let previous = null;
  if (fs.existsSync('division-scores.json')) {
    previous = JSON.parse(fs.readFileSync('division-scores.json', 'utf-8'));
  }
  if (
    previous &&
    previous.postCount === totalPostCount &&
    previous.latestPostTimestamp === latestPostTimestamp &&
    previous.date === target.targetDate &&
    !isManual
  ) {
    console.log('Nothing new since last check — skipping AI call.');
    logCost('division-scores', { getxapiCalls: getCallCount() });
    return;
  }
  if (allPosts.length === 0) {
    console.log('No posts found from any club playing today.');
    logCost('division-scores', { getxapiCalls: getCallCount() });
    return;
  }

  const postsText = allPosts.map(p => `[${p.createdAt}] (@${p.handle}) ${p.text}`).join('\n');
  const fixtureList = todaysFixtures.map(f => `${f.home} v ${f.away} (KO ${f.kickoff})`).join('\n');

  const prompt = `Here are today's First Division South fixtures:
${fixtureList}

Here are today's X posts from clubs playing today:
${postsText}

Scorelines in these posts may be written without a dash, e.g. "2 1" instead of "2-1", or with the word "nil" (e.g. "1 nil", "one-nil", "2-nil" = 2-0). Recognise these as valid too, and normalise to "X-Y" form (home-away).

IMPORTANT: A club's score can change multiple times as goals are scored throughout the match. Always use the MOST RECENT scoreline mentioned for each fixture — do not use an early or outdated scoreline just because it was clearly stated, if a later post shows a different, more current score for the same fixture.

For each fixture above, determine ONLY if a score has been EXPLICITLY stated in a post — do not guess or infer from goal mentions alone, but always prefer the LATEST such mention. Also extract individual goals with minute and scorer where explicitly mentioned, matching each goal to the correct fixture. Also note any red card sent-offs explicitly mentioned, with team and player if given.

IMPORTANT: Clubs often use colour-coded circle emoji instead of names in their live scoreline updates (e.g. "🔴🔵0-0⚫️⚪️"). These emoji colours can look similar or identical across different clubs and different fixtures happening on the same day — do NOT rely on emoji colour alone to decide which fixture a scoreline belongs to. Always match a post to the correct fixture using the ACCOUNT HANDLE that posted it (shown in brackets before each post) cross-referenced against the fixture list's home/away clubs — never assume from emoji colour alone. If genuinely unsure which fixture a scoreline update belongs to, prefer matching by handle over emoji.

IMPORTANT: Distinguish clearly between yellow cards and red cards — only put a card in "redCards" if it's explicitly a red card, straight red, or second yellow leading to a sending off. A single yellow card booking belongs in "yellowCards", never "redCards".
Respond with ONLY a JSON object, no other text, no markdown fences:
{
  "fixtures": [
    { "home": "string", "away": "string", "kickoff": "string", "score": "string or null", "matchStage": "one of: scheduled, first_half, half_time, second_half, full_time — ONLY set half_time or full_time when a post EXPLICITLY announces it (e.g. 'HT', 'Half time score:', 'FT', 'Full time:') — never guess from elapsed time or infer from a lack of updates", "goals": [{ "minute": null, "team": "home or away", "scorer": "string" }], "yellowCards": [{ "team": "home or away", "player": "string or null" }], "redCards": [{ "team": "home or away", "player": "string or null" }] }
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
    if (f.score) return { ...f, scoreSource: 'explicit', matchStage: f.matchStage || 'scheduled' };
    const goals = f.goals || [];
    if (goals.length === 0) return { ...f, matchStage: f.matchStage || 'scheduled' };
    const home = goals.filter(g => g.team === 'home').length;
    const away = goals.filter(g => g.team === 'away').length;
    // scoreSource lets matchday-live tell a stated scoreline apart from one we only inferred by counting goals
    return { ...f, score: `${home}-${away}`, scoreSource: 'derived', matchStage: f.matchStage || 'scheduled' };
 });

    const output = {
    generatedAt: REAL_NOW.toISOString(),
    date: target.targetDate,
    isToday: true,
    postCount: totalPostCount,
    latestPostTimestamp,
    fixtures: fixturesWithDerivedScores,
    ticker,
  };

  fs.writeFileSync('division-scores.json', JSON.stringify(output, null, 2));
  logCost('division-scores', {
    getxapiCalls: getCallCount(),
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
