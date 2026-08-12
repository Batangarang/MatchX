const fs = require('fs');

const COST_PER_GETXAPI_CALL_USD = 0.001;
// Claude Haiku 4.5 published rates, per million tokens
const CLAUDE_INPUT_PER_MILLION_USD = 1.00;
const CLAUDE_OUTPUT_PER_MILLION_USD = 5.00;
const USD_TO_GBP = 0.75;

function logCost(scriptName, { getxapiCalls = 0, claudeCalls = 0, inputTokens = 0, outputTokens = 0 }) {
  const logFile = 'cost-log.json';
  let log = { entries: [] };
  if (fs.existsSync(logFile)) {
    try { log = JSON.parse(fs.readFileSync(logFile, 'utf-8')); } catch {}
  }

  const xCostGBP = getxapiCalls * COST_PER_GETXAPI_CALL_USD * USD_TO_GBP;

  const aiCostUSD = claudeCalls > 0 && (inputTokens > 0 || outputTokens > 0)
    ? (inputTokens / 1_000_000) * CLAUDE_INPUT_PER_MILLION_USD + (outputTokens / 1_000_000) * CLAUDE_OUTPUT_PER_MILLION_USD
    : claudeCalls * 0.015; // fallback flat estimate if a script hasn't been updated to pass real tokens yet
  const aiCostGBP = aiCostUSD * USD_TO_GBP;

  log.entries.push({
    script: scriptName,
    timestamp: new Date().toISOString(),
    getxapiCalls,
    claudeCalls,
    inputTokens,
    outputTokens,
    xCostGBP: Number(xCostGBP.toFixed(4)),
    aiCostGBP: Number(aiCostGBP.toFixed(4)),
  });

  const cutoff = Date.now() - 35 * 24 * 60 * 60 * 1000;
  log.entries = log.entries.filter(e => new Date(e.timestamp).getTime() > cutoff);

  fs.writeFileSync(logFile, JSON.stringify(log, null, 2));
}

module.exports = { logCost };