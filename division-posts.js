const fs = require('fs');
const CLUBS = require('./division-clubs.js');
const { getUserTweetsIncremental, getCallCount } = require('./getxapi-client.js');
const { logCost } = require('./cost-tracker.js');

const API_KEY = process.env.GETXAPI_KEY;
const SEVEN_DAYS_AGO = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
// Widened from 60 given real-world evidence of overlapping-workflow cost.
// On a day with NO First Division South fixtures, club posts barely change
// between checks, so the window is widened further to cut background cost
// (~190-210 GetXAPI calls/day was the single biggest non-matchday cost item).
const FRESHNESS_MINUTES_MATCHDAY = 120;
const FRESHNESS_MINUTES_QUIET = 240;

function parseFixtureDate(dateStr) {
  const match = dateStr.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/);
  if (!match) return null;
  const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const monthIndex = months.indexOf(match[2].toLowerCase());
  if (monthIndex === -1) return null;
  return new Date(parseInt(match[3]), monthIndex, parseInt(match[1]));
}

function isDivisionMatchdayToday() {
  try {
    const { fixtures } = JSON.parse(fs.readFileSync('division-fixtures.json', 'utf-8'));
    const today = new Date();
    return (fixtures || []).some(f => {
      const d = parseFixtureDate(f.date);
      return d && d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
    });
  } catch {
    return true; // unknown — err on the safer (shorter) freshness window
  }
}

function isDataFreshEnough() {
  if (!fs.existsSync('division-posts.json')) return false;
  try {
    const existing = JSON.parse(fs.readFileSync('division-posts.json', 'utf-8'));
    const age = (new Date() - new Date(existing.generatedAt)) / 60000;
    const limit = isDivisionMatchdayToday() ? FRESHNESS_MINUTES_MATCHDAY : FRESHNESS_MINUTES_QUIET;
    return age < limit;
  } catch {
    return false;
  }
}

async function run() {
  if (!API_KEY) throw new Error('GETXAPI_KEY environment variable not set');

  if (isDataFreshEnough()) {
    console.log('division-posts.json is still fresh — skipping refetch to save API calls.');
    return;
  }

  // Incremental: reuse posts already held in division-posts.json and only
  // fetch what's newer, instead of re-paging 7 days for every club each run.
  const previousByHandle = {};
  try {
    if (fs.existsSync('division-posts.json')) {
      const prev = JSON.parse(fs.readFileSync('division-posts.json', 'utf-8'));
      (prev.clubs || []).forEach(c => { previousByHandle[c.handle] = c.posts || []; });
    }
  } catch {}

  const results = [];

  for (const club of CLUBS) {
    try {
      const posts = await getUserTweetsIncremental(club.handle, API_KEY, {
        cached: previousByHandle[club.handle] || [],
        floorDate: SEVEN_DAYS_AGO,
        maxPagesFresh: 3,
        maxPagesIncremental: 2,
      });
      const recentPosts = posts.filter(p => new Date(p.createdAt) >= SEVEN_DAYS_AGO);
      results.push({ name: club.name, handle: club.handle, posts: recentPosts });
      console.log(`${club.name}: ${recentPosts.length} posts`);
    } catch (err) {
      console.warn(`Skipping ${club.name} (@${club.handle}): ${err.message}`);
      results.push({ name: club.name, handle: club.handle, posts: previousByHandle[club.handle] || [], error: err.message });
    }
  }

  const output = {
    generatedAt: new Date().toISOString(),
    sinceDate: SEVEN_DAYS_AGO.toISOString(),
    clubs: results,
  };

  fs.writeFileSync('division-posts.json', JSON.stringify(output, null, 2));
  logCost('division-posts', { getxapiCalls: getCallCount(), claudeCalls: 0 });
  console.log('Saved division-posts.json');
}

run().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
