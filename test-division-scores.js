const fs = require('fs');

const TARGET_DATE = '2026-08-08';
const SIMULATED_MINUTE = parseInt(process.env.SIM_MINUTE || '45');
const KICKOFF = '15:00'; // earliest kickoff across the division that day

function run() {
  const rawPostsFile = `division-archive-${TARGET_DATE}-raw-posts.json`;
  if (!fs.existsSync(rawPostsFile)) {
    console.log(`${rawPostsFile} not found — run backfill-division-posts.js first.`);
    return;
  }

  const allPosts = JSON.parse(fs.readFileSync(rawPostsFile, 'utf-8'));

  const [hh, min] = KICKOFF.split(':');
  const kickoffTime = new Date(`${TARGET_DATE}T${hh}:${min}:00Z`);
  kickoffTime.setUTCHours(kickoffTime.getUTCHours() - 1); // BST adjustment

  const cutoff = new Date(kickoffTime.getTime() + SIMULATED_MINUTE * 60000);
  const postsUpToMinute = allPosts.filter(p => new Date(p.createdAt) <= cutoff);

  console.log(`Minute ${SIMULATED_MINUTE}: ${postsUpToMinute.length} of ${allPosts.length} total posts would exist.`);
  postsUpToMinute.forEach(p => console.log(`  [${p.createdAt}] (${p.club}) ${p.text.slice(0, 80)}`));

  fs.writeFileSync(`test-division-snapshot-${SIMULATED_MINUTE}.json`, JSON.stringify(postsUpToMinute, null, 2));
}

run();