const fs = require('fs');
const CLUBS = require('./division-clubs.js');
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODE = process.env.RECAP_MODE; // 'weekend-preview', 'weekend-recap', 'midweek-preview', 'midweek-recap'
const CURRENT_CLUB_NAMES = new Set(CLUBS.map(c => c.name));
const { logCost } = require('./cost-tracker.js');

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
  // (used by weekend-recap, which only runs DURING an actual weekend)
  const day = today.getDay();
  const saturday = new Date(today);
  if (day === 0) saturday.setDate(today.getDate() - 1);
  else if (day !== 6) return null;
  const sunday = new Date(saturday);
  sunday.setDate(saturday.getDate() + 1);
  return { saturday, sunday };
}

function getNextWeekendRange(now) {
  // The NEXT upcoming Saturday-Sunday pair, regardless of what day it is today
  // (used by weekend-preview, which can run any day of the week)
  const day = now.getDay();
  let daysUntilSaturday;
  if (day === 6) daysUntilSaturday = 0;
  else if (day === 0) daysUntilSaturday = -1;
  else daysUntilSaturday = 6 - day;

  const saturday = new Date(now);
  saturday.setDate(now.getDate() + daysUntilSaturday);
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
  const now = new Date();
  const fixtures = loadFixtures();

  if (MODE === 'weekend-preview') {
    const range = getNextWeekendRange(now);
    const weekendFixtures = fixtures.filter(f => {
      const d = parseFixtureDate(f.date);
      return d && (isSameDay(d, range.saturday) || isSameDay(d, range.sunday));
    });
    return { proceed: true, periodKey: null, relevantFixtures: weekendFixtures };
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
    if (alreadyRunForPeriod(periodKey)) return { proceed: false, reason: 'Already ran for this weekend.' };
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
    if (now < cutoff) return { proceed: false, reason: `Waiting until ${cutoff.toISOString()} (latest KO + 3hrs).` };
    return { proceed: true, periodKey, relevantFixtures: weekendFixtures };
  }

  if (MODE === 'midweek-recap') {
    const todayFixtures = fixtures.filter(f => {
      const d = parseFixtureDate(f.date);
      return d && isSameDay(d, now) && !isWeekend(d);
    });
    if (todayFixtures.length === 0) return { proceed: false, reason: 'No midweek fixtures today.' };
    const periodKey = now.toISOString().slice(0, 10);
    if (alreadyRunForPeriod(periodKey)) return { proceed: false, reason: 'Already ran for today.' };
    const latestKickoff = todayFixtures.reduce((latest, f) => {
      const d = parseFixtureDate(f.date);
      const ko = kickoffToUTC(d, f.kickoff);
      return ko > latest ? ko : latest;
    }, new Date(0));
    const cutoff = new Date(latestKickoff.getTime() + 180 * 60000);
    if (now < cutoff) return { proceed: false, reason: `Waiting until ${cutoff.toISOString()} (latest KO + 3hrs).` };
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

  let sandbachOverrideNote = '';
  if (fs.existsSync('data.json')) {
    const mainData = JSON.parse(fs.readFileSync('data.json', 'utf-8'));
    const candidates = mainData.nextFixtures || (mainData.nextFixture ? [mainData.nextFixture] : []);

    const relevantDates = new Set(decision.relevantFixtures.map(f => f.date));
    const sandbachFixture = candidates.find(f => {
      const match = f.date.match(/(\d{2})\/(\d{2})\/(\d{2})/);
      if (!match) return false;
      const [, dd, mm, yy] = match;
      const asDate = new Date(2000 + parseInt(yy), parseInt(mm) - 1, parseInt(dd));
      return [...relevantDates].some(rd => {
        const parsed = parseFixtureDate(rd);
        return parsed && isSameDay(parsed, asDate);
      });
    });

    if (sandbachFixture) {
      const homeTeam = sandbachFixture.homeAway === 'H' ? 'Sandbach United' : sandbachFixture.opposition;
      const awayTeam = sandbachFixture.homeAway === 'H' ? sandbachFixture.opposition : 'Sandbach United';
      const competitionText = sandbachFixture.competitionNote ? ` (${sandbachFixture.competitionNote})` : '';

      let levelWarning = '';
      if (sandbachFixture.competitionNote) {
        const opponentInLeagueTable = fs.existsSync('league.json') &&
          JSON.parse(fs.readFileSync('league.json', 'utf-8')).standings
            .some(t => t.team === sandbachFixture.opposition);

        if (!opponentInLeagueTable) {
          levelWarning = ` IMPORTANT: ${sandbachFixture.opposition} do NOT play in Sandbach's league (First Division South) — they are a cup opponent from a different league/tier. Do NOT compare league points, form, or table position between the two teams, as this is misleading when they play at different levels. If you don't know ${sandbachFixture.opposition}'s actual league/level, simply don't speculate about it — focus on the cup occasion itself, the round, and any genuine team news instead. Do NOT explain this reasoning to the reader (e.g. do not write things like "direct league comparisons don't apply") — simply write the preview naturally without ever mentioning that a comparison was considered or avoided.`;
        }
      }

      sandbachOverrideNote = `\n\nIMPORTANT: Sandbach United's actual fixture in this period is: ${homeTeam} v ${awayTeam} (${sandbachFixture.date}, KO ${sandbachFixture.kickoff}${competitionText}). Use this REAL fixture when describing Sandbach's own match this period — do not substitute a different fixture or date for Sandbach.${levelWarning}`;
    }
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
${sandbachOverrideNote}
IMPORTANT: In the fixture list above, the format is always "Home Team v Away Team" — the first team named is always playing at home, the second team is always the visitor. Do not reverse this or infer venue/direction from anything else in the posts — always trust this explicit home/away order from the fixture list.
IMPORTANT: You MUST reference every single fixture listed above at least briefly — do not skip or omit any fixture from the list, even if it seems minor. If there isn't much to say about a fixture, a single short sentence is fine, but every fixture must be mentioned somewhere in your response.
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
${sandbachOverrideNote}
IMPORTANT: In the fixture list above, the format is always "Home Team v Away Team" — the first team named is always playing at home, the second team is always the visitor. Do not reverse this or infer venue/direction from anything else in the posts — always trust this explicit home/away order from the fixture list.
IMPORTANT: You MUST reference every single fixture listed above at least briefly — do not skip or omit any fixture from the list, even if it seems minor. If there isn't much to say about a fixture, a single short sentence is fine, but every fixture must be mentioned somewhere in your response.
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
    parsed = { sandbachFocus: raw, divisionWide: '' };
  }

  const output = {
    generatedAt: new Date().toISOString(),
    mode: MODE,
    sandbachFocus: parsed.sandbachFocus || '',
    divisionWide: parsed.divisionWide || '',
  };

  const outputFile = `division-insights-${MODE}.json`;
  fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));
  if (decision.periodKey) markRunForPeriod(decision.periodKey);

  logCost(`recap-${MODE}`, {
    getxapiCalls: 0,
    claudeCalls: 1,
    inputTokens: data.usage?.input_tokens || 0,
    outputTokens: data.usage?.output_tokens || 0,
  });
  console.log(`[${MODE}] Saved. Sandbach focus:`, (output.sandbachFocus || output.summary || '').slice(0, 150));
}

run().catch(err => {
  console.error(`[${MODE}] Failed:`, err.message);
  process.exit(1);
});
