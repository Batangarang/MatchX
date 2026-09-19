const fs = require('fs');
const CLUBS = require('./division-clubs.js');
const { logCost } = require('./cost-tracker.js');
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODE = process.env.RECAP_MODE; // 'preview' or 'recap'
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
  if (!kickoff || typeof kickoff !== 'string') return new Date(dateObj);
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

function getWeekAheadRange(now) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setDate(end.getDate() + 7);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

function getWeekBehindRange(now) {
  const start = new Date(now);
  start.setDate(start.getDate() - 7);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

function shouldRunNow() {
  const now = new Date();
  const fixtures = loadFixtures();

  if (MODE === 'preview') {
    const range = getWeekAheadRange(now);
    const weekFixtures = fixtures.filter(f => {
      const d = parseFixtureDate(f.date);
      return d && d >= range.start && d <= range.end;
    });
    if (weekFixtures.length === 0) return { proceed: false, reason: 'No fixtures in the coming week.' };
    return { proceed: true, periodKey: null, relevantFixtures: weekFixtures };
  }

  if (MODE === 'recap') {
    const range = getWeekBehindRange(now);
    const weekFixtures = fixtures.filter(f => {
      const d = parseFixtureDate(f.date);
      return d && d >= range.start && d <= range.end;
    });
    if (weekFixtures.length === 0) return { proceed: false, reason: 'No fixtures in the past week.' };

    const latestKickoff = weekFixtures.reduce((latest, f) => {
      const d = parseFixtureDate(f.date);
      const ko = kickoffToUTC(d, f.kickoff);
      return ko > latest ? ko : latest;
    }, new Date(0));

    const periodKey = latestKickoff.toISOString().slice(0, 10);
    if (alreadyRunForPeriod(periodKey)) return { proceed: false, reason: 'Already ran for this period.' };

    const cutoff = new Date(latestKickoff.getTime() + 150 * 60000);
    if (now < cutoff) return { proceed: false, reason: `Waiting until ${cutoff.toISOString()} (latest KO + 2.5hrs).` };

    return { proceed: true, periodKey, relevantFixtures: weekFixtures };
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
      .map(t => `${t.position}. ${t.team} — P${t.played} W${t.won} D${t.drawn} L${t.lost} GD${t.goalDifference} Pts${t.points}${t.form ? ' — recent form (NEWEST result first, so the FIRST letter is their most recent result): ' + t.form.split('').join('-') : ''}`)
      .join('\n');
  }

  let sandbachOverrideNote = '';
  let sandbachFormNote = '';
  if (fs.existsSync('league.json')) {
    const leagueData = JSON.parse(fs.readFileSync('league.json', 'utf-8'));
    const sandbachStanding = leagueData.standings.find(t => t.team.includes('Sandbach'));
    if (sandbachStanding && sandbachStanding.form) {
      const formLetters = sandbachStanding.form.split('');
      const resultWords = { W: 'WIN', D: 'DRAW', L: 'LOSS' };
      const mostRecent = resultWords[formLetters[0]] || formLetters[0];
      const recentSequence = formLetters.slice(0, 5).map(f => resultWords[f] || f).join(', ');
      sandbachFormNote = `\n\nFACT (already computed for you, do not recalculate or contradict this): Sandbach United's MOST RECENT result was a ${mostRecent}. Their last 5 results in order from most recent to oldest were: ${recentSequence}. They are currently ${sandbachStanding.position === 1 ? '1st' : sandbachStanding.position + (sandbachStanding.position === 2 ? 'nd' : sandbachStanding.position === 3 ? 'rd' : 'th')} in the table with ${sandbachStanding.points} points from ${sandbachStanding.played} games. Do not describe them as being on a losing streak or having recently lost multiple games unless the sequence above genuinely shows that.`;
    }
  }

  if (fs.existsSync('data.json')) {
    const mainData = JSON.parse(fs.readFileSync('data.json', 'utf-8'));
    const candidates = mainData.nextFixtures || (mainData.nextFixture ? [mainData.nextFixture] : []);

    const relevantDatesForSandbach = new Set(decision.relevantFixtures.map(f => f.date));
    const sandbachFixtures = candidates.filter(f => {
      const match = f.date.match(/(\d{2})\/(\d{2})\/(\d{2})/);
      if (!match) return false;
      const [, dd, mm, yy] = match;
      const asDate = new Date(2000 + parseInt(yy), parseInt(mm) - 1, parseInt(dd));
      return [...relevantDatesForSandbach].some(rd => {
        const parsed = parseFixtureDate(rd);
        return parsed && isSameDay(parsed, asDate);
      });
    });

    if (sandbachFixtures.length > 0) {
      const fixtureDescriptions = sandbachFixtures.map(sandbachFixture => {
        const homeTeam = sandbachFixture.homeAway === 'H' ? 'Sandbach United' : sandbachFixture.opposition;
        const awayTeam = sandbachFixture.homeAway === 'H' ? sandbachFixture.opposition : 'Sandbach United';
        const competitionText = sandbachFixture.competitionNote ? ` (${sandbachFixture.competitionNote})` : '';

        let levelWarning = '';
        if (sandbachFixture.competitionNote) {
          const opponentInLeagueTable = fs.existsSync('league.json') &&
            JSON.parse(fs.readFileSync('league.json', 'utf-8')).standings
              .some(t => t.team === sandbachFixture.opposition);

          if (!opponentInLeagueTable) {
            levelWarning = ` (${sandbachFixture.opposition} do NOT play in Sandbach's league — a cup opponent from a different tier, do not compare league points/form/table position)`;
          }
        }

        return `${homeTeam} v ${awayTeam} (${sandbachFixture.date}, KO ${sandbachFixture.kickoff}${competitionText})${levelWarning}`;
      }).join('; ');

      sandbachOverrideNote = `\n\nIMPORTANT: Sandbach United's actual real fixture(s) in this period: ${fixtureDescriptions}. If Sandbach played/play more than once this period, mention BOTH results/fixtures — do not just cover one. Use these REAL fixtures when describing Sandbach's own match(es) this period — do not substitute a different fixture or date.`;
    }
  }

  const fixtureList = decision.relevantFixtures.map(f => `${f.home} v ${f.away} (${f.date}, KO ${f.kickoff})`).join('\n');

  const EARLIEST_RELEVANT_HOUR_UTC = 9;
  const relevantClubNames = new Set(decision.relevantFixtures.flatMap(f => [f.home, f.away]));
  const relevantDates = new Set(decision.relevantFixtures.map(f => {
    const d = parseFixtureDate(f.date);
    return d ? d.toDateString() : null;
  }).filter(Boolean));

  const postsText = clubs
    .filter(c => relevantClubNames.has(c.name) && c.posts.length > 0)
    .map(c => {
      const relevantPosts = c.posts.filter(p => {
        const postDate = new Date(p.createdAt);
        return relevantDates.has(postDate.toDateString()) && postDate.getUTCHours() >= EARLIEST_RELEVANT_HOUR_UTC;
      });
      if (relevantPosts.length === 0) return null;
      return `--- ${c.name} ---\n` + relevantPosts.map(p => `[${p.createdAt}] ${p.text}`).join('\n');
    })
    .filter(Boolean)
    .join('\n\n');

  const isPreview = MODE === 'preview';
  const periodLabel = isPreview ? 'the coming week' : 'the past week';

  const prompt = isPreview
    ? `Here are the First Division South fixtures coming up over ${periodLabel}:
${fixtureList}
${sandbachOverrideNote}${sandbachFormNote}
IMPORTANT: In the fixture list above, the format is always "Home Team v Away Team" — the first team named is always playing at home, the second team is always the visitor. Do not reverse this or infer venue/direction from anything else in the posts — always trust this explicit home/away order from the fixture list.
IMPORTANT: You MUST reference every single fixture listed above at least briefly — do not skip or omit any fixture from the list, even if it seems minor. If there isn't much to say about a fixture, a single short sentence is fine, but every fixture must be mentioned somewhere in your response.
CRITICAL: Only state facts that are directly supported by the league table data or the X posts provided above. Do NOT invent results, a losing streak, a table position change, or a specific points gap unless it is explicitly confirmed by the data given. If you are not certain about a specific detail, describe the situation more generally rather than stating something specific that might be wrong. Cross-check any claim about recent form or results against the "form" field in the league table and the actual posts before stating it.
Here is the current league table:
${leagueContext}
Here are recent X posts from clubs in the division:
${postsText || '(No recent posts.)'}
Respond with ONLY a JSON object, no other text, no markdown fences, in exactly this shape:
{
  "sandbachFocus": "2-4 sentences specifically previewing Sandbach United's own upcoming fixture(s) this week — opponent(s), venue (remember: trust the home/away order given above), and anything notable. If they have more than one fixture, cover both.",
  "divisionWide": "A separate preview covering the REST of the division's upcoming fixtures this week — highlight anything notable (title-race relevance, in-form teams, key clashes). Group by theme, not club-by-club. Do NOT repeat Sandbach's own fixture(s) here, that's covered separately above."
}`
    : `Here are the First Division South fixtures that were played over ${periodLabel}:
${fixtureList}
${sandbachOverrideNote}${sandbachFormNote}
IMPORTANT: In the fixture list above, the format is always "Home Team v Away Team" — the first team named is always playing at home, the second team is always the visitor. Do not reverse this or infer venue/direction from anything else in the posts — always trust this explicit home/away order from the fixture list.
IMPORTANT: You MUST reference every single fixture listed above at least briefly — do not skip or omit any fixture from the list, even if it seems minor. If there isn't much to say about a fixture, a single short sentence is fine, but every fixture must be mentioned somewhere in your response.
CRITICAL: Only state facts that are directly supported by the league table data or the X posts provided above. Do NOT invent results, a losing streak, a table position change, or a specific points gap unless it is explicitly confirmed by the data given. If you are not certain about a specific detail, describe the situation more generally rather than stating something specific that might be wrong. Cross-check any claim about recent form or results against the "form" field in the league table and the actual posts before stating it.
Here is the current league table:
${leagueContext}
Here are recent X posts from clubs in the division:
${postsText || '(No recent posts.)'}
Respond with ONLY a JSON object, no other text, no markdown fences, in exactly this shape:
{
  "sandbachFocus": "2-4 sentences specifically about Sandbach United's own result(s) this week — what happened, the scoreline(s), any standout performances or incidents. If they played more than once, cover both results.",
  "divisionWide": "A separate round-up covering the REST of the division — teams in unusually good or bad form, notable results, table movement, player signings or squad news. Group by theme, not club-by-club. Only discuss teams with genuinely notable news or results — skip anyone with nothing interesting to report. Do NOT repeat Sandbach's own result(s) here, that's covered separately above."
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

  fs.writeFileSync(`division-insights-${MODE}.json`, JSON.stringify(output, null, 2));
  if (decision.periodKey) markRunForPeriod(decision.periodKey);

  logCost(`recap-${MODE}`, {
    getxapiCalls: 0,
    claudeCalls: 1,
    inputTokens: data.usage?.input_tokens || 0,
    outputTokens: data.usage?.output_tokens || 0,
  });

  console.log(`[${MODE}] Saved. Sandbach focus:`, (output.sandbachFocus || '').slice(0, 150));
}

run().catch(err => {
  console.error(`[${MODE}] Failed:`, err.message);
  process.exit(1);
});
