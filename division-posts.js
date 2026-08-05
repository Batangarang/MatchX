const fs = require('fs');
const CLUBS = require('./division-clubs.js');
const { getUserTweets } = require('./getxapi-client.js');

const API_KEY = process.env.GETXAPI_KEY;
const SEVEN_DAYS_AGO = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

function shouldRunPostMatch() {
  if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') return true;

  const data = JSON.parse(fs.readFileSync('data.json', 'utf-8'));
  const lastResult = data.lastResult;
  if (!lastResult) return false;

  const today = new Date();
  const todayStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');

  const [, dd, mm, yy] = lastResult.date.match(/(\d{2})\/(\d{2})\/(\d{2})/);
  const resultDateStr = `20${yy}-${mm}-${dd}`;
  if (resultDateStr !== todayStr) return false;

  const [hh, min] = lastResult.kickoff.split(':');
  const kickoffToday = new Date();
  kickoffToday.setUTCHours(parseInt(hh), parseInt(min), 0, 0);
  const isBST = today.getUTCMonth() > 2 && today.getUTCMonth() < 9;
  if (isBST) kickoffToday.setUTCHours(kickoffToday.getUTCHours() - 1);

  const targetTime = new Date(kickoffToday.getTime() + 165 * 60000);
  const minutesFromTarget = Math.abs(today - targetTime) / 60000;
  if (minutesFromTarget > 15) return false;

  const lastRunFile = 'division-roundup-lastrun.json';
  if (fs.existsSync(lastRunFile)) {
    const lastRun = JSON.parse(fs.readFileSync(lastRunFile, 'utf-8'));
    if (lastRun.date === todayStr) return false;
  }

  fs.writeFileSync(lastRunFile, JSON.stringify({ date: todayStr, ranAt: new Date().toISOString() }));
  return true;
}

async function run() {
  if (!API_KEY) throw new Error('GETXAPI_KEY environment variable not set');

  if (!shouldRunPostMatch()) {
    console.log('Not the post-match trigger window — skipping.');
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
  console.log('Saved division-posts.json');
}

run().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
