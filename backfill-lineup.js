const fs = require('fs');

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// The three earliest-posted images from tonight — most likely candidates
// for team news / lineup / programme graphics, based on posting order
const candidateUrls = [
  'https://pbs.twimg.com/media/HO3PNbfWkAAE-8C.jpg',
  'https://pbs.twimg.com/media/HO3shfeXkAA3fQz.png',
  'https://pbs.twimg.com/media/HO3zdKSWsAAXLtL.png',
];

async function fetchImageAsBase64(url) {
  const res = await fetch(url);
  const buffer = await res.arrayBuffer();
  return {
    base64: Buffer.from(buffer).toString('base64'),
    mediaType: res.headers.get('content-type') || 'image/jpeg',
  };
}

async function run() {
  const imageBlocks = [];
  for (const url of candidateUrls) {
    try {
      const { base64, mediaType } = await fetchImageAsBase64(url);
      imageBlocks.push({ type: 'text', text: `[Image ${url}]` });
      imageBlocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } });
    } catch (err) {
      console.warn(`Could not fetch ${url}: ${err.message}`);
    }
  }

  const prompt = `Below are one or more images from Foley Meir FC's X account before/around a match. If any image shows a team lineup/starting XI list, extract it. Respond with ONLY JSON, no other text:
{
  "found": true or false,
  "sourceUrl": "the URL of the image that had the lineup, or null",
  "players": ["array of starting XI names in shirt-number order if visible"],
  "substitutes": ["array of substitute names if shown"],
  "manager": "manager name if shown, or null"
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
      max_tokens: 1000,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, ...imageBlocks] }],
    }),
  });

  const data = await res.json();
  const raw = data.content.map(b => b.text || '').join('').trim();
  const cleaned = raw.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(cleaned);

  console.log(JSON.stringify(parsed, null, 2));

  if (parsed.found) {
    const archive = JSON.parse(fs.readFileSync('matchday-archive/2026-08-04.json', 'utf-8'));
    archive.match.lineups.home.players = parsed.players || [];
    archive.match.lineups.home.substitutes = parsed.substitutes || [];
    archive.match.lineups.home.manager = parsed.manager || null;
    fs.writeFileSync('matchday-archive/2026-08-04.json', JSON.stringify(archive, null, 2));
    fs.writeFileSync('matchday-live.json', JSON.stringify(archive, null, 2));
    console.log('Lineup restored and saved.');
  } else {
    console.log('No lineup found in the candidate images — may need manual entry instead.');
  }
}

run().catch(err => console.error('Failed:', err.message));