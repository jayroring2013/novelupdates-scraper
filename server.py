import time
import re
from flask import Flask, jsonify, request
from flask_cors import CORS
from bs4 import BeautifulSoup
import cloudscraper
from cachetools import TTLCache

app = Flask(__name__)
CORS(app, origins="*")

# Cache for 10 minutes, max 200 entries
cache = TTLCache(maxsize=200, ttl=600)

# Cloudscraper instance — same as your working script
scraper = cloudscraper.create_scraper(delay=5)

GENRE_MAP = {
    "action": 8, "adult": 280, "adventure": 13, "comedy": 17,
    "drama": 9, "ecchi": 292, "fantasy": 25, "gender-bender": 168,
    "harem": 3, "historical": 18, "horror": 27, "josei": 6,
    "martial-arts": 158, "mature": 4, "mecha": 10, "mystery": 245,
    "psychological": 31, "romance": 26, "school-life": 93, "sci-fi": 11,
    "seinen": 7, "shoujo": 2, "shoujo-ai": 196, "shounen": 1,
    "shounen-ai": 197, "slice-of-life": 36, "smut": 281, "sports": 33,
    "supernatural": 38, "tragedy": 32, "wuxia": 479, "xianxia": 480,
    "xuanhuan": 481, "yaoi": 560, "yuri": 80,
}

SORT_MAP = {
    "latest":   "sdate",
    "rating":   "rating",
    "readers":  "readers",
    "chapters": "chapters",
}

def scrape_list(sort="latest", genre=None, page=1, search=None):
    """Scrape the series finder list page — based on your working script."""

    if search:
        url = "https://www.novelupdates.com/"
        params = {
            "s": search,
            "post_type": "seriesplans",
            "langs[]": "1",
        }
    else:
        url = "https://www.novelupdates.com/series-finder/"
        params = {
            "sf":    "1",
            "sort":  SORT_MAP.get(sort, "sdate"),
            "order": "desc",
            "pg":    page,
            "nt":    "2443",   # Novel type — from your script
            "org":   "496",    # Japanese origin — from your script
        }
        if genre and genre in GENRE_MAP:
            params["genre"] = GENRE_MAP[genre]

    print(f"Fetching: {url} params={params}")
    response = scraper.get(url, params=params)
    print(f"Status: {response.status_code}")

    soup = BeautifulSoup(response.content, "html.parser")

    # Check for Cloudflare block
    title = soup.find("title")
    page_title = title.get_text() if title else ""
    print(f"Page title: {page_title}")
    if "just a moment" in page_title.lower() or "cloudflare" in page_title.lower():
        raise Exception("Cloudflare challenge hit")

    novels = []
    entries = soup.find_all("div", class_="search_main_box_nu")
    print(f"Found {len(entries)} entries")

    for entry in entries:
        # Title + link — directly from your script
        title_el = entry.find("div", class_="search_title")
        a_tag    = title_el.find("a") if title_el else None
        title    = a_tag.get_text(strip=True) if a_tag else ""
        link     = a_tag["href"] if a_tag else ""
        slug     = link.replace("https://www.novelupdates.com/series/", "").rstrip("/")

        # Cover image
        img_div = entry.find("div", class_="search_img_nu")
        img_tag = img_div.find("img") if img_div else None
        image   = (img_tag.get("src") or img_tag.get("data-src") or "") if img_tag else ""

        # Rating + votes
        ratings_div  = entry.find("div", class_="search_ratings")
        ratings_text = ratings_div.get_text() if ratings_div else ""
        rating_match = re.search(r"([\d.]+)\s*\(", ratings_text)
        votes_match  = re.search(r"\((\d[\d,]*)", ratings_text)
        rating = float(rating_match.group(1)) if rating_match else None
        votes  = int(votes_match.group(1).replace(",", "")) if votes_match else 0

        # Description — same selector as your script
        body_div = entry.find("div", class_="search_body_nu")
        desc     = " ".join(body_div.get_text().split()) if body_div else ""

        # Genres — same as your script's #seriesgenre approach
        genres = [a.get_text(strip=True) for a in entry.select(".genre-item a")]

        # Stats
        score_div  = entry.find("div", class_="search_score_nu")
        score_text = score_div.get_text() if score_div else ""
        chap_match = re.search(r"([\d,]+)\s+Releases", score_text, re.I)
        read_match = re.search(r"([\d,]+)\s+Readers", score_text, re.I)
        chapters = chap_match.group(1).replace(",", "") if chap_match else None
        readers  = read_match.group(1).replace(",", "") if read_match else None

        # Status
        ss_tag = entry.find("span", class_="ss")
        status = ss_tag.get_text(strip=True) if ss_tag else "Ongoing"

        if title:
            novels.append({
                "title":    title,
                "link":     link,
                "slug":     slug,
                "image":    image,
                "rating":   rating,
                "votes":    votes,
                "desc":     desc,
                "genres":   genres,
                "chapters": chapters,
                "readers":  readers,
                "status":   status,
            })

    # Pagination
    has_next = bool(soup.select(".digg_pagination a.next_page"))

    return novels, has_next


def scrape_detail(slug):
    """Scrape individual novel page — based on your scrape_novel_details()."""
    url = f"https://www.novelupdates.com/series/{slug}/"
    print(f"Fetching detail: {url}")
    response = scraper.get(url)
    soup = BeautifulSoup(response.content, "html.parser")

    def text(selector):
        el = soup.select_one(selector)
        return el.get_text(strip=True) if el else ""

    def lst(selector):
        return [el.get_text(strip=True) for el in soup.select(selector)]

    # Use exact selectors from your working Python script
    title       = text(".seriestitlenu")
    description = "\n".join(p.get_text(strip=True) for p in soup.select("#editdescription p"))
    genres      = lst("#seriesgenre a")
    rating_text = text(".uvotes")
    rating_match = re.search(r"([\d.]+)", rating_text)
    rating      = float(rating_match.group(1)) if rating_match else None

    try:
        status = "\n".join(soup.select_one("#editstatus").stripped_strings)
    except:
        status = ""

    try:
        assoc = "\n".join(soup.select_one("#editassociated").stripped_strings)
    except:
        assoc = ""

    # Cover image
    img = soup.select_one(".seriesimg img")
    image = img.get("src", "") if img else ""

    # Stats
    chapters = text(".wr-stats .number-chapters") or text("#edittocleft b")
    readers  = text(".wr-stats .userrate")

    # Author
    author = ", ".join(lst("#showauthors a"))

    # Year
    year = text("#edityear")

    mal_link = ""
    for a in soup.select(".seriesmulti a"):
        if "myanimelist" in a.get("href", ""):
            mal_link = a["href"]
            break

    return {
        "title":       title,
        "image":       image,
        "rating":      rating,
        "description": description,
        "genres":      genres,
        "status":      status,
        "assocNames":  assoc,
        "author":      author,
        "chapters":    chapters,
        "readers":     readers,
        "year":        year,
        "link":        f"https://www.novelupdates.com/series/{slug}/",
        "malLink":     mal_link,
    }


# ── Routes ────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return jsonify({
        "status":  "ok",
        "message": "NovelUpdates scraper (Python + cloudscraper)",
        "endpoints": {
            "list":   "/api/novels?sort=latest|rating|readers|chapters&genre=action|fantasy|...&page=1&search=...",
            "detail": "/api/novel/<slug>",
            "debug":  "/api/debug",
        }
    })


@app.route("/api/novels")
def get_novels():
    try:
        sort   = request.args.get("sort",   "latest")
        genre  = request.args.get("genre",  None)
        page   = int(request.args.get("page", 1))
        search = request.args.get("search", None)

        cache_key = f"novels_{sort}_{genre}_{page}_{search}"
        if cache_key in cache:
            return jsonify({**cache[cache_key], "cached": True})

        novels, has_next = scrape_list(sort=sort, genre=genre, page=page, search=search)

        if not novels:
            return jsonify({"error": "No novels parsed — selectors may have changed"}), 500

        result = {"novels": novels, "hasMore": has_next, "page": page, "cached": False}
        cache[cache_key] = result
        return jsonify(result)

    except Exception as e:
        print(f"Error: {e}")
        return jsonify({"error": "Scrape failed", "detail": str(e)}), 500


@app.route("/api/novel/<slug>")
def get_novel(slug):
    try:
        cache_key = f"novel_{slug}"
        if cache_key in cache:
            return jsonify({**cache[cache_key], "cached": True})

        novel = scrape_detail(slug)
        cache[cache_key] = novel
        return jsonify({**novel, "cached": False})

    except Exception as e:
        print(f"Error: {e}")
        return jsonify({"error": "Detail scrape failed", "detail": str(e)}), 500


@app.route("/api/debug")
def debug():
    try:
        url      = "https://www.novelupdates.com/series-finder/?sf=1&org=496&nt=2443&sort=sdate&order=desc"
        response = scraper.get(url)
        soup     = BeautifulSoup(response.content, "html.parser")
        return jsonify({
            "status":         response.status_code,
            "title":          soup.find("title").get_text() if soup.find("title") else "",
            "containerCount": len(soup.find_all("div", class_="search_main_box_nu")),
            "firstTitle":     soup.find("div", class_="search_title").find("a").get_text() if soup.find("div", class_="search_title") else "",
            "htmlSnippet":    str(soup)[:800],
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    import os
    port = int(os.environ.get("PORT", 3000))
    app.run(host="0.0.0.0", port=port)
