import { Router } from "express";
import https from "https";

export const newsRouter = Router();

/* ── country code → language/locale for Google News ── */
const COUNTRY_LOCALE: Record<string, { hl: string; gl: string; ceid: string }> = {
  DE: { hl: "de", gl: "DE", ceid: "DE:de" },
  AT: { hl: "de", gl: "AT", ceid: "AT:de" },
  CH: { hl: "de", gl: "CH", ceid: "CH:de" },
  NL: { hl: "nl", gl: "NL", ceid: "NL:nl" },
  FR: { hl: "fr", gl: "FR", ceid: "FR:fr" },
  IT: { hl: "it", gl: "IT", ceid: "IT:it" },
  ES: { hl: "es", gl: "ES", ceid: "ES:es" },
  GB: { hl: "en", gl: "GB", ceid: "GB:en" },
  US: { hl: "en", gl: "US", ceid: "US:en" },
  PL: { hl: "pl", gl: "PL", ceid: "PL:pl" },
  CZ: { hl: "cs", gl: "CZ", ceid: "CZ:cs" },
  HU: { hl: "hu", gl: "HU", ceid: "HU:hu" },
  SE: { hl: "sv", gl: "SE", ceid: "SE:sv" },
  NO: { hl: "no", gl: "NO", ceid: "NO:no" },
  DK: { hl: "da", gl: "DK", ceid: "DK:da" },
  PT: { hl: "pt", gl: "PT", ceid: "PT:pt" },
  RO: { hl: "ro", gl: "RO", ceid: "RO:ro" },
  GR: { hl: "el", gl: "GR", ceid: "GR:el" },
  TR: { hl: "tr", gl: "TR", ceid: "TR:tr" },
  JP: { hl: "ja", gl: "JP", ceid: "JP:ja" },
  BR: { hl: "pt", gl: "BR", ceid: "BR:pt" },
};

const DEFAULT_LOCALE = { hl: "en", gl: "US", ceid: "US:en" };

/* ── in-memory cache (10 min TTL) ── */
const cache = new Map<string, { data: unknown; ts: number }>();
const CACHE_TTL = 10 * 60 * 1000;

function getCached(key: string): unknown | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

/* ── https.get helper ── */
function httpsGet(url: string, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { timeout: timeoutMs, headers: { "User-Agent": "Mozilla/5.0" } },
      (res) => {
        // Follow redirects
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          httpsGet(res.headers.location, timeoutMs).then(resolve, reject);
          return;
        }
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve(body));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`timeout after ${timeoutMs}ms`));
    });
    req.on("error", reject);
  });
}

/* ── parse RSS XML items ── */
function parseRssItems(xml: string): Array<{ title: string; url: string; source: string; dateTime: string }> {
  const items: Array<{ title: string; url: string; source: string; dateTime: string }> = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = block.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() || "";
    const link = block.match(/<link\s*\/?>([\s\S]*?)<(?:\/link|link)/)?.[1]?.trim()
      || block.match(/<link[^>]*href="([^"]*)"[^>]*\/?>/)?.[1]?.trim() || "";
    const source = block.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1]?.trim() || "";
    const pubDate = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim() || "";

    if (!title) continue;

    // Google News titles often end with " - Source Name" — strip it if we have source
    const cleanTitle = source && title.endsWith(` - ${source}`)
      ? title.slice(0, -source.length - 3)
      : title;

    items.push({
      title: decodeXmlEntities(cleanTitle),
      url: decodeXmlEntities(link),
      source: decodeXmlEntities(source),
      dateTime: pubDate,
    });
  }
  return items;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

/* ── translate titles to English (free Google Translate endpoint) ── */
async function translateToEnglish(texts: string[], sourceLang: string): Promise<string[]> {
  if (sourceLang === "en" || texts.length === 0) return texts;

  // Batch all titles into one request using newline separator
  const joined = texts.join("\n");
  const params = new URLSearchParams({
    client: "gtx",
    sl: sourceLang,
    tl: "en",
    dt: "t",
    q: joined,
  });
  const url = `https://translate.googleapis.com/translate_a/single?${params}`;

  try {
    const body = await httpsGet(url, 8000);
    const data = JSON.parse(body);
    // Response format: [[["translated\n...", "original\n...", ...], ...], ...]
    const translated = (data[0] as Array<[string]>)
      .map((seg) => seg[0])
      .join("");
    const lines = translated.split("\n");
    // If translation returned same number of lines, map 1:1; otherwise fall back
    return lines.length === texts.length ? lines : texts;
  } catch (err) {
    console.warn("[news] Translation failed, returning originals:", err);
    return texts;
  }
}

/* ── fetch news for a single query ── */
async function fetchGoogleNews(
  query: string,
  locale: { hl: string; gl: string; ceid: string },
  after?: string,
  before?: string,
): Promise<Array<{ title: string; url: string; source: string; dateTime: string }>> {
  // Google News supports after:YYYY-MM-DD and before:YYYY-MM-DD in query
  let q = query;
  if (after) q += ` after:${after}`;
  if (before) q += ` before:${before}`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${locale.hl}&gl=${locale.gl}&ceid=${locale.ceid}`;
  console.log(`[news] Google News RSS: ${url}`);
  const xml = await httpsGet(url);
  return parseRssItems(xml);
}

/**
 * GET /api/news?city=...&country=...&zone=...
 *
 * Uses Google News RSS for fast, free, reliable regional news.
 * - city: location name (e.g. "Korneuburg")
 * - country: ISO 2-letter code for locale (e.g. "AT" → German, Austria)
 * - zone: optional zone name — if provided, zone results appear first
 */
newsRouter.get("/news", async (req, res) => {
  const city = (req.query.city as string || "").trim();
  const country = (req.query.country as string || "").trim().toUpperCase();
  const zone = (req.query.zone as string || "").trim();
  const from = (req.query.from as string || "").trim(); // YYYY-MM-DD
  const to = (req.query.to as string || "").trim();     // YYYY-MM-DD

  if (!city && !zone) {
    res.json({ articles: [] });
    return;
  }

  const after = from || undefined;
  const before = to || undefined;

  const cacheKey = `${city}_${country}_${zone}_${after}_${before}`;
  const cached = getCached(cacheKey);
  if (cached) {
    res.json(cached);
    return;
  }

  const locale = COUNTRY_LOCALE[country] || DEFAULT_LOCALE;

  try {
    let articles: Array<{ title: string; url: string; source: string; dateTime: string }>;

    if (zone) {
      const [zoneArticles, cityArticles] = await Promise.all([
        fetchGoogleNews(zone, locale, after, before).catch(() => []),
        fetchGoogleNews(city, locale, after, before).catch(() => []),
      ]);
      // Deduplicate by URL, zone results first
      const seen = new Set<string>();
      articles = [];
      for (const a of [...zoneArticles, ...cityArticles]) {
        if (!seen.has(a.url)) { seen.add(a.url); articles.push(a); }
      }
      articles = articles.slice(0, 50);
    } else {
      articles = (await fetchGoogleNews(city, locale, after, before)).slice(0, 20);
    }

    // Translate titles to English if source language isn't English
    const origTitles = articles.map((a) => a.title);
    const translated = await translateToEnglish(origTitles, locale.hl);
    const enriched = articles.map((a, i) => ({ ...a, title: translated[i] }));

    const result = { articles: enriched };
    cache.set(cacheKey, { data: result, ts: Date.now() });
    res.json(result);
  } catch (err) {
    console.error("[news] Google News error:", err);
    res.json({ articles: [] });
  }
});

/**
 * GET /api/news/safenow?from=...&to=...
 *
 * Global SafeNow news — not tied to a specific hotspot.
 */
newsRouter.get("/news/safenow", async (_req, res) => {
  const year = new Date().getFullYear();
  const after = `${year}-01-01`;
  const before = new Date().toISOString().slice(0, 10);

  const cacheKey = `safenow_${after}_${before}`;
  const hit = getCached(cacheKey);
  if (hit) { res.json(hit); return; }

  try {
    // Search across all configured locales for global coverage
    const locales = Object.values(COUNTRY_LOCALE);
    const queries = ['"SafeNow"', '"Tilman Rumland"'];
    const results = await Promise.all(
      queries.flatMap((q) => locales.map((loc) => fetchGoogleNews(q, loc, after, before).catch(() => []))),
    );

    const seen = new Set<string>();
    const articles: Array<{ title: string; url: string; source: string; dateTime: string }> = [];
    for (const a of results.flat()) {
      if (!seen.has(a.url)) { seen.add(a.url); articles.push(a); }
    }

    // Translate non-English titles
    const origTitles = articles.map((a) => a.title);
    const translated = await translateToEnglish(origTitles, "de");
    const enriched = articles.slice(0, 50).map((a, i) => ({ ...a, title: translated[i] }));

    const result = { articles: enriched };
    cache.set(cacheKey, { data: result, ts: Date.now() });
    res.json(result);
  } catch (err) {
    console.error("[news] SafeNow news error:", err);
    res.json({ articles: [] });
  }
});
