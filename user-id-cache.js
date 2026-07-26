const fs = require('fs');

const CACHE_FILE = 'user-ids.json';

function loadCache() {
  if (!fs.existsSync(CACHE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

async function getUserIdCached(username, bearerToken) {
  const cache = loadCache();

  if (cache[username]) {
    return cache[username];
  }

  const res = await fetch(`https://api.x.com/2/users/by/username/${username}`, {
    headers: { Authorization: `Bearer ${bearerToken}` },
  });
  const data = await res.json();
  if (!data.data) {
    throw new Error(`user lookup failed for ${username}: ${JSON.stringify(data)}`);
  }

  cache[username] = data.data.id;
  saveCache(cache);

  return data.data.id;
}

module.exports = { getUserIdCached };