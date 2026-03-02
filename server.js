const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");
const NodeCache = require("node-cache");

const app = express();
const cache = new NodeCache({ stdTTL: 600 });

app.use(cors({
  origin: ["https://jayroring2013.github.io", "http://localhost:5500", "http://127.0.0.1:5500"],
  methods: ["GET"],
}));

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
};

const GENRE_MAP = {
  action: 8, adventure: 13, comedy: 17, drama: 9, fantasy: 25,
  horror: 27, mystery: 245, romance: 26, "sci-fi": 11,
  "slice-of-life": 37, supernatural: 38, psychological: 31,
  tragedy: 32, historical: 18,
};

async function scrapePage(url) {
  const { data } = await axios.get(url, { headers: HEADERS, timeout: 15000 });
  const $ = cheerio.load(data);
  const novels = [];

  $(".search_main_box_nu").each((i, el) => {
    const $el = $(el);
    const title  = $el.find(".search_title a").first().text().trim();
    const link   = $el.find(".search_title a").first().attr("href") || "";
    const slug   = link.replace("https://www.novelupdates.com/series/", "").replace(/\/$/, "");
    const image  = $el.find(".search_img_nu img").attr("src") || $el.find(".search_img_nu img").attr("data-src") || "";
    const ratingText = $el.find(".search_ratings .userrate").text().trim();
    const rating = parseFloat(ratingText) || null;
    const votes  = parseInt($el.find(".search_ratings").text().match(/\((\d+)/)?.[1] || "0");
    const desc   = $el.find(".search_body_nu").text().replace(/\s+/g, " ").trim();
    const genres = [];
    $el.find(".genre-item a").each((_, g) => genres.push($(g).text().trim()));
    const scoreText = $el.find(".search_score_nu").text();
    const chapters = scoreText.match(/(\d+)\s+Releases/)?.[1] || null;
    const readers  = scoreText.match(/([\d,]+)\s+Readers/)?.[1]?.replace(/,/g, "") || null;
    const status   = $el.find(".ss").text().trim() || "Ongoing";

    if (title) novels.push({ title, link, slug, image, rating, votes, desc, genres, chapters, readers, status });
  });

  const hasNext = $(".digg_pagination a.next_page").length > 0;
  return { novels, hasNext };
}

app.get("/api/novels", async (req, res) => {
  try {
    const { sort = "sdate", genre = null, page = 1, search = null } = req.query;
    const pg = parseInt(page);

    let url = "https://www.novelupdates.com/series-finder/?sf=1&langs=1";
    if (search) {
      url = `https://www.novelupdates.com/?s=${encodeURIComponent(search)}&post_type=seriesplans&langs%5B%5D=1`;
    } else {
      const sortMap = { latest: "sdate", rating: "rating", readers: "readers", chapters: "chapters" };
      url += `&sort=${sortMap[sort] || "sdate"}&order=desc`;
      if (genre && GENRE_MAP[genre]) url += `&genre=${GENRE_MAP[genre]}`;
      if (pg > 1) url += `&pg=${pg}`;
    }

    const cacheKey = `novels_${url}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json({ ...cached, cached: true });

    const result = await scrapePage(url);
    const response = { novels: result.novels, hasMore: result.hasNext, page: pg, cached: false };
    cache.set(cacheKey, response);
    res.json(response);
  } catch (err) {
    res.status(500).json({ error: "Scrape failed", detail: err.message });
  }
});

app.get("/", (req, res) => res.json({ status: "ok", message: "NovelUpdates API running" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
