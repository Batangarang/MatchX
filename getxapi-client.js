const BASE_URL = 'https://api.getxapi.com';

// Real count of HTTP calls made to GetXAPI in this process (every page and
// every 429 retry counts — that is what GetXAPI bills for).
let callCount = 0;
function getCallCount() { return callCount; }

function parseTwitterDate(dateStr) {
  // GetXAPI returns dates like "Mon Jan 12 13:44:55 +0000 2026" — JS parses this natively
  return new Date(dateStr).toISOString();
}

function isOriginalPost(tweet) {
  if (tweet.isReply) return false;
  if (tweet.text && tweet.text.startsWith('RT @')) return false;
  return true;
}

/**
 * Fetches a user's tweets, paginating as needed.
 * @param {string} userName
 * @param {string} apiKey
 * @param {object} opts
 *   - maxPages: safety cap on pagination (default 3)
 *   - sinceDate: a Date — stop paginating once tweets are older than this
 */
async function getUserTweets(userName, apiKey, opts = {}) {
  const maxPages = opts.maxPages || 3;
  const sinceDate = opts.sinceDate || null;

  let allTweets = [];
  let cursor = null;
  let page = 0;

  while (page < maxPages) {
    const params = new URLSearchParams({ userName });
    if (cursor) params.set('cursor', cursor);

    callCount++;
    const res = await fetch(`${BASE_URL}/twitter/user/tweets?${params}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    const data = await res.json();

    if (data.error) {
      const isRateLimited = res.status === 429 || /RATE_LIMITED/i.test(data.error);
      if (isRateLimited && (opts.retriesLeft ?? 2) > 0) {
        const waitMs = 3000 * ((opts.retryAttempt ?? 0) + 1); // 3s, then 6s
        console.warn(`Rate limited for @${userName}, retrying in ${waitMs}ms...`);
        await new Promise(r => setTimeout(r, waitMs));
        return getUserTweets(userName, apiKey, {
          ...opts,
          retriesLeft: (opts.retriesLeft ?? 2) - 1,
          retryAttempt: (opts.retryAttempt ?? 0) + 1,
        });
      }
      throw new Error(`GetXAPI error for @${userName}: ${data.error}`);
    }

    const tweets = data.tweets || [];
    allTweets = allTweets.concat(tweets);

    const oldestOnPage = tweets.length > 0 ? new Date(parseTwitterDate(tweets[tweets.length - 1].createdAt)) : null;
    const reachedSinceDate = sinceDate && oldestOnPage && oldestOnPage < sinceDate;

    if (!data.has_more || reachedSinceDate) break;
    cursor = data.next_cursor;
    page++;
  }

  return allTweets
    .filter(isOriginalPost)
    .map(t => ({
      text: t.text,
      createdAt: parseTwitterDate(t.createdAt),
      images: (t.media || []).filter(m => m.type === 'photo').map(m => m.url),
    }));
}

/**
 * Incremental fetch: only asks GetXAPI for posts newer than what we already
 * hold, so a normal poll costs ONE call per account instead of re-paging the
 * whole day/week every time.
 * @param {Array} cached  posts already held for this account (may be empty)
 * @param {Date} floorDate  oldest post we ever care about
 */
async function getUserTweetsIncremental(userName, apiKey, { cached = [], floorDate, maxPagesFresh = 8, maxPagesIncremental = 3 } = {}) {
  const cachedInRange = cached.filter(p => new Date(p.createdAt) >= floorDate);
  let sinceDate = floorDate;
  if (cachedInRange.length > 0) {
    const newest = Math.max(...cachedInRange.map(p => new Date(p.createdAt).getTime()));
    sinceDate = new Date(newest - 2 * 60000); // small overlap so nothing slips through
  }
  const fresh = await getUserTweets(userName, apiKey, {
    maxPages: cachedInRange.length > 0 ? maxPagesIncremental : maxPagesFresh,
    sinceDate,
  });
  const seen = new Set();
  return [...cachedInRange, ...fresh]
    .filter(p => new Date(p.createdAt) >= floorDate)
    .filter(p => { const k = `${p.createdAt}|${p.text}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

module.exports = { getUserTweets, getUserTweetsIncremental, getCallCount, parseTwitterDate };
