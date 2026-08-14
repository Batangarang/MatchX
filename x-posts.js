const fs = require('fs');
const { getUserTweets } = require('./getxapi-client.js');
const { logCost } = require('./cost-tracker.js');

const USERNAME = 'SandbachFC_1st';
const API_KEY = process.env.GETXAPI_KEY;

function getTodayFixtureWindow() {
  try {
    const data = JSON.parse(fs.readFileSync('data.json', 'utf-8'));
    const next = data.nextFixture;
    if (!next) return null;

    const [, dd, mm, yy] = next.date.match(/(\d{2})\/(\d{2})\/(\d{2})/);
    const [hh, min] = next.kickoff.split(':');
    const today = new Date();
    const fixtureDate = new Date(2000 + parseInt(yy), parseInt(mm) - 1, parseInt(dd));
    const isToday = fixtureDate.getFullYear() === today.getFullYear() &&
                     fixtureDate.getMonth() === today.getMonth() &&
                     fixtureDate.getDate() === today.getDate();
    if (!isToday) return null;

    const kickoffUTC = new Date(Date.UTC(2000 + parseInt(yy), parseInt(mm) - 1, parseInt(dd), parseInt(hh), parseInt(min)));
    const isBST = kickoffUTC.getUTCMonth() > 2 && kickoffUTC.getUTCMonth() < 9;
    if (isBST) kickoffUTC.setUTCHours(kickoffUTC.getUTCHours() - 1);

    return {
      start: new Date(kickoffUTC.getTime() - 30 * 60000),
      end: new Date(kickoffUTC.getTime() + 150 * 60000),
    };
  } catch {
    return null;
  }
}

function shouldPollNow() {
  const now = new Date();
  const window = getTodayFixtureWindow();
  if (window && now >= window.start && now <= window.end) return true;

  const stateFile = 'x-posts-lastpoll.json';
  let lastPoll = null;
  if (fs.existsSync(stateFile)) {
    try { lastPoll = new Date(JSON.parse(fs.readFileSync(stateFile, 'utf-8')).lastPoll); } catch {}
  }

  const hour = now.getUTCHours();
  const isNight = hour < 5 || hour > 23;
  const targetIntervalMinutes = isNight ? 180 : 60;
  const minutesSinceLastPoll = lastPoll ? (now - lastPoll) / 60000 : Infinity;

  if (minutesSinceLastPoll < targetIntervalMinutes) return false;

  fs.writeFileSync(stateFile, JSON.stringify({ lastPoll: now.toISOString() }));
  return true;
}

function isMatchdayPost(createdAt) {
  try {
    const data = JSON.parse(fs.readFileSync('data.json', 'utf-8'));
    const postDate = new Date(createdAt);
    return (data.allFixtures || []).some(f => {
      const [, dd, mm, yy] = f.date.match(/(\d{2})\/(\d{2})\/(\d{2})/);
      const fixtureDate = new Date(2000 + parseInt(yy), parseInt(mm) - 1, parseInt(dd));
      return fixtureDate.getUTCFullYear() === postDate.getUTCFullYear() &&
             fixtureDate.getUTCMonth() === postDate.getUTCMonth() &&
             fixtureDate.getUTCDate() === postDate.getUTCDate();
    });
  } catch {
    return false;
  }
}

async function run() {
  if (!API_KEY) throw new Error('GETXAPI_KEY environment variable not set');

  if (!shouldPollNow()) {
    console.log('Not a scheduled polling moment — skipping.');
    return;
  }

  const tweets = await getUserTweets(USERNAME, API_KEY, { maxPages: 1 });
  const posts = tweets.slice(0, 10);

  const output = {
    scrapedAt: new Date().toISOString(),
    username: USERNAME,
    posts: posts.map(p => ({
      text: p.text,
      createdAt: p.createdAt,
      images: p.images,
      isMatchday: isMatchdayPost(p.createdAt),
    })),
  };

fs.writeFileSync('x-posts.json', JSON.stringify(output, null, 2));
  logCost('x-posts', { getxapiCalls: 1, claudeCalls: 0 });
  console.log(`Saved ${posts.length} posts from @${USERNAME}`);
}

run().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
