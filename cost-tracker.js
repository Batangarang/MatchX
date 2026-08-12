cat > cost-tracker.js << 'EOF'
const fs = require('fs');

const COST_PER_GETXAPI_CALL_USD = 0.001;
const COST_PER_CLAUDE_CALL_USD = 0.015;
const USD_TO_GBP = 0.75;

function logCost(scriptName, { getxapiCalls = 0, claudeCalls = 0 }) {
  const logFile = 'cost-log.json';
  let log = { entries: [] };
  if (fs.existsSync(logFile)) {
    try { log = JSON.parse(fs.readFileSync(logFile, 'utf-8')); } catch {}
  }

  const xCostGBP = getxapiCalls * COST_PER_GETXAPI_CALL_USD * USD_TO_GBP;
  const aiCostGBP = claudeCalls * COST_PER_CLAUDE_CALL_USD * USD_TO_GBP;

  log.entries.push({
    script: scriptName,
    timestamp: new Date().toISOString(),
    getxapiCalls,
    claudeCalls,
    xCostGBP: Number(xCostGBP.toFixed(4)),
    aiCostGBP: Number(aiCostGBP.toFixed(4)),
  });

  const cutoff = Date.now() - 35 * 24 * 60 * 60 * 1000;
  log.entries = log.entries.filter(e => new Date(e.timestamp).getTime() > cutoff);

  fs.writeFileSync(logFile, JSON.stringify(log, null, 2));
}

module.exports = { logCost };
EOF