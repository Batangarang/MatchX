const fs = require('fs');

function shouldRunHourlyTask() {
  const stateFile = '.scrape-lastrun.json';
  const now = new Date();

  let lastRun = null;
  if (fs.existsSync(stateFile)) {
    try { lastRun = new Date(JSON.parse(fs.readFileSync(stateFile, 'utf-8')).lastRun); } catch {}
  }

  const minutesSinceLastRun = lastRun ? (now - lastRun) / 60000 : Infinity;
  if (minutesSinceLastRun < 55) return false;

  fs.writeFileSync(stateFile, JSON.stringify({ lastRun: now.toISOString() }));
  return true;
}

module.exports = { shouldRunHourlyTask };
