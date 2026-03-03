const express   = require("express");
const cheerio   = require("cheerio");
const cors      = require("cors");
const NodeCache = require("node-cache");
const puppeteer = require("puppeteer");

const app   = express();
const cache = new NodeCache({ stdTTL: 600 });

app.use(cors({ origin: "*", methods: ["GET"] }));

const GENRE_MAP = {
  "action": 8, "adult": 280, "adventure": 13, "comedy": 17,
  "drama": 9, "ecchi": 292, "fantasy": 25, "gender-bender": 168,
  "harem": 3, "historical": 18, "horror": 27, "josei": 6,
  "martial-arts": 158, "mature": 4, "mecha": 10, "mystery": 245,
  "psychological": 31, "romance": 26, "school-life": 93, "sci-fi": 11,
  "seinen": 7, "shoujo": 2, "shoujo-ai": 196, "shounen": 1,
  "shounen-ai": 197, "slice-of-life": 36, "smut": 281, "sports": 33,
  "supernatural": 38, "tragedy": 32, "wuxia": 479, "xianxia": 480,
  "xuanhuan": 481, "yaoi": 560, "yuri": 80,
};

// ── Launch a single shared browser instance ──────────────────────────
let browser = null;
async function getBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
        "--disable-gpu",
      ],
    });
    console.log("Browser launched");
  }
  return browser;
}

// ── Fetch a URL using a real headless Chrome tab ─────────────────────
async function fetchWithPuppeteer(url) {
  const br   = await getBrowser();
  const page = await br.newPage();

  try {
    // Disguise as a real browser
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    });

    // Block images/fonts to speed things up
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (["image", "font", "stylesheet", "media"].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    console.log("Loading:", url);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Wait for novel cards to appear
    await page.waitForSelector(".search_main_box_nu, .w-blog-entry", { timeout: 10000 })
      .catch(() => console.log("Selector timeout — parsing whatever loaded"));

    const html = await page.content();
    return html;
  } finally {
    await page.close();
  }
}

// ── Parse the HTML with Cheerio ──────────────────────────────────────
function parsePage($) {
  const novels = [];

  $(".search_main_box_nu").each((i, el) => {
    const $el = $(el);

    const titleEl = $el.find(".search_title a").first();
    const title   = titleEl.text().trim();
    const link    = titleEl.attr("href") || "";
    const slug    = link.replace("https://www.novelupdates.com/series/", "").replace(/\/$/, "");

    const image = $el.find(".search_img_nu img").attr("src")
               || $el.find(".search_img_nu img").attr("data-src")
               || "";

    const ratingText = $el.find(".search_ratings .nuicon-star-rate-o").parent().text().trim();
    const rating     = parseFloat(ratingText) || null;
    const votesMatch = $el.text().match(/\((\d[\d,]*)\s*x\)/);
    const votes      = parseInt((votesMatch?.[1] || "0").replace(/,/g, ""));

    const desc = $el.find(".search_body_nu").text().replace(/\s+/g, " ").trim();

    const genres = [];
    $el.find(".genre-item a").each((_, g) => genres.push($(g).text().trim()));

    const scoreText = $el.find(".search_score_nu").text();
    const chapters  = scoreText.match(/(\d[\d,]*)\s+Releases/i)?.[1]?.replace(/,/g, "") || null;
    const readers   = scoreText.match(/([\d,]+)\s+Readers/i)?.[1]?.replace(/,/g, "") || null;
    const status    = scoreText.includes("Complete") ? "Complete" : "Ongoing";

    if (title) novels.push({ title, link, slug, image, rating, votes, desc, genres, chapters, readers, status });
  });

  const hasNext = $(".digg_pagination a.next_page").length > 0;
  return { novels, hasNext };
}

// ── GET /api/novels ──────────────────────────────────────────────────
app.get("/api/novels", async (req, res) => {
  try {
    const { sort = "latest", genre = null, page = 1, search = null } = req.query;
    const pg = parseInt(page) || 1;

    let url = "https://www.novelupdates.com/series-finder/?sf=1&langs=1";
    if (search?.trim()) {
      url = `https://www.novelupdates.com/?s=${encodeURIComponent(search.trim())}&post_type=seriesplans&langs%5B%5D=1`;
    } else {
      const sortMap = { latest: "sdate", rating: "rating", readers: "readers", chapters: "chapters" };
      url += `&sort=${sortMap[sort] || "sdate"}&order=desc`;
      if (genre && GENRE_MAP[genre]) url += `&genre=${GENRE_MAP[genre]}`;
      if (pg > 1) url += `&pg=${pg}`;
    }

    const cacheKey = `novels_${url}`;
    const cached   = cache.get(cacheKey);
    if (cached) return res.json({ ...cached, cached: true });

    const html = await fetchWithPuppeteer(url);
    const $    = cheerio.load(html);

    // Detect Cloudflare block
    if ($("title").text().toLowerCase().includes("just a moment")) {
      return res.status(503).json({ error: "Cloudflare challenge — retry in a few seconds" });
    }

    const { novels, hasNext } = parsePage($);

    if (novels.length === 0) {
      return res.status(500).json({
        error: "No novels parsed",
        pageTitle: $("title").text(),
        htmlSnippet: html.slice(0, 800),
      });
    }

    const response = { novels, hasMore: hasNext, page: pg, cached: false };
    cache.set(cacheKey, response);
    res.json(response);

  } catch (err) {
    console.error(err);
    // Reset browser on crash so next request gets a fresh one
    if (browser) { await browser.close().catch(() => {}); browser = null; }
    res.status(500).json({ error: "Scrape failed", detail: err.message });
  }
});

// ── GET /api/debug ───────────────────────────────────────────────────
app.get("/api/debug", async (req, res) => {
  try {
    const url  = "https://www.novelupdates.com/series-finder/?sf=1&langs=1&sort=sdate&order=desc";
    const html = await fetchWithPuppeteer(url);
    const $    = cheerio.load(html);
    res.json({
      title:          $("title").text(),
      containerCount: $(".search_main_box_nu").length,
      firstTitle:     $(".search_title a").first().text(),
      htmlSnippet:    html.slice(0, 1000),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ─────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "ok", message: "NovelUpdates scraper running (Puppeteer)" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server on port ${PORT}`);
  // Pre-warm the browser on startup
  await getBrowser().catch(console.error);
});
