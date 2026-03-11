"""
trending_scraper.py — Fetch trending songs from TikTok Creative Center.

Scrapes the SSR-rendered __NEXT_DATA__ from the TikTok Creative Center
trending music page. Returns top trending songs (title + artist).
"""

import re
import json
import time
import requests

_TIKTOK_URL = (
    "https://ads.tiktok.com/business/creativecenter"
    "/inspiration/popular/music/pc/en"
)

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "en-US,en;q=0.9",
}

_NEXT_DATA_RE = re.compile(
    r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>'
)

# Cache: avoid hitting TikTok on every request
_cache = {"songs": [], "fetched_at": 0}
_CACHE_TTL = 3600  # 1 hour


def get_tiktok_trending():
    """Return a list of trending songs from TikTok Creative Center.

    Each entry is a dict with 'name' and 'artist' keys.
    Results are cached for 1 hour.
    """
    now = time.time()
    if _cache["songs"] and (now - _cache["fetched_at"]) < _CACHE_TTL:
        return _cache["songs"]

    songs = []
    try:
        resp = requests.get(_TIKTOK_URL, headers=_HEADERS, timeout=12)
        resp.raise_for_status()

        match = _NEXT_DATA_RE.search(resp.text)
        if not match:
            print("TikTok scraper: __NEXT_DATA__ not found in page")
            return songs

        data = json.loads(match.group(1))
        sound_list = (
            data.get("props", {})
            .get("pageProps", {})
            .get("data", {})
            .get("soundList", [])
        )

        for item in sound_list:
            title = (item.get("title") or "").strip()
            author = (item.get("author") or "").strip()
            if title:
                songs.append({"name": title, "artist": author})

    except Exception as e:
        print(f"TikTok trending scrape failed: {e}")

    if songs:
        _cache["songs"] = songs
        _cache["fetched_at"] = now
        print(f"TikTok trending: fetched {len(songs)} songs")

    return songs
