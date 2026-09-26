const fs = require('fs');
const CLUBS = require('./division-clubs.js');
const { getUserTweetsIncremental, getCallCount } = require('./getxapi-client.js');
const { logCost } = require('./cost-tracker.js');

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

function isManualRun() {
  return !!process.env.MATCHDAY_TEST_DATE;
}

function withinMatchWindow(kickoff, competitionNote) {
  if (isManualRun()) return true;
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
  return minutesFromKickoff >= -90 && minutesFromKickoff <= maxMinutesAfter;
}

async function getPostsForHandle(handle, dateStr, cached = []) {
  const dayStart = new Date(`${dateStr}T00:00:00Z`);
  const dayEnd = new Date(`${dateStr}T23:59:59Z`);
  // Incremental: reuse posts already saved earlier today and only ask GetXAPI
  // for newer ones (normally ONE call per account instead of up to 8 pages).
  const tweets = await getUserTweetsIncremental(handle, API_KEY, {
    cached,
    floorDate: dayStart,
    maxPagesFresh: 8,
    maxPagesIncremental: 3,
  });
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

function normalizeText(text) {
  return text.toLowerCase().replace(/https?:\/\/\S+/g, '').replace(/[^\w\s]/g, '').trim();
}

function textSimilarity(a, b) {
  const wordsA = new Set(normalizeText(a).split(/\s+/).filter(w => w.length > 3));
  const wordsB = new Set(normalizeText(b).split(/\s+/).filter(w => w.length > 3));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let shared = 0;
  wordsA.forEach(w => { if (wordsB.has(w)) shared++; });
  return shared / Math.min(wordsA.size, wordsB.size);
}

function tagDuplicateCommentary(combined, threshold = 0.6, minutesWindow = 5) {
  return combined.map((post, i) => {
    const isDuplicate = combined.some((other, j) => {
      if (i === j || post.side === other.side) return false;
      const minutesApart = Math.abs(new Date(post.createdAt) - new Date(other.createdAt)) / 60000;
      if (minutesApart > minutesWindow) return false;
      if (new Date(post.createdAt) <= new Date(other.createdAt)) return false;
      return textSimilarity(post.text, other.text) >= threshold;
    });
    return { ...post, isDuplicateCommentary: isDuplicate };
  });
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

function dedupeSimilarSubstitutions(subs) {
  const deduped = [];
  subs.forEach(s => {
    const sOffId = normalizeIdentity(s.playerOff);
    const sOnId = normalizeIdentity(s.playerOn);
    const matchIndex = deduped.findIndex(existing => {
      if (existing.team !== s.team) return false;
      if (Math.abs((existing.minute || 0) - (s.minute || 0)) > 3) return false;
      const existingOffId = normalizeIdentity(existing.playerOff);
      const existingOnId = normalizeIdentity(existing.playerOn);
      const offMatches = !existingOffId || !sOffId || namesLikelyMatch(existingOffId, sOffId);
      const onMatches = !existingOnId || !sOnId || namesLikelyMatch(existingOnId, sOnId);
      return offMatches && onMatches;
    });

    if (matchIndex === -1) {
      deduped.push(s);
    } else {
      const existing = deduped[matchIndex];
      const existingOffId = normalizeIdentity(existing.playerOff);
      const existingOnId = normalizeIdentity(existing.playerOn);
      const offIsMoreSpecific = sOffId && (!existingOffId || sOffId.length > existingOffId.length);
      const onIsMoreSpecific = sOnId && (!existingOnId || sOnId.length > existingOnId.length);
      deduped[matchIndex] = {
        ...existing,
        playerOff: offIsMoreSpecific ? s.playerOff : existing.playerOff,
        playerOn: onIsMoreSpecific ? s.playerOn : existing.playerOn,
        minute: s.minute ?? existing.minute,
      };
    }
  });
  return deduped;
}

function deriveScoreFromGoals(goals) {
  if (!goals || goals.length === 0) return null;
  const home = goals.filter(g => g.team === 'home').length;
  const away = goals.filter(g => g.team === 'away').length;
  return `${home}-${away}`;
}

function deriveHalfTimeScoreFromGoals(goals) {
  const firstHalfGoals = (goals || []).filter(g => (g.minute || 0) <= 45);
  if (firstHalfGoals.length === 0) return null;
  const home = firstHalfGoals.filter(g => g.team === 'home').length;
  const away = firstHalfGoals.filter(g => g.team === 'away').length;
  return `${home}-${away}`;
}


// ---------------------------------------------------------------------------
// Score confirmation
// The goal list alone is NOT trusted to define the score: both clubs often
// post the same goal, and a duplicate/mis-attributed goal turns 1-0 into 1-1.
// The score shown must be CONFIRMED by an explicitly stated scoreline —
// the same evidence division-scores.js uses — and the goal list is trimmed
// to agree with it. Goal-counting is only a last resort when nobody has
// stated a score.
// ---------------------------------------------------------------------------
function parseScore(str) {
  if (!str) return null;
  const m = String(str).match(/(\d+)\s*[-–—:]\s*(\d+)/) || String(str).match(/^\s*(\d+)\s+(\d+)\s*$/);
  return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : null;
}

function isUnnamedScorer(goal) {
  return !normalizeIdentity(goal.scorer);
}

// Remove surplus goals so each side's count matches the confirmed score.
// Unnamed goals go first, then the latest-minute goal. Removed goals are kept
// in `unconfirmed` for debugging rather than silently lost.
function trimGoalsToScore(goals, score) {
  const target = parseScore(score);
  if (!target) return { goals, unconfirmed: [] };
  const kept = [...goals];
  const unconfirmed = [];
  ['home', 'away'].forEach((team, i) => {
    let mine = kept.filter(g => g.team === team);
    while (mine.length > target[i]) {
      const victim = mine.find(isUnnamedScorer)
        || mine.reduce((latest, g) => ((g.minute || 0) >= (latest.minute || 0) ? g : latest), mine[0]);
      kept.splice(kept.indexOf(victim), 1);
      unconfirmed.push(victim);
      mine = kept.filter(g => g.team === team);
    }
  });
  return { goals: kept, unconfirmed };
}

// Read Sandbach's fixture from division-scores.js's output (same day only).
// Returns the score only when division-scores actually saw it STATED — a score
// division-scores merely derived from counting goals is not independent evidence.
function loadDivisionScore(dateStr, sandbachIsHome) {
  try {
    if (!fs.existsSync('division-scores.json')) return null;
    const ds = JSON.parse(fs.readFileSync('division-scores.json', 'utf-8'));
    if (!ds.isToday || ds.date !== dateStr) return null;
    const f = (ds.fixtures || []).find(x => /sandbach/i.test(x.home || '') || /sandbach/i.test(x.away || ''));
    if (!f || f.scoreSource !== 'explicit') return null;
    const parsed = parseScore(f.score);
    if (!parsed) return null;
    const divHasSandbachHome = /sandbach/i.test(f.home || '');
    const [h, a] = divHasSandbachHome === sandbachIsHome ? parsed : [parsed[1], parsed[0]];
    return { score: `${h}-${a}`, matchStage: f.matchStage || null, generatedAt: ds.generatedAt };
  } catch {
    return null;
  }
}

// Decide the score to display, and make the goal list agree with it.
//   match: { goals, feedScore, finalScoreAnnounced, matchStage }
function confirmScore(match, divisionScore, fallbackScore) {
  const goals = match.goals || [];
  const derived = deriveScoreFromGoals(goals);
  const feed = match.feedScore && parseScore(match.feedScore) ? match.feedScore : null;
  const division = divisionScore ? divisionScore.score : null;
  const ft = match.matchStage === 'full_time' && match.finalScoreAnnounced && parseScore(match.finalScoreAnnounced)
    ? match.finalScoreAnnounced : null;

  let score, scoreSource, scoreConfirmed = true, note = null;
  if (ft) {
    score = ft; scoreSource = 'announced_full_time';
  } else if (division && feed && division === feed) {
    score = division; scoreSource = 'confirmed_by_both_feeds';
  } else if (division && feed && division !== feed) {
    score = division; scoreSource = 'division_scores';
    note = `Match feed said ${feed} but the division live-scores feed said ${division} — showing ${division}.`;
  } else if (division) {
    score = division; scoreSource = 'division_scores';
  } else if (feed) {
    score = feed; scoreSource = 'match_feed_stated';
  } else if (derived) {
    score = derived; scoreSource = 'goal_count_only'; scoreConfirmed = false;
  } else {
    score = fallbackScore || null; scoreSource = 'none'; scoreConfirmed = false;
  }

  let finalGoals = goals;
  let unconfirmedGoals = [];
  if (scoreConfirmed) {
    const trimmed = trimGoalsToScore(goals, score);
    finalGoals = trimmed.goals;
    unconfirmedGoals = trimmed.unconfirmed;
    if (unconfirmedGoals.length && !note) {
      note = `Goal reports suggested ${derived} but the confirmed score is ${score} — ${unconfirmedGoals.length} unconfirmed goal report(s) ignored.`;
    }
  } else if (scoreSource === 'goal_count_only') {
    note = `Score inferred from goal reports only (${score}) — no scoreline has been stated yet to confirm it.`;
  }

  return { score, scoreSource, scoreConfirmed, scoreDiscrepancy: note, goals: finalGoals, unconfirmedGoals };
}

function mergeMatchData(previous, incoming, divisionScore) {
  if (!previous) {
    const dedupedGoals = dedupeSimilarGoals(incoming.goals || []);
    const announcedScore = incoming.finalScoreAnnounced || null;
    const feedScore = incoming.scoreEvidence ? (incoming.score || null) : null;
    const confirmed = confirmScore(
      { goals: dedupedGoals, feedScore, finalScoreAnnounced: announcedScore, matchStage: incoming.matchStage },
      divisionScore, incoming.score
    );
    const derivedHT = deriveHalfTimeScoreFromGoals(confirmed.goals);
    const announcedHT = incoming.halfTimeScoreAnnounced || null;
    const htDiscrepancy = (announcedHT && derivedHT && announcedHT !== derivedHT)
      ? `First-half goals suggest HT ${derivedHT}, but an announced HT score of ${announcedHT} was also seen.`
      : null;

    return {
      ...incoming,
      goals: confirmed.goals,
      unconfirmedGoals: confirmed.unconfirmedGoals,
      score: confirmed.score,
      scoreSource: confirmed.scoreSource,
      scoreConfirmed: confirmed.scoreConfirmed,
      feedScore,
      scoreDiscrepancy: confirmed.scoreDiscrepancy,
      halfTimeScoreAnnounced: announcedHT,
      htDiscrepancy,
      finalScoreAnnounced: announcedScore,
      substitutions: dedupeSimilarSubstitutions(incoming.substitutions || []),
      yellowCards: dedupeSimilarEvents(incoming.yellowCards || [], ['team', 'player']),
      redCards: dedupeSimilarEvents(incoming.redCards || [], ['team', 'player']),
      sinBins: dedupeSimilarEvents(incoming.sinBins || [], ['team', 'player']),
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
  const mergedSinBins = dedupeSimilarEvents(
    mergeArrays(previous.sinBins, incoming.sinBins, s => `${s.minute}-${s.player}-${s.team}`),
    ['team', 'player']
  );

  const announcedScore = incoming.finalScoreAnnounced || previous.finalScoreAnnounced || null;
  const feedScore = incoming.scoreEvidence ? (incoming.score || null) : null;
  const stageNow = incoming.matchStage && incoming.matchStage !== 'scheduled' ? incoming.matchStage : previous.matchStage;
  const confirmed = confirmScore(
    { goals: mergedGoals, feedScore, finalScoreAnnounced: announcedScore, matchStage: stageNow },
    divisionScore, previous.score
  );

  const derivedHT = deriveHalfTimeScoreFromGoals(confirmed.goals);
  const announcedHT = incoming.halfTimeScoreAnnounced || previous.halfTimeScoreAnnounced || null;
  const htDiscrepancy = (announcedHT && derivedHT && announcedHT !== derivedHT)
    ? `First-half goals suggest HT ${derivedHT}, but an announced HT score of ${announcedHT} was also seen.`
    : null;

  return {
    score: confirmed.score,
    scoreSource: confirmed.scoreSource,
    scoreConfirmed: confirmed.scoreConfirmed,
    feedScore,
    scoreDiscrepancy: confirmed.scoreDiscrepancy,
    unconfirmedGoals: confirmed.unconfirmedGoals,
    finalScoreAnnounced: announcedScore,
    halfTimeScoreAnnounced: announcedHT,
    htDiscrepancy,
    matchStage: stageNow,
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
    goals: confirmed.goals,
    yellowCards: mergedYellowCards,
    redCards: mergedRedCards,
    substitutions: dedupeSimilarSubstitutions(
      mergeArrays(previous.substitutions, incoming.substitutions, s => `${s.minute}-${s.playerOff}-${s.playerOn}`)
    ),
    sinBins: mergedSinBins,
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

  const archiveFile = `matchday-archive/${dateStr}.json`;
  let previousOutput = null;
  if (fs.existsSync(archiveFile)) {
    previousOutput = JSON.parse(fs.readFileSync(archiveFile, 'utf-8'));
  }

  // ---------- Full-time early-exit ----------
  // Once full-time is confirmed, stop polling — except for a short window
  // afterward in case of extra time/penalties, which get their own longer allowance.
  if (previousOutput?.match?.matchStage === 'full_time' && !isManualRun()) {
    const lastUpdate = new Date(previousOutput.generatedAt);
    const minutesSinceUpdate = (new Date() - lastUpdate) / 60000;

    if (previousOutput.match.wentToExtraTime) {
      if (minutesSinceUpdate > 90) {
        console.log('Extra time confirmed a while ago — assuming match fully concluded, stopping polling.');
        return;
      }
    } else if (minutesSinceUpdate > 20) {
      console.log('Full-time confirmed 20+ minutes ago with no extra time detected — stopping polling.');
      return;
    }
  }

  const homeHandle = fixture.homeAway === 'H' ? 'SandbachFC_1st' : findHandle(fixture.opposition);
  const awayHandle = fixture.homeAway === 'H' ? findHandle(fixture.opposition) : 'SandbachFC_1st';

  if (!homeHandle && !awayHandle) {
    console.log(`Could not resolve either handle — skipping.`);
    return;
  }

  // Reuse posts saved earlier today so we only fetch what's new.
  let cachedRaw = [];
  try {
    const rawFile = `matchday-archive/${dateStr}-raw-posts.json`;
    if (fs.existsSync(rawFile)) cachedRaw = JSON.parse(fs.readFileSync(rawFile, 'utf-8'));
  } catch {}
  const cachedFor = h => cachedRaw.filter(p => p.handle === h);

  const [homePosts, awayPosts] = await Promise.all([
    homeHandle ? getPostsForHandle(homeHandle, dateStr, cachedFor(homeHandle)) : Promise.resolve([]),
    awayHandle ? getPostsForHandle(awayHandle, dateStr, cachedFor(awayHandle)) : Promise.resolve([]),
  ]);

  // Independent second source for the score: what division-scores.js has
  // confirmed from explicitly stated scorelines.
  const divisionScore = loadDivisionScore(dateStr, fixture.homeAway === 'H');

  const combinedRaw = [
    ...homePosts.map(p => ({ ...p, side: 'home', handle: homeHandle })),
    ...awayPosts.map(p => ({ ...p, side: 'away', handle: awayHandle })),
  ].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  const combined = tagDuplicateCommentary(combinedRaw);

  if (!fs.existsSync('matchday-archive')) fs.mkdirSync('matchday-archive');
  fs.writeFileSync(`matchday-archive/${dateStr}-raw-posts.json`, JSON.stringify(combined, null, 2));

  if (combined.length === 0) {
    console.log('No posts found from either account — skipping AI extraction.');
    logCost('matchday-live', { getxapiCalls: getCallCount() });
    return;
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
    // No new posts, but the division feed may have confirmed/corrected the
    // score since last time — re-check it for free (no AI call).
    const prevMatch = previousOutput.match;
    if (prevMatch && divisionScore) {
      const re = confirmScore(prevMatch, divisionScore, prevMatch.score);
      if (re.score !== prevMatch.score || re.goals.length !== (prevMatch.goals || []).length) {
        const updated = {
          ...previousOutput,
          generatedAt: new Date().toISOString(),
          match: { ...prevMatch, score: re.score, scoreSource: re.scoreSource, scoreConfirmed: re.scoreConfirmed, scoreDiscrepancy: re.scoreDiscrepancy, goals: re.goals, unconfirmedGoals: re.unconfirmedGoals },
        };
        fs.writeFileSync(archiveFile, JSON.stringify(updated, null, 2));
        if (!process.env.MATCHDAY_TEST_DATE) fs.writeFileSync('matchday-live.json', JSON.stringify(updated, null, 2));
        if (fs.existsSync('matchday-index.json')) {
          const idx = JSON.parse(fs.readFileSync('matchday-index.json', 'utf-8'));
          const e = idx.find(x => x.date === dateStr);
          if (e) { e.score = re.score; fs.writeFileSync('matchday-index.json', JSON.stringify(idx, null, 2)); }
        }
        console.log(`Score re-confirmed against division feed: ${prevMatch.score} -> ${re.score}`);
      }
    }
    logCost('matchday-live', { getxapiCalls: getCallCount() });
    return;
  }

  const postsForPrompt = combined.filter(p => !p.isDuplicateCommentary);
  const postsText = postsForPrompt.map(p => `[${p.createdAt}] (@${p.handle}, ${p.side} team) ${p.text}`).join('\n');
  const isCup = fixture.competitionNote && /cup|vase|trophy/i.test(fixture.competitionNote);

  const prompt = `Below are X posts (and some attached images) from the home and away teams' official accounts on the day of a football match: ${fixture.homeAway === 'H' ? 'Sandbach United' : fixture.opposition} vs ${fixture.homeAway === 'H' ? fixture.opposition : 'Sandbach United'}, played ${fixture.date}${isCup ? ` (a cup competition: ${fixture.competitionNote} — this match could go to extra time and penalties)` : ' (a league match — normally 90 minutes, no extra time)'}.

IMPORTANT: Sandbach United specifically have ONE player with the surname "Foley" (not to be confused with the opposing club "Foley Meir"). This distinction ONLY matters when it's ambiguous whether "Foley" refers to that Sandbach player or to the club Foley Meir. If a post clearly names a different, specific player (e.g. "Kyle Foley", "Jack Foley") who is NOT further identified as Sandbach's player, do not assume they must be that Sandbach player — trust the team/side the post itself indicates.

IMPORTANT: Both the home and away clubs may separately post about the SAME goal, card, or event. Do NOT report the same real-world event twice just because both clubs mentioned it — treat matching or clearly-corroborating mentions from each side as ONE event, not two.

IMPORTANT: If a post is a CORRECTION to an earlier goal, do NOT add this as a new goal — it replaces the earlier reported goal.

IMPORTANT: When a post describes a foul or clash between two players before mentioning a card, the card belongs to the player who COMMITTED the foul, not the player who was fouled.

IMPORTANT: When extracting "finalScoreAnnounced" or "halfTimeScoreAnnounced", only use a scoreline explicitly stated in a post that comes AT OR AFTER the point in the match it claims to describe. Do not use an outdated scoreline that predates goals also visible in these posts.

IMPORTANT: Scorelines in these posts may be written without a dash, e.g. "2 1" instead of "2-1", or with the word "nil" (e.g. "1 nil", "one-nil", "2-nil" means 2-0). Recognise these as valid too, and normalise to "X-Y" form, HOME team first. Clubs often list their OWN score first even when playing away, so use the team names/context to put the home team's score first.

IMPORTANT: For "score", use the MOST RECENT scoreline explicitly stated in the posts (from either club) — never add up goals yourself. If no post states a scoreline, "score" must be null. Put the exact wording of the post you took it from in "scoreEvidence".

Posts:
${postsText}

Using information present in these posts AND any attached images, build a structured match summary. Respond with ONLY a JSON object, no other text, no markdown fences, in exactly this shape:

{
  "score": "string or null — the most recent scoreline EXPLICITLY STATED in a post (home-away), or null. Never calculate this from goal mentions.",
  "scoreEvidence": "string or null — the exact text of the post that states that scoreline; null if score is null",
  "finalScoreAnnounced": "string or null — ONLY if a post explicitly states the full-time score as a direct statement",
  "halfTimeScoreAnnounced": "string or null — ONLY if a post explicitly states the half-time score as a direct statement",
  "matchStage": "one of: scheduled, first_half, half_time, second_half, extra_time, penalties, full_time — ONLY set to half_time or full_time when a post EXPLICITLY ANNOUNCES it (including abbreviations like 'HT'/'FT'), never guess from elapsed time",
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
  "extraTime": { "score": null, "goals": [] },
  "penalties": { "finalScore": null, "takers": [] },
  "roughXG": {
    "firstHalf": { "home": 0.0, "away": 0.0, "note": "string" },
    "secondHalf": { "home": 0.0, "away": 0.0, "note": "string" },
    "extraTime": { "home": 0.0, "away": 0.0, "note": "string" },
    "total": { "home": 0.0, "away": 0.0, "note": "string" },
    "disclaimer": "Rough estimate inferred from social media commentary, not real shot data — not an accurate xG figure."
  },
  "matchControl": {
    "firstHalf": { "home": 50, "away": 50, "note": "string" },
    "secondHalf": { "home": 50, "away": 50, "note": "string" },
    "extraTime": { "home": 50, "away": 50, "note": "string" },
    "total": { "home": 50, "away": 50, "note": "string" },
    "disclaimer": "Inferred from tone/content of posts only, not real possession or shot data."
  }
}

For lineups: if shirt numbers are visible, format each player as "N. Player Name". For substitutions: "playerOff" is the player being TAKEN OFF, "playerOn" is the player COMING ON. Be conservative with roughXG and matchControl when there is little material. Only populate wentToExtraTime/wentToPenalties/extraTime/penalties if there is clear evidence the match went beyond 90 minutes.

IMPORTANT: If actual goals have been scored, roughXG must reflect that clearly — a team that has scored 2+ goals should show a roughXG total meaningfully above those goals (e.g. 2+ goals means roughXG of at least 1.5-2.5+, never 0.0 or near-zero). Do NOT apply the "be conservative" guidance to a team that has genuinely scored — conservatism is for judging chances/quality when little happened, not for denying real goals already in the data. The number of real goals scored is always a hard floor under the roughXG estimate.`;

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

  const mergedMatch = mergeMatchData(previousOutput?.match, parsed, divisionScore);

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
  logCost('matchday-live', {
    getxapiCalls: getCallCount(),
    claudeCalls: 1,
    inputTokens: data.usage?.input_tokens || 0,
    outputTokens: data.usage?.output_tokens || 0,
  });
  console.log(`Saved ${archiveFile} (${combined.length} posts, ${imageBlocks.length / 2} new images this run, ${alreadySeen.size} total)`);
}

run().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
