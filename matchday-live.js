const fs = require('fs');
const CLUBS = require('./division-clubs.js');
const { getUserTweets } = require('./getxapi-client.js');

const API_KEY = process.env.GETXAPI_KEY;
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
  if (process.env.MATCHDAY_TEST_DATE) return true;
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
  const dayStart = new Date(`${dateStr}T00:00:00Z`);
  const dayEnd = new Date(`${dateStr}T23:59:59Z`);
  const tweets = await getUserTweets(handle, API_KEY, { maxPages: 5, sinceDate: dayStart });
  return tweets.filter(t => {
    const d = new Date(t.createdAt);
    return d >= dayStart && d <= dayEnd;
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

function normalizeIdentity(name) {
  if (!name) return null;
  let n = name.toString().trim().toLowerCase();
  if (n === 'unknown' || n === '') return null;
  n = n.replace(/^unknown\s*\(([^)]+)\)$/i, '$1').trim();

  // A reference that's ONLY a shirt number (e.g. "Sandbach number 10", "player 10",
  // "#10", "FM 8") carries no real identity of its own — treat it the same as
  // "Unknown" so a later post naming the actual player can upgrade it, rather than
  // two separately-numbered references failing to match a later named one.
  if (/^([a-z\s]*)?(number|no\.?|#)\s*\d+$/i.test(n)) return null;

  return n || null;
}

function namesLikelyMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;

  const wordsA = new Set(a.split(/\s+/));
  const wordsB = new Set(b.split(/\s+/));
  for (const w of wordsA) {
    if (w.length > 2 && wordsB.has(w)) return true;
  }
  return false;
}

function dedupeByTeamMinuteAndIdentity(events, identityField) {
  const deduped = [];
  events.forEach(e => {
    const eIdentity = normalizeIdentity(e[identityField]);
    const matchIndex = deduped.findIndex(existing => {
      if (existing.team !== e.team) return false;
      if (Math.abs((existing.minute || 0) - (e.minute || 0)) > 3) return false;
      const existingIdentity = normalizeIdentity(existing[identityField]);
      if (!existingIdentity || !eIdentity) return true;
      return namesLikelyMatch(existingIdentity, eIdentity);
    });

    if (matchIndex === -1) {
      deduped.push(e);
    } else {
      const existing = deduped[matchIndex];
      const existingIdentity = normalizeIdentity(existing[identityField]);
      const eIsMoreSpecific = eIdentity && (!existingIdentity || eIdentity.length > existingIdentity.length);
      if (eIsMoreSpecific) {
        deduped[matchIndex] = { ...existing, [identityField]: e[identityField], minute: e.minute ?? existing.minute };
      }
    }
  });
  return deduped;
}

function dedupeSimilarGoals(goals) {
  return dedupeByTeamMinuteAndIdentity(goals, 'scorer');
}

function dedupeSimilarEvents(events, keyFields) {
  const identityField = keyFields.includes('player') ? 'player' : keyFields[keyFields.length - 1];
  return dedupeByTeamMinuteAndIdentity(events, identityField);
}

function deriveScoreFromGoals(goals) {
  if (!goals || goals.length === 0) return null;
  const home = goals.filter(g => g.team === 'home').length;
  const away = goals.filter(g => g.team === 'away').length;
  return `${home}-${away}`;
}

function mergeMatchData(previous, incoming) {
  if (!previous) {
    const dedupedGoals = dedupeSimilarGoals(incoming.goals || []);
    return {
      ...incoming,
      goals: dedupedGoals,
      score: (incoming.matchStage === 'full_time' && incoming.finalScoreAnnounced)
        ? incoming.finalScoreAnnounced
        : (deriveScoreFromGoals(dedupedGoals) || incoming.score),
      finalScoreAnnounced: incoming.finalScoreAnnounced || null,
      yellowCards: dedupeSimilarEvents(incoming.yellowCards || [], ['team', 'player']),
      redCards: dedupeSimilarEvents(incoming.redCards || [], ['team', 'player']),
    };
  }

  const mergedGoals = dedupeSimilarGoals(
    mergeArrays(previous.goals, incoming.goals, g => `${g.minute}-${g.scorer}-${g.team}`)
  );
  const mergedYellowCards = dedupeSimilarEvents(
    mergeArrays(previous.yellowCards, incoming.yellowCards, c => `${c.minute}-${c.player}-${c.team}`),
    ['team', 'player']
  );
  const mergedRedCards = dedupeSimilarEvents(
    mergeArrays(previous.redCards, incoming.redCards, c => `${c.minute}-${c.player}-${c.team}`),
    ['team', 'player']
  );

  return {
    score: (incoming.matchStage === 'full_time' && (incoming.finalScoreAnnounced || previous.finalScoreAnnounced))
      ? (incoming.finalScoreAnnounced || previous.finalScoreAnnounced)
      : (deriveScoreFromGoals(mergedGoals) || incoming.score || previous.score),
    finalScoreAnnounced: incoming.finalScoreAnnounced || previous.finalScoreAnnounced || null,
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
        manager: incoming.lineups?.away?.manager || previous.lineups?.away?.manager || null,
        officials: incoming.lineups?.away?.officials?.length ? incoming.lineups.away.officials : previous.lineups?.away?.officials || [],
      },
    },
    goals: mergedGoals,
    yellowCards: mergedYellowCards,
    redCards: mergedRedCards,
    substitutions: mergeArrays(previous.substitutions, incoming.substitutions, s => `${s.minute}-${s.playerOff}-${s.playerOn}`),
    sinBins: mergeArrays(previous.sinBins, incoming.sinBins, s => `${s.minute}-${s.player}-${s.team}`),
    injuries: mergeArrays(previous.injuries, incoming.injuries, i => `${i.minute}-${i.player}-${i.team}`),
    addedTime: {
      firstHalf: incoming.addedTime?.firstHalf ?? previous.addedTime?.firstHalf ?? null,
      secondHalf: incoming.addedTime?.secondHalf ?? previous.addedTime?.secondHalf ?? null,
    },
    wentToExtraTime: incoming.wentToExtraTime || previous.wentToExtraTime || false,
    wentToPenalties: incoming.wentToPenalties || previous.wentToPenalties || false,
    extraTime: incoming.wentToExtraTime ? (incoming.extraTime || previous.extraTime) : previous.extraTime,
    penalties: incoming.wentToPenalties ? (incoming.penalties || previous.penalties) : previous.penalties,
    roughXG: incoming.roughXG || previous.roughXG,
    matchControl: incoming.matchControl || previous.matchControl,
  };
}

async function run() {
  if (!API_KEY) throw new Error('GETXAPI_KEY not set');
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY not set');

  const fixture = getTargetFixture();
  if (!fixture) {
    console.log('No matchday fixture found — skipping.');
    return;
  }

  if (!withinMatchWindow(fixture.kickoff, fixture.competitionNote)) {
    console.log('Outside the matchday window — skipping.');
    return;
  }

  const [, dd, mm, yy] = fixture.date.match(/(\d{2})\/(\d{2})\/(\d{2})/);
  const dateStr = `20${yy}-${mm}-${dd}`;

  const homeHandle = fixture.homeAway === 'H' ? 'SandbachFC_1st' : findHandle(fixture.opposition);
  const awayHandle = fixture.homeAway === 'H' ? findHandle(fixture.opposition) : 'SandbachFC_1st';

  if (!homeHandle || !awayHandle) {
    console.log(`Could not resolve both handles (home=${homeHandle}, away=${awayHandle}) — skipping.`);
    return;
  }

  const [homePosts, awayPosts] = await Promise.all([
    getPostsForHandle(homeHandle, dateStr),
    getPostsForHandle(awayHandle, dateStr),
  ]);

  const combined = [
    ...homePosts.map(p => ({ ...p, side: 'home', handle: homeHandle })),
    ...awayPosts.map(p => ({ ...p, side: 'away', handle: awayHandle })),
  ].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  if (!fs.existsSync('matchday-archive')) fs.mkdirSync('matchday-archive');
  fs.writeFileSync(`matchday-archive/${dateStr}-raw-posts.json`, JSON.stringify(combined, null, 2));

  if (combined.length === 0) {
    console.log('No posts found from either account — skipping AI extraction.');
    return;
  }

  const archiveFile = `matchday-archive/${dateStr}.json`;
  let previousOutput = null;
  if (fs.existsSync(archiveFile)) {
    previousOutput = JSON.parse(fs.readFileSync(archiveFile, 'utf-8'));
  }

  const seenImagesFile = `matchday-archive/${dateStr}-images-seen.json`;
  let alreadySeen = new Set();
  if (fs.existsSync(seenImagesFile)) {
    alreadySeen = new Set(JSON.parse(fs.readFileSync(seenImagesFile, 'utf-8')));
  }

  const newImagePairs = selectRelevantImages(combined, alreadySeen);
  const newTextCount = combined.length - (previousOutput?.postsUsed || 0);

  if (newImagePairs.length === 0 && newTextCount <= 0 && previousOutput) {
    console.log('Nothing new since last check — skipping AI call.');
    return;
  }

  const postsText = combined.map(p => `[${p.createdAt}] (@${p.handle}, ${p.side} team) ${p.text}`).join('\n');
  const isCup = fixture.competitionNote && /cup|vase|trophy/i.test(fixture.competitionNote);

  const prompt = `Below are X posts (and some attached images) from the home and away teams' official accounts on the day of a football match: ${fixture.homeAway === 'H' ? 'Sandbach United' : fixture.opposition} vs ${fixture.homeAway === 'H' ? fixture.opposition : 'Sandbach United'}, played ${fixture.date}${isCup ? ` (a cup competition: ${fixture.competitionNote} — this match could go to extra time and penalties)` : ' (a league match — normally 90 minutes, no extra time)'}.

IMPORTANT: Sandbach United specifically have ONE player with the surname "Foley" (not to be confused with the opposing club "Foley Meir"). This distinction ONLY matters when it's ambiguous whether "Foley" refers to that Sandbach player or to the club Foley Meir. If a post clearly names a different, specific player (e.g. "Kyle Foley", "Jack Foley") who is NOT further identified as Sandbach's player, do not assume they must be that Sandbach player — trust the team/side the post itself indicates (which account posted it, and any home/away context), and record the goal/sub/card for whichever team is actually accurate based on that context.

IMPORTANT: Both the home and away clubs may separately post about the SAME goal, card, or event (e.g. one posts "0-1" and the other posts "9' Kieran O'Connell" for the exact same goal). Do NOT report the same real-world event twice just because both clubs mentioned it — treat matching or clearly-corroborating mentions from each side as ONE event, not two.

IMPORTANT: If a post is a CORRECTION to an earlier goal (e.g. "Correction: that goal was actually scored by X, not Y" or "apologies, the scorer was actually..."), do NOT add this as a new goal — it replaces the earlier reported goal, so the total goal count should not increase.

IMPORTANT: When a post describes a foul or clash between two players before mentioning a card (e.g. "X catches Y late, ref shows yellow"), the card belongs to the player who COMMITTED the foul, not the player who was fouled. Record only the carded player's name in the "player" field — do not combine both players' names into one entry (e.g. write "Cope", not "FM 8 (Cope)" if Cope is actually the player who was fouled and someone else was carded — read carefully which player the card was actually shown to).

Posts:
${postsText}

Using information present in these posts AND any attached images (e.g. graphics that say "Full Time" with a score, "Half Time" with a score, or team sheet images), build a structured match summary. Respond with ONLY a JSON object, no other text, no markdown fences, in exactly this shape:

{
  "score": "string or null — the current or final score after 90 minutes",
  "finalScoreAnnounced": "string or null — ONLY fill this in if a post explicitly states the full-time or half-time score as a direct statement (e.g. 'FT 3-2', a full-time graphic, 'match ends 3-2') — not inferred from goals, the literal announced score",
  "matchStage": "one of: scheduled, first_half, half_time, second_half, extra_time, penalties, full_time — ONLY set to half_time or full_time when a post EXPLICITLY ANNOUNCES it as a standalone statement or with a score (e.g. 'HT', 'HT 1-2', 'Half time score:', a half-time graphic, 'FT', 'FT 2-3', 'Full time:', a full-time graphic). Do NOT set half_time/full_time just because a post MENTIONS the concept in passing (e.g. 'coming up to half time', 'not long until the break', 'approaching full time') — that kind of mention means the match is still in first_half or second_half respectively, just close to the interval/end.",
  "lineups": {
    "home": { "players": [], "substitutes": [], "manager": null, "officials": [] },
    "away": { "players": [], "substitutes": [], "manager": null, "officials": [] }
  },
  "goals": [{ "minute": null, "team": "home or away", "scorer": "string" }],
  "yellowCards": [{ "minute": null, "team": "home or away", "player": "string" }],
  "redCards": [{ "minute": null, "team": "home or away", "player": "string" }],
  "substitutions": [{ "minute": null, "team": "home or away", "playerOff": "string", "playerOn": "string" }],
  "sinBins": [{ "minute": null, "team": "home or away", "player": "string" }],
  "injuries": [{ "minute": null, "team": "home or away", "player": "string", "note": "string" }],
  "addedTime": { "firstHalf": null, "secondHalf": null },
  "wentToExtraTime": false,
  "wentToPenalties": false,
  "extraTime": {
    "score": "string or null — score after extra time",
    "goals": [{ "minute": null, "team": "home or away", "scorer": "string" }]
  },
  "penalties": {
    "finalScore": "string or null, e.g. '4-3'",
    "takers": [{ "team": "home or away", "player": "string", "scored": true }]
  },
  "roughXG": {
    "firstHalf": { "home": 0.0, "away": 0.0, "note": "string" },
    "secondHalf": { "home": 0.0, "away": 0.0, "note": "string" },
    "extraTime": { "home": 0.0, "away": 0.0, "note": "string" },
    "total": { "home": 0.0, "away": 0.0, "note": "string" },
    "disclaimer": "Rough estimate inferred from social media commentary, not real shot data — not an accurate xG figure. Values are illustrative, not calculated from actual shot data."
  },
  "matchControl": {
    "firstHalf": { "home": 50, "away": 50, "note": "string" },
    "secondHalf": { "home": 50, "away": 50, "note": "string" },
    "extraTime": { "home": 50, "away": 50, "note": "string" },
    "total": { "home": 50, "away": 50, "note": "string" },
    "disclaimer": "Inferred from tone/content of posts only, not real possession or shot data."
  }
}

For substitutions: "playerOff" is the player being TAKEN OFF the pitch (leaving), "playerOn" is the player COMING ON (entering). If a post says "X comes on for Y" or "Y makes way for X", then playerOff="Y", playerOn="X". Read the direction carefully — do not assume the first name mentioned is the one leaving.

Be conservative with roughXG and matchControl when there is little material to base them on. If only a small number of posts are available (e.g. fewer than 3-4 substantive posts about actual play, excluding lineup/team-news graphics), keep the values close to neutral (e.g. xG near 0.0-0.3 for both sides, control near 50/50) and say so explicitly in "note" (e.g. "Too little commentary yet to estimate confidently"). Only move further from neutral once there is genuine descriptive commentary about chances, pressure, or dominance to base it on — do not infer confident numbers from a single vague post.

Only populate wentToExtraTime, wentToPenalties, extraTime, penalties, and the extraTime period of roughXG/matchControl if there is clear evidence in the posts or images that the match actually went beyond 90 minutes. Otherwise set wentToExtraTime and wentToPenalties to false, and omit or leave extraTime periods as null/zero. Leave fields as empty arrays, null, or "unknown" if not mentioned. Do not invent details not present in the posts or images. For matchControl, "home" and "away" should be numbers that sum to 100 (a rough relative split). For roughXG, "home" and "away" should be small decimal numbers in the style of real Expected Goals figures (e.g. 0.3, 0.8, 1.4, 2.1) — a rough qualitative impression of good-chance volume/quality per side, not a real calculated statistic. If a period isn't covered by any posts, use 0.0 for xG and 50/50 for matchControl, and say so in "note".`;

  const imageBlocks = [];
  for (const { post, imgUrl } of newImagePairs) {
    try {
      const { base64, mediaType } = await fetchImageAsBase64(imgUrl);
      imageBlocks.push({ type: 'text', text: `[Image posted by @${post.handle}, ${post.side} team, at ${post.createdAt}]` });
      imageBlocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } });
      alreadySeen.add(imgUrl);
    } catch (err) {
      console.warn(`Skipping image ${imgUrl}: ${err.message}`);
    }
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2500,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          ...imageBlocks,
        ],
      }],
    }),
  });

  const data = await res.json();
  if (!data.content) throw new Error(`Unexpected API response: ${JSON.stringify(data)}`);

  const raw = data.content.map(b => b.text || '').join('').trim();
  const cleaned = raw.replace(/```json|```/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Failed to parse AI response as JSON: ${err.message}\nRaw: ${raw}`);
  }

  const mergedMatch = mergeMatchData(previousOutput?.match, parsed);

  const output = {
    generatedAt: new Date().toISOString(),
    fixtureDate: dateStr,
    kickoff: fixture.kickoff,
    homeTeam: fixture.homeAway === 'H' ? 'Sandbach United' : fixture.opposition,
    awayTeam: fixture.homeAway === 'H' ? fixture.opposition : 'Sandbach United',
    postsUsed: combined.length,
    imagesAnalyzedThisRun: imageBlocks.length / 2,
    totalImagesAnalyzed: alreadySeen.size,
    match: mergedMatch,
  };

  fs.writeFileSync(archiveFile, JSON.stringify(output, null, 2));
  fs.writeFileSync(seenImagesFile, JSON.stringify([...alreadySeen]));

  let index = [];
  if (fs.existsSync('matchday-index.json')) {
    index = JSON.parse(fs.readFileSync('matchday-index.json', 'utf-8'));
  }
  const entry = {
    date: dateStr,
    homeTeam: output.homeTeam,
    awayTeam: output.awayTeam,
    score: mergedMatch.score || null,
  };
  const existing = index.find(e => e.date === dateStr);
  if (existing) {
    Object.assign(existing, entry);
  } else {
    index.push(entry);
  }
  index.sort((a, b) => new Date(b.date) - new Date(a.date));
  fs.writeFileSync('matchday-index.json', JSON.stringify(index, null, 2));

  if (!process.env.MATCHDAY_TEST_DATE) {
    fs.writeFileSync('matchday-live.json', JSON.stringify(output, null, 2));
  }

  console.log(`Saved ${archiveFile} (${combined.length} posts, ${imageBlocks.length / 2} new images this run, ${alreadySeen.size} total)`);
}

run().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
