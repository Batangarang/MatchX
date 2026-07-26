const fs = require('fs');

const API_KEY = process.env.ANTHROPIC_API_KEY;

function isSameUKDay(isoString) {
  const postDate = new Date(isoString);
  const now = new Date();
  return postDate.getUTCFullYear() === now.getUTCFullYear() &&
         postDate.getUTCMonth() === now.getUTCMonth() &&
         postDate.getUTCDate() === now.getUTCDate();
}

async function run() {
  if (!API_KEY) {
    throw new Error('ANTHROPIC_API_KEY environment variable not set');
  }

  if (!fs.existsSync('x-posts.json')) {
    console.log('No x-posts.json found yet — skipping insight generation.');
    return;
  }

  const postsData = JSON.parse(fs.readFileSync('x-posts.json', 'utf-8'));
  const allPosts = postsData.posts || [];
  const posts = allPosts.filter(p => isSameUKDay(p.createdAt));

  if (posts.length === 0) {
    console.log('No posts from today — skipping insight generation, keeping previous summary.');
    return;
  }

  const postsText = posts.map(p => `[${p.createdAt}] ${p.text}`).join('\n\n');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Here are recent posts from Sandbach United's official 1st team X account, all posted today:

${postsText}

Write a short, friendly 2-3 sentence summary for fans, covering things like recent form, team news, or anything notable. Plain text only, no markdown, no headers.`,
      }],
    }),
  });

  const data = await res.json();

  if (!data.content) {
    throw new Error(`Unexpected API response: ${JSON.stringify(data)}`);
  }

  const summary = data.content.map(b => b.text || '').join('').trim();

  const output = {
    generatedAt: new Date().toISOString(),
    postsConsidered: posts.length,