const fs = require('fs');

const USERNAME = 'SandbachFC_1st';
const BEARER_TOKEN = process.env.X_BEARER_TOKEN;

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

  const userId = await getUserId(USERNAME);
  const posts = await getRecentPosts(userId);

  const output = {
    scrapedAt: new Date().toISOString(),
    username: USERNAME,
    posts: posts.map(p => ({
      id: p.id,
      text: p.text,
      createdAt: p.created_at,
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