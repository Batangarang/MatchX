const fs = require('fs');
const CLUBS = require('./division-clubs.js');
const { getUserIdCached } = require('./user-id-cache.js');

const BEARER_TOKEN = process.env.X_BEARER_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

function getTargetFixture() {
  const data = JSON.parse(fs.readFileSync('data.json', 'utf-8'));
  const testDate = process.env.MATCHDAY_TEST_DATE;

  if (testDate) {
    return (data.allFixtures || []).find(f => {
      const [, dd, mm, yy] = f.date.match(/(\d{2})\/(\d{2})\/(\d{2})/);
      return `20${yy}-${mm}-${dd}` === testDate;
    }) || null;
  }

  const next = data.nextFixture;
  if (!next) return null;
  const [, dd, mm, yy] = next.date.match(/(\d{2})\/(\d{2})\/(\d{2})/);
  const fixtureDate = new Date(2000 + parseInt(yy), parseInt(mm) - 1, parseInt(dd));
  const today = new Date();
  const isToday = fixtureDate.getFullYear() === today.getFullYear() &&
                   fixtureDate.getMonth() === today.getMonth() &&
                   fixtureDate.getDate() === today.getDate();
  return isToday ? next : null;
}

function findHandle(clubName) {
  const found = CLUBS.find(c => clubName.includes(c.name) || c.name.includes(clubName));
  return found ? found.handle : null;
}

function withinMatchWindow(kickoff, competitionNote) {
  if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') return true;
  if (!kickoff) return false;

  const isCup = competitionNote && /cup|vase|trophy/i.test(competitionNote);
  const maxMinutesAfter = isCup ? 240 : 150;

  const [hh, min] = kickoff.split(':');
  const now = new Date();
  const kickoffToday = new Date();
  kickoffToday.setUTCHours(parseInt(hh), parseInt(min), 0, 0);

  const isBST = now.getUTCMonth() > 2 && now.getUTCMonth() < 9;
  if (isBST) kickoffToday.setUTCHours(kickoffToday.getUTCHours() - 1);

  const minutesFromKickoff = (now - kickoffToday) / 60000;
  return minutesFromKickoff >= -30 && minutesFromKickoff <= maxMinutesAfter;
}

async function getPostsForHandle(handle, dateStr) {
  const userId = await getUserIdCached(handle, BEARER_TOKEN);
  const params = new URLSearchParams({
    max_results: '100',
    exclude: 'retweets,replies',
    'tweet.fields': 'created_at,text',
    expansions: 'attachments.media_keys',
    'media.fields': 'url,type',
    start_time: new Date(`${dateStr}T00:00:00Z`).toISOString(),
    end_time: new Date(`${dateStr}T23:59:59Z`).toISOString(),
  });

  const res = await fetch(`https://api.x.com/2/users/${userId}/tweets?${params}`, {
    headers: { Authorization: `Bearer ${BEARER_TOKEN}` },
  });
  const data = await res.json();

  const mediaLookup = {};
  (data.includes?.media || []).forEach(m => { mediaLookup[m.media_key] = m; });

  return (data.data || []).map(p => {
    const mediaKeys = p.attachments?.media_keys || [];
    const images = mediaKeys.map(k => mediaLookup[k]).filter(m => m && m.type === 'photo').map(m => m.url);
    return { text: p.text, createdAt: p.created_at, images };
  });
}

async function fetchImageAsBase64(url) {
  const res = await fetch(url);
  const buffer = await res.arrayBuffer();
  return {
    base64: Buffer.from(buffer).toString('base64'),
    mediaType: res.headers.get('content-type') || 'image/jpeg',
  };
}

function selectRelevantImages(combined, alreadySeen, maxImages = 15) {
  const keywords = /line[\s-]?up|team\s?sheet|full[\s-]?time|half[\s-]?time|\bft\b|\bht\b|kick[\s-]?off|extra\s?time|penalt/i;
  const withImages = combined.filter(p => p.images && p.images.length > 0);

  // Flatten to individual (post, imageUrl) pairs, excluding already-analyzed URLs
  const pairs = [];
  withImages.forEach(p => {
    p.images.forEach(imgUrl => {
      if (!alreadySeen.has(imgUrl)) {
        pairs.push({ post: p, imgUrl, isKeyword: keywords.test(p.text) });
      }
    });
  });

  pairs.sort((a, b) => (b.isKeyword ? 1 : 0) - (a.isKeyword ? 1 : 0));
  return pairs.slice(0, maxImages);
}

function mergeArrays(oldArr, newArr, keyFn) {
  const combined = [...(oldArr || [])];
  const existingKeys = new Set(combined.map(keyFn));
  (newArr || []).forEach(item => {
    const key = keyFn(item);
    if (!existingKeys.has(key)) {
      combined.push(item);
      existingKeys.add(key);
    }
  });
  return combined;
}

function mergeMatchData(previous, incoming) {
  if (!previous) return incoming;

  return {
    score: incoming.score || previous.score,
    matchStage: incoming.matchStage && incoming.matchStage !== 'scheduled' ? incoming.matchStage : previous.matchStage,
    lineups: {
      home: {
        players: incoming.lineups?.home?.players?.length ? incoming.lineups.home.players : previous.lineups?.home?.players || [],
        substitutes: incoming.lineups?.home?.substitutes?.length ? incoming.lineups.home.substitutes : previous.lineups?.home?.substitutes || [],
        manager: incoming.lineups?.home?.manager || previous.lineups?.home?.manager || null,
        officials: incoming.lineups?.home?.officials?.length ? incoming.lineups.home.officials : previous.lineups?.home?.officials || [],
      },
      away: {
        players: incoming.lineups?.away?.players?.length ? incoming.lineups.away.players : previous.lineups?.away?.players || [],
        substitutes: incoming.lineups?.away?.substitutes?.length ? incoming.lineups.away.substitutes : previous.lineups?.away?.substitutes || [],
        manager: incoming.lineups?.away?.manager || previous.lineups?.away?.manager ||