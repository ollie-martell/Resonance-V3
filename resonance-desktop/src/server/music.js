/**
 * music.js — Trending pool + track lookup
 * No API keys required. Uses Deezer charts + TikTok scraper for trending,
 * iTunes Search API for track metadata/artwork.
 */

const https = require("https");

// ── Cache ──────────────────────────────────────────────────────────────────
const trendingCache = { pool: [], fetchedAt: 0 };
const CACHE_TTL = 900_000; // 15 min

// ── HTTP helper ────────────────────────────────────────────────────────────
function httpGet(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "Resonance/1.0" } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error("JSON parse error: " + url)); }
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error("Timeout: " + url)); });
  });
}

// ── Deezer charts ──────────────────────────────────────────────────────────
async function getDeezerTrending() {
  try {
    const data = await httpGet("https://api.deezer.com/chart/0/tracks?limit=50");
    return (data.data || []).map((t) => ({
      name: t.title,
      artist: t.artist?.name || "",
      album_art: t.album?.cover_medium || null,
      duration_ms: (t.duration || 0) * 1000,
      source: "deezer",
    }));
  } catch (e) {
    console.error("Deezer trending failed:", e.message);
    return [];
  }
}

// ── TikTok trending ────────────────────────────────────────────────────────
async function getTikTokTrending() {
  return new Promise((resolve) => {
    const http = require("http");
    const req = http.get(
      "http://localhost:__UNUSED__", // placeholder — uses fetch below
      () => {}
    );
    req.destroy();
    resolve([]);
  });
}

// We call the Python-style scraper via a direct HTTPS fetch
async function getTikTokTrendingDirect() {
  return new Promise((resolve) => {
    const https = require("https");
    const options = {
      hostname: "ads.tiktok.com",
      path: "/business/creativecenter/inspiration/popular/music/pc/en",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
      },
      timeout: 12000,
    };
    let html = "";
    const req = https.get(options, (res) => {
      res.on("data", (c) => (html += c));
      res.on("end", () => {
        try {
          const match = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
          if (!match) return resolve([]);
          const data = JSON.parse(match[1]);
          const list =
            data?.props?.pageProps?.data?.soundList ||
            data?.props?.pageProps?.musicList ||
            [];
          resolve(
            list
              .map((item) => ({
                name: (item.title || item.musicName || "").trim(),
                artist: (item.author || item.authorName || "").trim(),
                album_art: item.coverMedium || item.cover || null,
                duration_ms: 0,
                source: "tiktok",
              }))
              .filter((t) => t.name)
          );
        } catch (e) {
          resolve([]);
        }
      });
    });
    req.on("error", () => resolve([]));
    req.setTimeout(12000, () => { req.destroy(); resolve([]); });
  });
}

// ── Trending pool ──────────────────────────────────────────────────────────
async function getTrendingPool() {
  const now = Date.now();
  if (trendingCache.pool.length > 0 && now - trendingCache.fetchedAt < CACHE_TTL) {
    return trendingCache.pool;
  }

  const [tiktok, deezer] = await Promise.all([
    getTikTokTrendingDirect(),
    getDeezerTrending(),
  ]);

  const seen = new Set();
  const pool = [];
  for (const t of [...tiktok, ...deezer]) {
    const key = `${t.name.toLowerCase()}|${t.artist.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      pool.push(t);
    }
  }

  trendingCache.pool = pool;
  trendingCache.fetchedAt = now;
  console.log(`Trending pool: ${pool.length} tracks (${tiktok.length} tiktok, ${deezer.length} deezer)`);
  return pool;
}

// ── iTunes track lookup ────────────────────────────────────────────────────
async function lookupOnItunes(song, artist) {
  try {
    const term = encodeURIComponent(`${song} ${artist}`);
    const data = await httpGet(
      `https://itunes.apple.com/search?term=${term}&entity=song&limit=3&country=US`,
      8000
    );
    const results = data.results || [];
    if (!results.length) return null;

    // Pick best match
    const songLow = song.toLowerCase();
    const artistLow = artist.toLowerCase();
    const best =
      results.find(
        (r) =>
          r.trackName?.toLowerCase().includes(songLow) &&
          r.artistName?.toLowerCase().includes(artistLow)
      ) || results[0];

    return {
      name: best.trackName,
      artist: best.artistName,
      album_art: (best.artworkUrl100 || "").replace("100x100", "300x300"),
      duration_ms: best.trackTimeMillis || 0,
      preview_url: best.previewUrl || null,
      genre: best.primaryGenreName || "",
      url: best.trackViewUrl || "",
    };
  } catch (e) {
    return null;
  }
}

// ── Resolve track list from Claude suggestions ─────────────────────────────
async function resolveTrackSuggestions(suggestions) {
  if (!suggestions || !suggestions.length) return [];

  const results = await Promise.allSettled(
    suggestions.map(async (s) => {
      const song = s.song || s.name || "";
      const artist = s.artist || "";
      if (!song) return null;

      const meta = await lookupOnItunes(song, artist);
      if (!meta) return null;

      return {
        ...meta,
        reason: s.reason || "",
        genre: meta.genre || s.genre || "",
      };
    })
  );

  return results
    .filter((r) => r.status === "fulfilled" && r.value)
    .map((r) => r.value);
}

// ── Resolve trending picks (already have metadata from Deezer/TikTok) ──────
async function resolveTrendingTracks(suggestions, pool) {
  if (!suggestions || !suggestions.length) return [];

  const results = await Promise.allSettled(
    suggestions.map(async (s) => {
      const song = s.song || s.name || "";
      const artist = s.artist || "";
      if (!song) return null;

      // Check if pool already has metadata
      const poolEntry = pool.find(
        (p) =>
          p.name.toLowerCase() === song.toLowerCase() ||
          p.name.toLowerCase().includes(song.toLowerCase())
      );

      const meta = await lookupOnItunes(song, artist);
      const base = meta || poolEntry || null;
      if (!base) return null;

      return {
        name: base.name || song,
        artist: base.artist || artist,
        album_art: base.album_art || null,
        duration_ms: base.duration_ms || 0,
        preview_url: base.preview_url || null,
        genre: base.genre || s.genre || "",
        reason: s.reason || "",
        url: base.url || "",
      };
    })
  );

  return results
    .filter((r) => r.status === "fulfilled" && r.value)
    .map((r) => r.value);
}

module.exports = { getTrendingPool, resolveTrackSuggestions, resolveTrendingTracks };
