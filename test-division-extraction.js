const fs = require('fs');

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SNAPSHOT_FILE = process.argv[2] || 'test-division-snapshot-90.json';

async function run() {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY not set');

  const posts = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf-8'));

  const fixtureList = [...new Set(posts.map(p => p.club))].join(', ');
  const postsText = posts.map(p => `[${p.createdAt}] (@${p.handle} — ${p.club}) ${p.text}`).join('\n');

  const prompt = `Here are today's First Division South clubs with recent posts: ${fixtureList}

Here are their X posts so far today, in chronological order:
${postsText}

Scorelines in these posts may be written without a dash, e.g. "2 1" instead of "2-1". Recognise these as valid too, and normalise to "X-Y" form.

IMPORTANT: A club's score can change multiple times as goals are scored throughout the match. Always use the MOST RECENT scoreline mentioned for each fixture — do not use an early or outdated scoreline just because it was clearly stated, if a later post shows a different, more current score for the same fixture. Read through ALL posts for a given fixture and identify the latest one before deciding the score.

For each club above, determine ONLY if a score has been EXPLICITLY stated in a post (e.g. "2-1", a clear scoreline mention) — do not guess or infer, but always prefer the LATEST such mention over an earlier one. Also note any red card sent-offs explicitly mentioned.
Respond with ONLY a JSON object, no other text, no markdown fences:
{
  "fixtures": [
    { "clubsInvolved": "e.g. Sandbach United v Stafford Town", "score": "string or null", "redCards": [{ "club": "string", "player": "string or null" }] }
  ]
}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await res.json();
  if (!data.content) throw new Error(`Unexpected API response: ${JSON.stringify(data)}`);

  const raw = data.content.map(b => b.text || '').join('').trim();
  const cleaned = raw.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(cleaned);

  console.log(JSON.stringify(parsed, null, 2));
  fs.writeFileSync('test-division-extraction-result.json', JSON.stringify(parsed, null, 2));
}

run().catch(err => console.error('Failed:', err.message));