#!/usr/bin/env node
/**
 * booktok-scraper.js
 *
 * Scrapes specific Instagram hashtags/accounts AND specific subreddits via
 * Apify (two different actors, one pipeline), then uses
 * Claude to extract structured book mentions from each post \u2014 from the
 * caption text, and from cover art / screenshots / text overlays in images
 * \u2014 producing a JSON file in the same shape as the app's CURATED_DATASET:
 *   [{ title, author, info }, ...]
 *
 * Image handling: uses Claude's vision input to actually look at post
 * images (and a video's thumbnail frame) when the caption alone isn't
 * enough to identify a book. This is a genuine cost optimization, not
 * just simplicity \u2014 image input costs meaningfully more per call than
 * text, so it's only used when needed.
 *
 * Video limitation, stated plainly: Claude's API does not understand video.
 * For video posts (Reels), this only looks at the video's cover thumbnail
 * as a still image \u2014 it does not watch the video or transcribe audio.
 * That catches a lot of BookTok content (cover reveals, text-overlay
 * recommendations often shown as the opening frame), but misses anything
 * that's spoken or only appears partway through a clip. True video
 * understanding (frame sampling + audio transcription) would need
 * additional tooling (e.g. ffmpeg + a speech-to-text service) and is a
 * meaningfully bigger build \u2014 not included here.
 *
 * This is a server-side / offline script. It is NOT meant to run in the
 * browser \u2014 it needs two secret keys that must never be embedded in the
 * Book Concierge app itself.
 *
 * ---- Setup ----
 * 1. npm init -y && npm pkg set type=module   (uses top-level await + fetch)
 * 2. Get an Apify token:      https://console.apify.com/settings/integrations
 * 3. Get an Anthropic key:    https://console.anthropic.com
 * 4. Set them as environment variables (never hard-code or commit these):
 *      export APIFY_TOKEN=your_apify_token
 *      export ANTHROPIC_API_KEY=your_anthropic_key
 * 5. Edit the HASHTAGS and ACCOUNTS lists below.
 * 6. Run it:  node booktok-scraper.js
 *
 * Output: curated-dataset.json in this same folder. Upload that file
 * wherever you decide to host it \u2014 the app-side fetch logic is a separate
 * step once a hosting location is picked.
 */

const APIFY_TOKEN = process.env.APIFY_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!APIFY_TOKEN || !ANTHROPIC_API_KEY) {
  console.error('Missing APIFY_TOKEN or ANTHROPIC_API_KEY environment variable. See setup notes at the top of this file.');
  process.exit(1);
}

// ---- Configure what to scrape here ----
const HASHTAGS = [
  'booktok', 'bookstagram', 'bookrecommendations', 'romantasy', 'romanticfantasy', 'spicybooks', 'fantasyromancebooks', 'books', 'booksta', 'reverseharem', 'romantasybooktok', 'romantasybookrecs', 'romantasyreader', 'bookrecommendationsplease', 'romancebooks', 'romancebookstagrammer', 'romancebooksofinstagram', 'romancebookseries', 'romancebooksofig', 'romancebookstore', 'bookrecs', 'paranormalromance', 'paranormalromancebooks', 'scifiromance', 'scifiromancebooks', 'fantasybooks', 'fantasybookstagram', 'book', 'bookworm', 'booklover', 'bookish', 'bookaddict', 'booknerd', 'bibliophile', 'readersofinstagram', 'booksofinstagram', 'bookcommunity', 'bookreview', 'currentlyreading', 'tbr', 'whattoread', 'bookclub', 'darkromance', 'spicybooktok', 'smutbooks', 'bookhaul', 'bookishfeatures', 'whattoreadnext', 'tbrpile', 'romcombooks', 'romcomreads', 'fantasyromcom', 'fantasyreader', 'fantasybookrecs', 'dystopian', 'dystopianbooks', 'reader', 'booksthatmademecry', 'darkacademia', 'bookstagrambooks', 'bookishthoughts', 'mustreadbooks',
  // add more hashtags here, no # symbol
];

const ACCOUNTS = [
  // 'some_bookstagram_username',
  // add specific account usernames here, no @ symbol
];

// Same subreddits already used for the app's Reddit search links.
const SUBREDDITS = [
  'booktokreddit', 'darkromance', 'reverseharem', 'romancebooks', 'romantasy',
  'sciencefictionromance', 'spicyromancebooks', 'fantasyromance', 'paranormalromance',
  'bookrecommendations', 'bookstagram', 'booksuggestions', 'bookreviewers',
  'suggestmeabook', 'recommend_a_book', 'bookclub', 'findabook', 'pdfbooks',
  'books', 'bookdiscussions', 'whatsthatbook', 'booksthatfeellikethis',
  'thrillerbooks', 'weirdgirlliterature', 'readingsuggestions', 'mysterybooks',
];
const ENABLE_REDDIT = true; // set to false to skip Reddit and only scrape Instagram
const REDDIT_POSTS_PER_SUB = 10; // posts to pull per subreddit

const RESULTS_PER_TARGET = 10; // posts to pull per hashtag/account
const MAX_IMAGES_PER_POST = 3; // cap on images sent to Claude vision per post (cost control)
const CONCURRENCY = 5; // how many posts to process at once \u2014 higher is faster but risks API rate limits

// ---- Step 1: scrape via Apify's Instagram Scraper actor ----
async function scrapeInstagram() {
  const directUrls = [
    ...HASHTAGS.map(h => `https://www.instagram.com/explore/tags/${h}/`),
    ...ACCOUNTS.map(a => `https://www.instagram.com/${a}/`)
  ];

  if (!directUrls.length) {
    throw new Error('No hashtags or accounts configured \u2014 edit HASHTAGS/ACCOUNTS at the top of this file.');
  }

  console.log(`Scraping ${directUrls.length} target(s) via Apify...`);

  const res = await fetch(
    `https://api.apify.com/v2/acts/apify~instagram-scraper/run-sync-get-dataset-items?token=${APIFY_TOKEN}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        directUrls,
        resultsType: 'posts',
        resultsLimit: RESULTS_PER_TARGET
      })
    }
  );

  if (!res.ok) {
    throw new Error(`Apify request failed: ${res.status} ${await res.text()}`);
  }

  return res.json();
}

// ---- Step 1b: scrape via Apify's Reddit Scraper actor (harshmaur/reddit-scraper) ----
// Normalizes Reddit posts into the same { caption, displayUrl } shape the
// extraction step already expects, so both sources share one pipeline.
async function scrapeReddit() {
  if (!ENABLE_REDDIT) return [];
  if (!SUBREDDITS.length) return [];

  console.log(`Scraping ${SUBREDDITS.length} subreddit(s) via Apify...`);

  const res = await fetch(
    `https://api.apify.com/v2/acts/harshmaur~reddit-scraper/run-sync-get-dataset-items?token=${APIFY_TOKEN}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        startUrls: SUBREDDITS.map(s => ({ url: `https://www.reddit.com/r/${s}/` })),
        maxPostsCount: REDDIT_POSTS_PER_SUB,
        crawlCommentsPerPost: false,
        proxy: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] }
      })
    }
  );

  if (!res.ok) {
    throw new Error(`Apify Reddit request failed: ${res.status} ${await res.text()}`);
  }

  const posts = await res.json();
  return posts
    .filter(p => p.dataType === 'post' || p.title) // skip any non-post items in the results
    .map(p => ({
      caption: [p.title, p.body].filter(Boolean).join('\n\n'),
      displayUrl: null // this actor doesn't return post images; text-only for now
    }));
}

// ---- Step 2: ask Claude to extract a structured book mention, if any ----

// Collects candidate image URLs from a scraped post: the main image/video
// thumbnail, plus any carousel images. Apify's field names can vary slightly
// by actor version, so this checks a few likely spots defensively.
function collectImageUrls(post) {
  const urls = [];
  if (post.displayUrl) urls.push(post.displayUrl); // main image, or video cover frame
  if (Array.isArray(post.images)) urls.push(...post.images);
  if (Array.isArray(post.childPosts)) {
    for (const child of post.childPosts) {
      if (child.displayUrl) urls.push(child.displayUrl);
    }
  }
  return [...new Set(urls.filter(Boolean))];
}

// Downloads an image and base64-encodes it for the Messages API, which
// requires image bytes inline rather than a URL reference.
async function downloadAsBase64Image(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const contentType = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    if (!contentType.startsWith('image/')) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    return { media_type: contentType, data: buffer.toString('base64') };
  } catch (err) {
    return null; // a single bad image URL shouldn't kill the whole post
  }
}

const EXTRACTION_SYSTEM_PROMPT = 'You extract book mentions from social media posts \u2014 possibly a caption, possibly one or more images (a book cover, a shelfie, a screenshot with text, or a video\'s thumbnail frame), possibly both. Respond with ONLY a JSON object, no other text: {"isBookPost": boolean, "title": string or null, "author": string or null, "info": string or null}. Set isBookPost to true only if you can identify one specific, real book with reasonable confidence, from the text and/or what\'s visible in any images. "info" should be a short note (under 25 words) capturing what\'s notable \u2014 sentiment, trope, tone, a content note, anything useful for a book recommendation engine. If a cover is shown but you can\'t read the title clearly enough to be confident, set isBookPost to false rather than guessing. Never invent a title you are not reasonably confident about.';

let apiErrorCount = 0;
let parseErrorCount = 0;

// Small models frequently wrap JSON in a markdown code fence even when told
// not to. Strip that off before parsing, rather than treating it as a failure.
function stripCodeFence(text) {
  const trimmed = text.trim();

  // Look for a fenced block ANYWHERE in the text, not just one that spans the
  // entire response \u2014 the model sometimes adds an explanation after the
  // closing fence, which the old anchored version couldn't handle.
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) return fenceMatch[1];

  // No fence at all, but there may still be a JSON object surrounded by prose.
  // Grab from the first { to the last } as a reasonable fallback.
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return trimmed;
}

async function callExtraction(caption, images) {
  if (!caption.trim() && !images.length) return null;

  const content = [
    ...images.map(img => ({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } })),
    { type: 'text', text: caption || '(no caption \u2014 judge from the image alone)' }
  ];

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: EXTRACTION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content }]
    })
  });

  if (!response.ok) {
    apiErrorCount++;
    if (apiErrorCount <= 3) { // only print full detail for the first few, to avoid flooding the terminal
      const body = await response.text().catch(() => '(could not read error body)');
      console.error(`\n  \u26a0 Anthropic API error (status ${response.status}): ${body.slice(0, 300)}\n`);
    }
    return null;
  }
  const data = await response.json();
  const text = (data.content || []).map(b => b.text || '').join('');
  try {
    const parsed = JSON.parse(stripCodeFence(text));
    if (parsed.isBookPost && parsed.title) {
      return { title: parsed.title, author: parsed.author || undefined, info: parsed.info || '' };
    }
  } catch (err) {
    // Model didn't return valid JSON for this one \u2014 skip it rather than guess.
    parseErrorCount++;
    if (parseErrorCount <= 3) {
      console.error(`\n  \u26a0 Couldn't parse model response as JSON. Raw response: ${text.slice(0, 200)}\n`);
    }
  }
  return null;
}

async function extractBookMention(post) {
  const caption = (post.caption || '').slice(0, 1500); // keep each request small

  // Pass 1: text only \u2014 cheap, and often enough on its own.
  const textOnlyResult = await callExtraction(caption, []);
  if (textOnlyResult) return textOnlyResult;

  // Pass 2: caption alone didn't resolve it \u2014 escalate to image analysis.
  // For a video post, the only image available is its thumbnail frame.
  const imageUrls = collectImageUrls(post).slice(0, MAX_IMAGES_PER_POST);
  if (!imageUrls.length) return null;

  const downloaded = await Promise.all(imageUrls.map(downloadAsBase64Image));
  const images = downloaded.filter(Boolean);
  if (!images.length) return null;

  return callExtraction(caption, images);
}

// ---- Step 3: merge duplicate mentions of the same book into one entry ----
function dedupeEntries(entries) {
  const seen = new Map();
  for (const e of entries) {
    const key = (e.title + '|' + (e.author || '')).toLowerCase().trim();
    if (!seen.has(key)) {
      seen.set(key, { ...e });
    } else {
      const existing = seen.get(key);
      if (e.info && !existing.info.includes(e.info)) {
        existing.info = existing.info ? existing.info + ' Also: ' + e.info : e.info;
      }
    }
  }
  return Array.from(seen.values());
}

// Catches duplicates dedupeEntries can't: same title, but one copy has an
// author and another doesn't (so their title+author keys don't match).
// Prefers whichever copy has an author, merges the info text from both.
let titleCollisionCount = 0;

// Strips periods and collapses whitespace so "J.R.R. Tolkien" and
// "J. R. R. Tolkien" are recognized as the same author \u2014 pure formatting
// differences shouldn't cause a false "different book" classification.
function normalizeAuthorForCompare(author) {
  return (author || '').toLowerCase().replace(/[.\s]/g, '').trim();
}

// Very cheap edit-distance check, just for flagging \u2014 not for auto-merging.
// Two author strings that are close but not identical after normalization
// (like "Perri Torrani" vs "Perry Torani") are likely the same person with a
// typo, but merging automatically risks silently conflating two genuinely
// different authors, so this only surfaces them for a human to check.
function levenshteinWithinTwo(a, b) {
  if (Math.abs(a.length - b.length) > 2) return false;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length] <= 2 && dp[a.length][b.length] > 0;
}

let similarAuthorFlags = [];

function mergeByTitle(entries) {
  const byTitle = new Map();
  for (const e of entries) {
    const key = e.title.toLowerCase().trim();
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(e);
  }

  const merged = [];
  for (const group of byTitle.values()) {
    if (group.length === 1) {
      merged.push(group[0]);
      continue;
    }
    const distinctAuthors = new Set(group.filter(g => g.author).map(g => normalizeAuthorForCompare(g.author)));
    if (distinctAuthors.size > 1) {
      // Flag near-miss spellings for a human to check, without auto-merging.
      const authorList = Array.from(distinctAuthors);
      for (let i = 0; i < authorList.length; i++) {
        for (let j = i + 1; j < authorList.length; j++) {
          if (levenshteinWithinTwo(authorList[i], authorList[j])) {
            similarAuthorFlags.push(`"${group[0].title}": "${authorList[i]}" vs "${authorList[j]}"`);
          }
        }
      }
      // Same title, but genuinely different named authors \u2014 almost certainly
      // different books that happen to share a title (like "Good Neighbors",
      // which matches at least 5 unrelated real books). Keep them separate
      // rather than risk silently conflating two different books into one
      // wrong entry.
      titleCollisionCount++;
      merged.push(...group);
      continue;
    }
    // Safe to merge: every entry in the group agrees on the author, or is
    // just missing one.
    const withAuthor = group.find(g => g.author);
    const base = { ...(withAuthor || group[0]) };
    const infos = [];
    for (const g of group) {
      if (g.info && !infos.includes(g.info)) infos.push(g.info);
    }
    base.info = infos.join(' Also: ');
    merged.push(base);
  }
  return merged;
}

// Manually-verified corrections for specific entries that keep reappearing
// because the same source posts get re-scraped on every run. Add to this list
// whenever a flagged entry gets researched and confirmed \u2014 that verification
// then survives future runs instead of needing to be redone by hand each time.
// Match keys are lowercase, trimmed titles.
const KNOWN_CORRECTIONS = {
  remove: [
    'my pantone birth chart - book recs editions', // not a book, a social trend post
    'big boys of motham city series', // fake title; real books added separately below
  ],
  rename: {
    'howling on the bluff & monsters of moonfall isle': {
      title: 'Howling on the Bluff',
      author: 'Veronica Samek',
      info: 'Cozy, spicy monster romance (Monsters of Moonfall Isle series). Woman inherits a cottage on a hidden island and is rescued by a shapeshifting faehound.'
    },
  },
  // Real books recovered from entries that got removed above.
  add: [
    { title: 'Mail Order Minotaur', author: 'Lilith Stone', info: 'Motham City Monsters Book 1. Sweet, steamy monster romance \u2014 human tour guide falls for a minotaur, fated mates, low angst.' },
    { title: 'The Gargoyle Grinch', author: 'Lilith Stone', info: 'Motham City Monsters Book 2. Cozy Christmas monster romance between a grumpy gargoyle security guard and a warm-hearted human.' },
    { title: 'The Billionaire Orc', author: 'Lilith Stone', info: 'Motham City Monsters series. A wealthy orc and a human realtor, opposites-attract monster romance.' },
  ],
};

function applyKnownCorrections(entries) {
  const removeSet = new Set(KNOWN_CORRECTIONS.remove.map(t => t.toLowerCase().trim()));
  let corrected = entries
    .filter(e => !removeSet.has(e.title.toLowerCase().trim()))
    .map(e => {
      const fix = KNOWN_CORRECTIONS.rename[e.title.toLowerCase().trim()];
      return fix ? { ...e, ...fix } : e;
    });

  const existingKeys = new Set(corrected.map(e => (e.title + '|' + (e.author || '')).toLowerCase().trim()));
  for (const toAdd of KNOWN_CORRECTIONS.add) {
    const key = (toAdd.title + '|' + (toAdd.author || '')).toLowerCase().trim();
    if (!existingKeys.has(key)) {
      corrected.push(toAdd);
      existingKeys.add(key);
    }
  }
  return corrected;
}

// Flags (doesn't auto-fix) entries that look like they might bundle multiple
// books under one made-up collection title, or a garbled multi-book title \u2014
// the same red flags that caught "Big Boys of Motham City series" and
// "Howling on the Bluff & Monsters of Moonfall Isle" during manual review.
// This is deliberately conservative: it only prints a warning for a human to
// check, since actually verifying and fixing these needs real research, not
// a pattern match.
function flagSuspiciousEntries(entries) {
  const flagged = entries.filter(e => {
    const titleLooksBundled = /\s&\s|\bseries\b/i.test(e.title);
    const infoLooksBundled = /multiple books|including [A-Z]/i.test(e.info || '');
    return titleLooksBundled || infoLooksBundled;
  });
  if (flagged.length) {
    console.log(`\n\u26a0 ${flagged.length} entr${flagged.length === 1 ? 'y looks' : 'ies look'} like they might bundle multiple books, or use a made-up collection title \u2014 worth a manual look:`);
    flagged.forEach(e => console.log(`  - ${e.title}${e.author ? ' by ' + e.author : ''}`));
  }
  return flagged;
}

// Runs `worker` over `items` with at most `concurrency` running at once,
// instead of strictly one-at-a-time. `onProgress(completedCount, total, result)`
// fires after every single item finishes, regardless of outcome \u2014 this is what
// gives you a heartbeat even during long stretches with no matches.
async function processWithConcurrency(items, concurrency, worker, onProgress) {
  let nextIndex = 0;
  let completed = 0;
  const results = new Array(items.length);

  async function runWorker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      try {
        results[i] = await worker(items[i]);
      } catch (err) {
        results[i] = null; // one bad post shouldn't stop the whole batch
      }
      completed++;
      if (onProgress) onProgress(completed, items.length, results[i]);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, runWorker));
  return results;
}

async function main() {
  const fs = await import('fs');

  let existing = [];
  if (fs.existsSync('curated-dataset.json')) {
    try {
      existing = JSON.parse(fs.readFileSync('curated-dataset.json', 'utf8'));
      console.log(`Loaded ${existing.length} existing entries from curated-dataset.json.`);
    } catch (err) {
      console.error('\u26a0 Could not read existing curated-dataset.json, starting fresh:', err.message);
    }
  }

  const instagramPosts = await scrapeInstagram();
  const redditPosts = await scrapeReddit();
  const posts = [...instagramPosts, ...redditPosts];
  console.log(`Got ${instagramPosts.length} Instagram post(s) and ${redditPosts.length} Reddit post(s) \u2014 ${posts.length} total. Extracting book mentions (text first, images only when needed, ${CONCURRENCY} at a time)...`);

  const results = await processWithConcurrency(posts, CONCURRENCY, extractBookMention, (completed, total, entry) => {
    if (entry) {
      console.log(`  \u2713 [${completed}/${total}] ${entry.title}${entry.author ? ' by ' + entry.author : ''}`);
    } else if (completed % 25 === 0 || completed === total) {
      console.log(`  ... processed ${completed}/${total}`);
    }
  });
  const newEntries = results.filter(Boolean);
  console.log(`\nFound ${newEntries.length} book mention(s) in today's ${posts.length} posts.`);
  if (apiErrorCount > 0) {
    console.log(`\u26a0 ${apiErrorCount} Anthropic API call(s) failed \u2014 see warnings above for the actual error.`);
  }
  if (parseErrorCount > 0) {
    console.log(`\u26a0 ${parseErrorCount} response(s) couldn't be parsed as JSON \u2014 see warnings above.`);
  }

  // Combine with everything already in the dataset, then run the free (Tier 1)
  // cleanup: exact-match dedup, cross-match dedup for missing-author copies,
  // and flagging (not auto-fixing) entries that look like they might bundle
  // multiple books under one made-up title.
  const combined = dedupeEntries([...existing, ...newEntries]);
  const merged = applyKnownCorrections(mergeByTitle(combined));
  flagSuspiciousEntries(merged);
  if (titleCollisionCount > 0) {
    console.log(`\n\u26a0 ${titleCollisionCount} title(s) matched an existing entry but had a different named author \u2014 kept as separate entries instead of merging, since they're likely different books.`);
  }
  if (similarAuthorFlags.length > 0) {
    console.log(`\n\u26a0 ${similarAuthorFlags.length} case(s) of very similar (but not identical) author spellings on the same title \u2014 possibly the same person with a typo, worth a manual look rather than auto-merged:`);
    similarAuthorFlags.forEach(f => console.log(`  - ${f}`));
  }

  console.log(`\nDataset now has ${merged.length} unique book mention(s) total (was ${existing.length}, added up to ${newEntries.length} today, after merging).`);

  fs.writeFileSync('curated-dataset.json', JSON.stringify(merged, null, 2));
  console.log('Wrote curated-dataset.json \u2014 accumulated with prior runs, not overwritten.');
}

main().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
