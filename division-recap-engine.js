const fs = require('fs');
const CLUBS = require('./division-clubs.js');

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODE = process.env.RECAP_MODE; // 'weekend-preview', 'weekend-recap', 'midweek-preview', 'midweek-recap'
const CURRENT_CLUB_NAMES = new Set(CLUBS.map(c => c.name));

function parseFixtureDate(dateStr) {
  const match = dateStr.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/);
  if (!match) return null;
  const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const monthIndex = months.indexOf(match[2].toLowerCase());
  if (monthIndex === -1) return null;
  return new Date(parseInt(match[3]), monthIndex, parseInt(match[1]));
}

function isBST() {
  const m = new Date().getUTCMonth();
  return m > 2 && m < 9;
}

function kickoffToUTC(dateObj, kickoff) {
  const [hh, min] = kickoff.split(':');
  const d = new Date(dateObj);
  d.setUTCHours(parseInt(hh), parseInt(min), 0, 0);
  if (isBST()) d.setUTCHours(d.getUTCHours() - 1);
  return d;
}

function loadFixtures() {
  if (!fs.existsSync('division-fixtures.json')) return [];
  return JSON.parse(fs.readFileSync('division-fixtures.json', 'utf-8')).fixtures || [];
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function isWeekend(date) {
  const day = date.getDay(); // 0 = Sunday, 6 = Saturday
  return day === 0 || day === 6;
}

function getWeekendRange(today) {
  // The Saturday-Sunday pair containing or most recently including today
  const day = today.getDay();
  const saturday = new Date(today);
  if (day === 0) saturday.setDate(today.getDate() - 1); // if Sunday, Saturday was yesterday
  else if (day !== 6) return null; // not currently in a weekend window
  const sunday = new Date(saturday);
  sunday.setDate(saturday.getDate() + 1);
  return { saturday, sunday };
}

function getStateFile() {
  return `.recap-state-${MODE}.json`;
}

function alreadyRunForPeriod(periodKey) {
  const stateFile = getStateFile();
  if (!fs.existsSync(stateFile)) return false;
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    return state.lastPeriod === periodKey;
  } catch {
    return false;
  }
}

function markRunForPeriod(periodKey) {
  fs.writeFileSync(getStateFile(), JSON.stringify({ lastPeriod: periodKey, ranAt: new Date().toISOString() }));
}

function shouldRunNow() {
  const isManual = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';
  const now = new Date();
  const fixtures = loadFixtures();

  if (MODE === 'weekend-preview') {
    // Runs Friday, always fine to regenerate — no special window needed
    return { proceed: true, periodKey: null, relevantFixtures: fixtures.filter(f => {
      const d = parseFixtureDate(f.date);
      return d && isWeekend(d);
    }) };
  }

  if (MODE === 'midweek-preview') {
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    const tomorrowFixtures = fixtures.filter(f => {
      const d = parseFixtureDate(f.date);
      return d && isSameDay(d, tomorrow) && !isWeekend(d);
    });
    if (tomorrowFixtures.length === 0) return { proceed: false, reason: 'No midweek fixtures tomorrow.' };
    return { proceed: true, periodKey: null, relevantFixtures: tomorrowFixtures };
  }

  if (MODE === 'weekend-recap') {
    const range = getWeekendRange(now);
    if (!range) return { proceed: false, reason: 'Not currently within a weekend.' };

    const periodKey = range.saturday.toISOString().slice(0, 10);
    if (!isManual && alreadyRunForPeriod(periodKey)) return { proceed: false, reason: 'Already ran for this weekend.' };

    const weekendFixtures = fixtures.filter(f => {
      const d = parseFixtureDate(f.date);
      return d && (isSameDay(d, range.saturday) || isSameDay(d, range.sunday));
    });
    if (weekendFixtures.length === 0) return { proceed: false, reason: 'No weekend fixtures found.' };

    const latestKickoff = weekendFixtures.reduce((latest, f) => {
      const d = parseFixtureDate(f.date);
      const ko = kickoffToUTC(d, f.kickoff);
      return ko > latest ? ko : latest;
    }, new Date(0));

    const cutoff = new Date(latestKickoff.getTime() + 180 * 60000);
    if (!isManual && now < cutoff) return { proceed: false, reason: `Waiting until ${cutoff.toISOString()} (latest KO + 3hrs).` };

    return { proceed: true, periodKey, relevantFixtures: weekendFixtures };
  }

  if (MODE === 'midweek-recap') {
    const todayFixtures = fixtures.filter(f => {
      const d = parseFixtureDate(f.date);
      return d && isSameDay(d, now) && !isWeekend(d);
    });
    if (todayFixtures.length === 0) return { proceed: false, reason: 'No midweek fixtures today.' };

    const periodKey = now.toISOString().slice(0, 10);
    if (!isManual && alreadyRunForPeriod(periodKey)) return { proceed: false, reason: 'Already ran for today.' };

    const latestKickoff = todayFixtures.reduce((latest, f) => {
      const d = parseFixtureDate(f.date);
      const ko = kickoffToUTC(d, f.kickoff);
      return ko > latest ? ko : latest;
    }, new Date(0));

    const cutoff = new Date(latestKickoff.getTime() + 180 * 60000);
    if (!isManual && now < cutoff) return { proceed: false, reason: `Waiting until ${cutoff.toISOString()} (latest KO + 3hrs).` };

    return { proceed: true, periodKey, relevantFixtures: todayFixtures };
  }

  return { proceed: false, reason: 'Unknown mode.' };
}

async function run() {
  if (!API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  if (!MODE) throw new Error('RECAP_MODE not set');

  const decision = shouldRunNow();
  if (!decision.proceed) {
    console.log(`[${MODE}] Skipping: ${decision.reason || 'condition not met'}`);
    return;
  }

  if (!fs.existsSync('division-posts.json')) {
    console.log('No division-posts.json found — run division-posts.js first.');
    return;
  }

  const postsData = JSON.parse(fs.readFileSync('division-posts.json', 'utf-8'));
  const clubs = postsData.clubs || [];

  let leagueContext = '';
  if (fs.existsSync('league.json')) {
    const leagueData = JSON.parse(fs.readFileSync('league.json', 'utf-8'));
    const currentStandings = (leagueData.standings || [])
      .filter(t => CURRENT_CLUB_NAMES.has(t.team) || t.team.includes('Sandbach'));
    leagueContext = currentStandings
      .map(t => `${t.position}. ${t.team} — P${t.played} W${t.won} D${t.drawn} L${t.lost} GD${t.goalDifference} Pts${t.points}${t.form ? ' — form: ' + t.form : ''}`)
      .join('\n');
  }

  const fixtureList = decision.relevantFixtures.map(f => `${f.home} v ${f.away} (${f.date}, KO ${f.kickoff})`).join('\n');

  const postsText = clubs
    .filter(c => c.posts.length > 0)
    .map(c => `--- ${c.name} ---\n` + c.posts.map(p => `[${p.createdAt}] ${p.text}`).join('\n'))
    .join('\n\n');

  const isPreview = MODE.includes('preview');
  const periodLabel = MODE.startsWith('weekend') ? 'this weekend' : 'today';

  const prompt = isPreview
    ? `Here are the upcoming First Division South fixtures for ${periodLabel}:
${fixtureList}
IMPORTANT: In the fixture list above, the format is always "Home Team v Away Team" — the first team named is always playing at home, the second team is always the visitor. Do not reverse this or infer venue/direction from anything else in the posts — always trust this explicit home/away order from the fixture list.
Here is the current league table:
${leagueContext}
Here are recent X posts from clubs in the division:
${postsText || '(No recent posts.)'}
Respond with ONLY a JSON object, no other text, no markdown fences, in exactly this shape:
{
  "sandbachFocus": "2-4 sentences specifically previewing Sandbach United's own upcoming fixture(s) this period — opponent, venue (remember: trust the home/away order given above), and anything notable about the matchup",
  "divisionWide": "A separate preview covering the REST of the division's upcoming fixtures this period — highlight anything notable (title-race relevance, in-form teams, key clashes). Group by theme, not club-by-club. Do NOT repeat Sandbach's own fixture here, that's covered separately above."
}`
    : `Here are the First Division South fixtures that were played ${periodLabel}:
${fixtureList}
IMPORTANT: In the fixture list above, the format is always "Home Team v Away Team" — the first team named is always playing at home, the second team is always the visitor. Do not reverse this or infer venue/direction from anything else in the posts — always trust this explicit home/away order from the fixture list.
Here is the current league table:
${leagueContext}
Here are recent X posts from clubs in the division:
${postsText || '(No recent posts.)'}
Respond with ONLY a JSON object, no other text, no markdown fences, in exactly this shape:
{
  "sandbachFocus": "2-4 sentences specifically about Sandbach United's own result(s) this period — what happened, the scoreline, any standout performances or incidents",
  "divisionWide": "A separate round-up covering the REST of the division — teams in unusually good or bad form, notable results, table movement, player signings or squad news. Group by theme, not club-by-club. Only discuss teams with genuinely notable news or results — skip anyone with nothing interesting to report. Do NOT repeat Sandbach's own result here, that's covered separately above."
}`;
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
    // Fall back gracefully if parsing fails, rather than losing the whole run
    parsed = { sandbachFocus: raw, divisionWide: '' };
  }

  const output = {
    generatedAt: new Date().toISOString(),
    mode: MODE,
    sandbachFocus: parsed.sandbachFocus || '',
    divisionWide: parsed.divisionWide || '',
  };

  fs.writeFileSync(`division-insights-${MODE}.json`, JSON.stringify(output, null, 2));
  if (decision.periodKey) markRunForPeriod(decision.periodKey);

  console.log(`[${MODE}] Saved. Sandbach focus:`, (output.sandbachFocus || output.summary || '').slice(0, 150));
}

run().catch(err => {
  console.error(`[${MODE}] Failed:`, err.message);
  process.exit(1);
});