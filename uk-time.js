// Returns whether a given moment (default: now) falls within British Summer
// Time. BST runs from 01:00 UTC on the last Sunday of March to 01:00 UTC on
// the last Sunday of October.
//
// Previously this (and four other copies of the same check scattered across
// division-scores.js, division-recap-engine.js, matchday-live.js and
// x-posts.js) used a crude "April through September" month range, which is
// wrong at both ends: it misses the back half of March (BST can start as
// early as the 25th) and misses ALL of October (BST runs until as late as
// the 31st). Confirmed live on 24 Oct 2026 — division-scores.js thought GMT
// was already in effect, miscalculated kickoff times by an hour, and
// decided the match hadn't started yet, so live scores stopped updating.
function isBST(date = new Date()) {
  const year = date.getUTCFullYear();

  // Last Sunday of March, 01:00 UTC — clocks go forward.
  const marchEnd = new Date(Date.UTC(year, 2, 31, 1, 0, 0));
  marchEnd.setUTCDate(31 - marchEnd.getUTCDay());

  // Last Sunday of October, 01:00 UTC — clocks go back.
  const octEnd = new Date(Date.UTC(year, 9, 31, 1, 0, 0));
  octEnd.setUTCDate(31 - octEnd.getUTCDay());

  return date >= marchEnd && date < octEnd;
}

// Returns the current date/time as if it were UK local time, accounting for BST/GMT.
function getUKNow() {
  const now = new Date();
  const offsetHours = isBST(now) ? 1 : 0;
  return new Date(now.getTime() + offsetHours * 60 * 60 * 1000);
}

function getUKDateString(date = getUKNow()) {
  return date.getUTCFullYear() + '-' +
    String(date.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(date.getUTCDate()).padStart(2, '0');
}

module.exports = { getUKNow, getUKDateString, isBST };
