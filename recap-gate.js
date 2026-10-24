// Only 'preview' and 'recap' are live modes — their output
// (division-insights-preview.json / division-insights-recap.json) is what
// index.html actually reads. The other RECAP_MODE values this script sees
// (weekend-preview, weekend-recap, midweek-preview, midweek-recap) come from
// four leftover workflows whose output files nothing on the site reads —
// confirmed by searching index.html and admin.html for any reference to
// them. Those workflows were still running division-posts.js (a GetXAPI
// call per club) on every cron-job.org firing with no benefit. Block them
// here rather than relying on remembering to disable their external
// triggers. NOTE: this script's stdout is appended straight to
// $GITHUB_OUTPUT, so it must print exactly one "run=..." line and nothing
// else — any explanation goes to stderr instead.
const LIVE_MODES = new Set(['preview', 'recap']);
const mode = process.env.RECAP_MODE;

if (!LIVE_MODES.has(mode)) {
  console.error(`RECAP_MODE "${mode}" is not a live mode — skipping (no front-end code reads this workflow's output), saving a GetXAPI fetch.`);
  console.log('run=false');
} else {
  console.log('run=true');
}
