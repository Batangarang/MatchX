const fs = require('fs');
const { getUserIdCached } = require('./user-id-cache.js');

const USERNAME = 'SandbachFC_1st';
const BEARER_TOKEN = process.env.X_BEARER_TOKEN;

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
  if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') return true;

  const now = new Date();
  const window = getTodayFixtureWindow();
  if (window && now >= window.start && now <= window.end) {
    return true; // real matchday window, based on the actual fixture's kickoff time
  }

  const stateFile = 'x-posts-lastpoll.json';
  let lastPoll = null;
  if (fs.existsSync(stateFile)) {
    try { lastPoll = new Date(JSON.parse(fs.readFileSync(stateFile, 'utf-8')).lastPoll); } catch {}
  }

  const hour = now.getUTCHours();
  const isNight = hour < 5 || hour > 23;
  const targetIntervalMinutes = isNight ? 180 : 30;
  const minutesSinceLastPoll = lastPoll ? (now - lastPoll) / 60000 : Infinity;

  if (minutesSinceLastPoll < targetIntervalMinutes) return false;

  fs.writeFileSync(stateFile, JSON.stringify({ lastPoll: now.toISOString() }));
  return true;
}


async function getRecentPosts(userId) {
  const params = new URLSearchParams({
    max_results: '10',
    exclude: 'retweets,replies',
    'tweet.fields': 'created_at,text',
    expansions: 'attachments.media_keys',
    'media.fields': 'url,preview_image_url,type',
  });

  const res = await fetch(`https://api.x.com/2/users/${userId}/tweets?${params}`, {
    headers: { Authorization: `Bearer ${BEARER_TOKEN}` },
  });
  const data = await res.json();

  console.log('HTTP status:', res.status);
  console.log('Rate limit remaining:', res.headers.get('x-rate-limit-remaining'));
  console.log('Rate limit reset:', res.headers.get('x-rate-limit-reset'));
  console.log('Raw response:', JSON.stringify(data));

  const mediaLookup = {};
  (data.includes?.media || []).forEach(m => {
    mediaLookup[m.media_key] = m;
  });

  return (data.data || []).map(post => {
    const mediaKeys = post.attachments?.media_keys || [];
    const images = mediaKeys
      .map(key => mediaLookup[key])
      .filter(m => m && m.type === 'photo')
      .map(m => m.url);

    return { ...post, images };
  });
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

async function getRecentPosts(userId) {
  const params = new URLSearchParams({
    max_results: '10',
    exclude: 'retweets,replies',
    'tweet.fields': 'created_at,text',
    expansions: 'attachments.media_keys',
    'media.fields': 'url,preview_image_url,type',
  });

  const res = await fetch(`https://api.x.com/2/users/${userId}/tweets?${params}`, {
    headers: { Authorization: `Bearer ${BEARER_TOKEN}` },
  });
  const data = await res.json();

  const mediaLookup = {};
  (data.includes?.media || []).forEach(m => {
    mediaLookup[m.media_key] = m;
  });

  return (data.data || []).map(post => {
    const mediaKeys = post.attachments?.media_keys || [];
    const images = mediaKeys
      .map(key => mediaLookup[key])
      .filter(m => m && m.type === 'photo')
      .map(m => m.url);

    return { ...post, images };
  });
}

async function run() {
  if (!BEARER_TOKEN) {
    throw new Error('X_BEARER_TOKEN environment variable not set');
  }

  if (!shouldPollNow()) {
    console.log('Not a scheduled polling moment — skipping.');
    return;
  }

  const userId = await getUserIdCached(USERNAME, BEARER_TOKEN);
  const posts = await getRecentPosts(userId);

  const output = {
    scrapedAt: new Date().toISOString(),
    username: USERNAME,
    posts: posts.map(p => ({
      id: p.id,
      text: p.text,
      createdAt: p.created_at,
      images: p.images || [],
      isMatchday: isMatchdayPost(p.created_at),
    })),
  };

  fs.writeFileSync('x-posts.json', JSON.stringify(output, null, 2));
  console.log(`Saved ${posts.length} posts from @${USERNAME}`);
  console.log(output.posts[0]);
}

run().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});