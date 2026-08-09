// hourly-gate.js
const fs = require('fs');

function shouldRunHourlyTask() {
  if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') return true;

  const stateFile = '.scrape-lastrun.json';
  const now = new Date();

  let lastRun = null;
  if (fs.existsSync(stateFile)) {
    try { lastRun = new Date(JSON.parse(fs.readFileSync(stateFile, 'utf-8')).lastRun); } catch {}
  }

  const minutesSinceLastRun = lastRun ? (now - lastRun) / 60000 : Infinity;
  if (minutesSinceLastRun < 55) return false; // roughly hourly, with a little buffer

  fs.writeFileSync(stateFile, JSON.stringify({ lastRun: now.toISOString() }));
  return true;
}

module.exports = { shouldRunHourlyTask };