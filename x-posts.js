const fs = require('fs');

const USERNAME = 'SandbachFC_1st';
const BEARER_TOKEN = process.env.X_BEARER_TOKEN;

function isMatchdayNow() {
  try {
    const data = JSON.parse(fs.readFileSync('data.json', 'utf-8'));
    const next = data.nextFixture;
    if (!next) return false;

    const [, dd, mm, yy] = next.date.match(/(\d{2})\/(\d{2})\/(\d{2})/);
    const fixtureDate = new Date(2000 + parseInt(yy), parseInt(mm) - 1, parseInt(dd));
    const now = new Date();

    const isToday = fixtureDate.getFullYear() === now.getFullYear() &&
                     fixtureDate.getMonth() === now.getMonth() &&
                     fixtureDate.getDate() === now.getDate();

    // Padded 13:00-18:00 UTC window to safely cover 2pm-6pm UK time
    // across both BST and GMT without needing manual adjustment
    const hour = now.getUTCHours();
    return isToday && hour >= 13 && hour < 18;
  } catch {
    return false;
  }
}

function shouldPollNow() {
  const now = new Date();
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();

  if (isMatchdayNow()) {
    return true; // effectively every 5 minutes, since that's how often this workflow runs
  }

  // "Day" band: roughly 6am-midnight UK, padded in UTC for DST
  if (hour >= 5 && hour <= 23) {
    return minute % 30 === 0; // every 30 minutes
  }

  // "Night" band: roughly midnight-6am UK
  return minute === 0 && hour % 3 === 0; // every 3 hours
}

async function getUserId(username) {
  const res = await fetch(`https://api.x.com/2/users/by/username/${username}`, {
    headers: { Authorization: `Bearer ${BEARER_TOKEN}` },
  });
  const data = await res.json();
  if (!data.data) {
    throw new Error(`Could not find user: ${JSON.stringify(data)}`);
  }
  return data.data.id;
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

  // Media comes back separately in `includes.media`, keyed by media_key —
  // build a lookup so we can attach the right image to each post
  const mediaLookup = {};
  (data.includes?.media || []).forEach(m => {
    mediaLookup[m.media_key] = m;
  });

  return (data.data || []).map(post => {
    const mediaKeys = post.attachments?.media_keys || [];
    const images = mediaKeys
      .map(key => mediaLookup[key])
      .filter(m => m && (m.type === 'photo'))
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

  const userId = await getUserId(USERNAME);
  const posts = await getRecentPosts(userId);

  const output = {
    scrapedAt: new Date().toISOString(),
    username: USERNAME,
     posts: posts.map(p => ({
      id: p.id,
      text: p.text,
      createdAt: p.created_at,
      images: p.images || [],
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
