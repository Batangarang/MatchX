const cheerio = require('cheerio');
const fs = require('fs');

const LIST_URL = 'https://www.nwcfl.com/news.php';
const MAX_NEW_ARTICLES_PER_RUN = 5;

async function getArticleList() {
  const res = await fetch(LIST_URL);
  const html = await res.text();
  const $ = cheerio.load(html);

  const articles = [];
  $('a[href*="news-articles.php?id="]').each((i, el) => {
    const href = $(el).attr('href');
    const idMatch = href.match(/id=(\d+)/);
    if (!idMatch) return;
    const id = idMatch[1];
    if (articles.find(a => a.id === id)) return; // page repeats the list twice in the markup
    articles.push({ id, title: $(el).text().trim().split('\n')[0].trim() });
  });
  return articles;
}

async function getArticleBody(id) {
  const res = await fetch(`https://www.nwcfl.com/news-articles.php?id=${id}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const title = $('h1').first().text().trim();
  const meta = $('h1').first().nextAll('h4, .meta, p').first().text().trim();

  // Grab the main article paragraphs — everything between the h1/meta line
  // and the "More ... News" related-articles section
  const paragraphs = [];
  let started = false;
  $('body').find('p, h4').each((i, el) => {
    const text = $(el).text().trim();
    if (!text) return;
    if (text.includes(title.slice(0, 15))) return;
    if (text.match(/\d{4}\s*\|/) && !started) { started = true; return; } // the date/category line
    if (text.startsWith('More ') && text.includes('News')) started = false;
    if (started) paragraphs.push(text);
  });

  return { title, meta, body: paragraphs.join('\n\n') };
}

async function run() {
  const listArticles = await getArticleList();

  let seen = [];
  if (fs.existsSync('nwcfl-news-seen.json')) {
    seen = JSON.parse(fs.readFileSync('nwcfl-news-seen.json', 'utf-8'));
  }

  const newArticles = listArticles.filter(a => !seen.includes(a.id)).slice(0, MAX_NEW_ARTICLES_PER_RUN);

  if (newArticles.length === 0) {
    console.log('No new articles since last check.');
    return;
  }

  let existing = [];
  if (fs.existsSync('nwcfl-news.json')) {
    existing = JSON.parse(fs.readFileSync('nwcfl-news.json', 'utf-8')).articles || [];
  }

  for (const article of newArticles) {
    try {
      const full = await getArticleBody(article.id);
      existing.unshift({
        id: article.id,
        title: full.title || article.title,
        meta: full.meta,
        body: full.body,
        url: `https://www.nwcfl.com/news-articles.php?id=${article.id}`,
        scrapedAt: new Date().toISOString(),
      });
      seen.push(article.id);
      console.log(`Captured: ${full.title} (${full.body.length} chars)`);
    } catch (err) {
      console.warn(`Failed to fetch article ${article.id}: ${err.message}`);
    }
  }

  // Keep only the most recent 20 articles in the working file
  existing = existing.slice(0, 20);

  fs.writeFileSync('nwcfl-news.json', JSON.stringify({ generatedAt: new Date().toISOString(), articles: existing }, null, 2));
  fs.writeFileSync('nwcfl-news-seen.json', JSON.stringify(seen.slice(-200), null, 2)); // cap seen-list growth

  console.log(`Saved ${newArticles.length} new articles.`);
}

run().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});