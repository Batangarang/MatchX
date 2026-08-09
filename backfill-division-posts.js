const fs = require('fs');
const CLUBS = require('./division-clubs.js');
const { getUserTweets } = require('./getxapi-client.js');

const API_KEY = process.env.GETXAPI_KEY;
const TARGET_DATE = '2026-08-08';

async function run() {
  if (!API_KEY) throw new Error('GETXAPI_KEY not set');

  const dayStart = new Date(`${TARGET_DATE}T00:00:00Z`);
  const dayEnd = new Date(`${TARGET_DATE}T23:59:59Z`);

  const allPosts = [];

  for (const club of CLUBS) {
    try {
      const posts = await getUserTweets(club.handle, API_KEY, { maxPages: 5, sinceDate: dayStart });
      const dayPosts = posts.filter(p => {
        const d = new Date(p.createdAt);
        return d >= dayStart && d <= dayEnd;
      });
      dayPosts.forEach(p => allPosts.push({ ...p, club: club.name, handle: club.handle }));
      console.log(`${club.name}: ${dayPosts.length} posts on ${TARGET_DATE}`);
    } catch (err) {
      console.warn(`Skipping ${club.name} (@${club.handle}): ${err.message}`);
    }
  }

  allPosts.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  fs.writeFileSync(`division-archive-${TARGET_DATE}-raw-posts.json`, JSON.stringify(allPosts, null, 2));
  console.log(`\nSaved ${allPosts.length} total posts to division-archive-${TARGET_DATE}-raw-posts.json`);
}

run().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});