const fs = require('fs');
const CLUBS = require('./division-clubs.js');

const BEARER_TOKEN = process.env.X_BEARER_TOKEN;
const SEVEN_DAYS_AGO = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

async function getUserId(username) {
  const res = await fetch(`https://api.x.com/2/users/by/username/${username}`, {
    headers: { Authorization: `Bearer ${BEARER_TOKEN}` },
  });
  const data = await res.json();
  if (!data.data) {
    throw new Error(`user lookup failed: ${JSON.stringify(data)}`);
  }
  return data.data.id;
}

async function getRecentPosts(userId) {
  const params = new URLSearchParams({
    max_results: '100',
    exclude: 'retweets,replies',
    'tweet.fields': 'created_at,text',
    start_time: SEVEN_DAYS_AGO,
  });

  const res = await fetch(`https://api.x.com/2/users/${userId}/tweets?${params}`, {
    headers: { Authorization: `Bearer ${BEARER_TOKEN}` },
  });
  const data = await res.json();
  return data.data || [];
}

async function run() {
  if (!BEARER_TOKEN) {
    throw new Error('X_BEARER_TOKEN environment variable not set');
  }

  const results = [];

  for (const club of CLUBS) {
    try {
      const userId = await getUserId(club.handle);
      const posts = await getRecentPosts(userId);
      results.push({
        name: club.name,
        handle: club.handle,
        posts: posts.map(p => ({ text: p.text, createdAt: p.created_at })),
      });
      console.log(`${club.name}: ${posts.length} posts`);
    } catch (err) {
      console.warn(`Skipping ${club.name} (@${club.handle}): ${err.message}`);
      results.push({ name: club.name, handle: club.handle, posts: [], error: err.message });
    }
  }

  const output = {
    generatedAt: new Date().toISOString(),
    sinceDate: SEVEN_DAYS_AGO,
    clubs: results,
  };

  fs.writeFileSync('division-posts.json', JSON.stringify(output, null, 2));
  console.log('Saved division-posts.json');
}

run().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});