const express   = require("express");
const axios     = require("axios");
const cheerio   = require("cheerio");
const cors      = require("cors");
const NodeCache = require("node-cache");

const app   = express();
const cache = new NodeCache({ stdTTL: 600 });

app.use(cors({
  origin: "*", // open during dev — restrict to your domain later
  methods: ["GET"],
}));

// Rotate through several realistic User-Agents
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
];
const randomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

async function fetchPage(url) {
  const { data, status } = await axios.get(url, {
    timeout: 20000,
    headers: {
      "User-Agent":      randomUA(),
      "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      "Cache-Control":   "no-cache",
      "Pragma":          "no-cache",
      "Referer":         "https://www.novelupdates.com/",
      "DNT":             "1",
      "Connection":      "keep-alive",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest":  "document",
      "Sec-Fetch-Mode":  "navigate",
      "Sec-Fetch-Site":  "same-origin",
    },
  });
  return { data, status };
}

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

function parsePage($) {
  const novels = [];

  // Try multiple possible container selectors
  const containers = $(".search_main_box_nu, .w-blog-entry-inner, .bsl-nu");

  console.log(`Found ${containers.length} novel containers`);

  containers.each((i, el) => {
    const $el = $(el);

    // Title — try multiple selectors
    const titleEl = $el.find(".search_title a, .w-blog-entry-title a, h2 a").first();
    const title   = titleEl.text().trim();
    const link    = titleEl.attr("href") || "";
    const slug    = link.replace("https://www.novelupdates.com/series/", "").replace(/\/$/, "");

    // Cover image
    const image = $el.find("img").first().attr("src")
               || $el.find("img").first().attr("data-src")
               || "";

    // Rating
    const ratingText = $el.find(".search_ratings .userrate, .nuicon-star").first().text().trim();
    const rating     = parseFloat(ratingText) || null;
    const votesMatch = $el.find(".search_ratings").text().match(/\((\d[\d,]*)/);
    const votes      = parseInt((votesMatch?.[1] || "0").replace(/,/g, ""));

    // Description
    const desc = $el.find(".search_body_nu, .w-blog-entry-excerpt").text()
                     .replace(/\s+/g, " ").trim();

    // Genres
    const genres = [];
    $el.find(".genre-item a, .w-blog-entry-genre a").each((_, g) => genres.push($(g).text().trim()));

    // Stats
    const scoreText = $el.find(".search_score_nu, .w-blog-entry-meta").text();
    const chapters  = scoreText.match(/(\d[\d,]*)\s+(?:Releases|Chapters)/i)?.[1]?.replace(/,/g, "") || null;
    const readers   = scoreText.match(/([\d,]+)\s+Readers/i)?.[1]?.replace(/,/g, "") || null;
    const status    = $el.find(".ss, .search_score_nu").text().includes("Complete") ? "Complete" : "Ongoing";

    if (title) {
      novels.push({ title, link, slug, image, rating, votes, desc, genres, chapters, readers, status });
    }
  });

  const hasNext = $(".digg_pagination a.next_page, a.next_page").length > 0;
  return { novels, hasNext };
}

// ── /api/novels ──────────────────────────────────────────────────────
app.get("/api/novels", async (req, res) => {
  try {
    const { sort = "sdate", genre = null, page = 1, search = null } = req.query;
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

    console.log("Fetching:", url);
    const { data, status } = await fetchPage(url);
    console.log("HTTP status:", status);

    const $ = cheerio.load(data);

    // Cloudflare / bot check detection
    const pageTitle = $("title").text();
    console.log("Page title:", pageTitle);
    if (pageTitle.toLowerCase().includes("just a moment") || pageTitle.toLowerCase().includes("cloudflare")) {
      return res.status(503).json({ error: "Blocked by Cloudflare", detail: "NovelUpdates returned a bot-check page. Try again in a few seconds." });
    }

    const { novels, hasNext } = parsePage($);

    if (novels.length === 0) {
      // Return raw snippet for debugging
      console.log("No novels found. HTML snippet:", data.slice(0, 2000));
      return res.status(500).json({
        error: "No novels parsed — HTML structure may have changed",
        htmlSnippet: data.slice(0, 1000),
      });
    }

    const response = { novels, hasMore: hasNext, page: pg, total: novels.length, cached: false };
    cache.set(cacheKey, response);
    res.json(response);

  } catch (err) {
    console.error("Error:", err.message);
    res.status(500).json({ error: "Scrape failed", detail: err.message });
  }
});

// ── /api/debug — shows raw HTML to help diagnose selector issues ──────
app.get("/api/debug", async (req, res) => {
  try {
    const url = "https://www.novelupdates.com/series-finder/?sf=1&langs=1&sort=sdate&order=desc";
    const { data } = await fetchPage(url);
    const $ = cheerio.load(data);
    res.json({
      title:        $("title").text(),
      bodyClasses:  $("body").attr("class"),
      firstDivs:    $("div").slice(0, 5).map((i, el) => $(el).attr("class")).get(),
      containerCount: $(".search_main_box_nu").length,
      html500:      data.slice(0, 500),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Health ────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({
  status: "ok",
  endpoints: {
    list:  "/api/novels?sort=latest|rating|readers|chapters&genre=action|fantasy|...&page=1&search=...",
    debug: "/api/debug",
  },
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
