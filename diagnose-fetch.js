const { getUserTweets } = require('./getxapi-client.js');

const API_KEY = process.env.GETXAPI_KEY;
const DATE = '2026-08-04';

async function diagnose(handle) {
  const dayStart = new Date(`${DATE}T00:00:00Z`);
  const dayEnd = new Date(`${DATE}T23:59:59Z`);

  console.log(`\n--- @${handle} ---`);
  const tweets = await getUserTweets(handle, API_KEY, { maxPages: 5, sinceDate: dayStart });
  console.log(`Total fetched (before date filter): ${tweets.length}`);

  const filtered = tweets.filter(t => {
    const d = new Date(t.createdAt);
    return d >= dayStart && d <= dayEnd;
  });
  console.log(`Within target day after filter: ${filtered.length}`);

  if (tweets.length > 0) {
    console.log(`Oldest tweet fetched: ${tweets[tweets.length - 1].createdAt}`);
    console.log(`Newest tweet fetched: ${tweets[0].createdAt}`);
  }

  const withImages = filtered.filter(t => t.images && t.images.length > 0);
  console.log(`Of those, with images: ${withImages.length}`);
}

async function run() {
  await diagnose('foley_fc');
  await diagnose('SandbachFC_1st');
}

run().catch(err => console.error('Failed:', err.message));
