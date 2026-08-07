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

  let nwcflContext = '';
  if (fs.existsSync('nwcfl-news.json')) {
    const news = JSON.parse(fs.readFileSync('nwcfl-news.json', 'utf-8'));
    const recentSandbachMentions = (news.articles || [])
      .filter(a => a.body.toLowerCase().includes('sandbach'))
      .slice(0, 2);
    if (recentSandbachMentions.length > 0) {
      nwcflContext = '\n\nRelevant league news mentioning Sandbach:\n' +
        recentSandbachMentions.map(a => `[${a.title}] ${a.body.slice(0, 500)}`).join('\n\n');
    }
  }

  const postsData = JSON.parse(fs.readFileSync('x-posts.json', 'utf-8'));
  const allPosts = postsData.posts || [];

  if (allPosts.length === 0) {
    console.log('No posts at all — skipping insight generation.');
    return;
  }

  const todaysPosts = allPosts.filter(p => isSameUKDay(p.createdAt));
  const isToday = todaysPosts.length > 0;
  const posts = isToday ? todaysPosts : allPosts.slice(0, 5);

  const postsText = posts.map(p => `[${p.createdAt}] ${p.text}`).join('\n\n');
  const contextNote = isToday
    ? "all posted today"
    : `the most recent available (from ${posts[posts.length - 1].createdAt.slice(0, 10)} to ${posts[0].createdAt.slice(0, 10)}) — there's nothing newer yet`;

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
        content: `Here are recent posts from Sandbach United's official 1st team X account, ${contextNote}:

${postsText}

${nwcflContext} Write a short, friendly 2-3 sentence summary for fans, covering things like recent form, team news, or anything notable. Use player and club names exactly as they'd normally be written in football reporting — if a name in the source posts includes emoji, numbers, hashtags, or decorative styling (e.g. "Joe Bev97" or "J.Bevan⚽"), extract just the real underlying name and ignore the decoration. Do not use the word "today" or "this morning" anywhere in the summary, since it may be read days later — use durable phrasing instead (e.g. "in their last match," "recently," or the actual date). Plain text only, no markdown, no headers.`,
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
    isFromToday: isToday,
    postsConsidered: posts.length,
    summary,
  };

  fs.writeFileSync('x-insights.json', JSON.stringify(output, null, 2));
  console.log('Saved insight:', summary);
}

run().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});