const fs = require('fs');
const CLUBS = require('./division-clubs.js');
const { getUserTweets } = require('./getxapi-client.js');
const { logCost } = require('./cost-tracker.js');

const API_KEY = process.env.GETXAPI_KEY;
const SEVEN_DAYS_AGO = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
const FRESHNESS_MINUTES = 120; // widened from 60 given real-world evidence of overlapping-workflow cost

function isDataFreshEnough() {
  if (!fs.existsSync('division-posts.json')) return false;
  try {
    const existing = JSON.parse(fs.readFileSync('division-posts.json', 'utf-8'));
    const age = (new Date() - new Date(existing.generatedAt)) / 60000;
    return age < FRESHNESS_MINUTES;
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

  const results = [];

  for (const club of CLUBS) {
    try {
      const posts = await getUserTweets(club.handle, API_KEY, { maxPages: 3, sinceDate: SEVEN_DAYS_AGO });
      const recentPosts = posts.filter(p => new Date(p.createdAt) >= SEVEN_DAYS_AGO);
      results.push({ name: club.name, handle: club.handle, posts: recentPosts });
      console.log(`${club.name}: ${recentPosts.length} posts`);
    } catch (err) {
      console.warn(`Skipping ${club.name} (@${club.handle}): ${err.message}`);
      results.push({ name: club.name, handle: club.handle, posts: [], error: err.message });
    }
  }

  const output = {
    generatedAt: new Date().toISOString(),
    sinceDate: SEVEN_DAYS_AGO.toISOString(),
    clubs: results,
  };

  fs.writeFileSync('division-posts.json', JSON.stringify(output, null, 2));
  logCost('division-posts', { getxapiCalls: CLUBS.length, claudeCalls: 0 });
  console.log('Saved division-posts.json');
}

run().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
