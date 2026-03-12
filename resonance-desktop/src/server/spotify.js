/**
 * Spotify integration — trending pool + track lookup
 * Node.js port of spotify_recommender.py
 */
const SpotifyWebApi = require("spotify-web-api-node");

let spotifyApi = null;
let tokenExpiry = 0;

// Cache
const trendingCache = { pool: [], fetchedAt: 0 };
const CACHE_TTL = 900_000; // 15 minutes in ms

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const TRENDING_QUERIES = [
  "Drake", "Kendrick Lamar", "Taylor Swift", "SZA",
  "Bad Bunny", "Doja Cat", "Travis Scott", "Billie Eilish",
  "The Weeknd", "Sabrina Carpenter", "Chappell Roan",
  "Tyla", "Peso Pluma", "Jack Harlow", "Dua Lipa",
  "Future", "Metro Boomin", "21 Savage", "Gunna",
  "Post Malone", "Morgan Wallen", "Zach Bryan", "Benson Boone",
  "Hozier", "Teddy Swims", "Tommy Richman",
  "Ariana Grande", "Bruno Mars", "Lady Gaga",
  "Tyler the Creator", "Frank Ocean", "Steve Lacy",
  "Latto", "GloRilla", "Megan Thee Stallion", "Ice Spice",
  "Olivia Rodrigo", "Gracie Abrams", "Reneé Rapp",
  "viral TikTok 2025", "trending songs 2025",
  "new music 2025", "top hits 2026",
  "chill vibes", "motivational music",
  "indie pop", "lo-fi beats",
  "cinematic instrumental", "feel good songs",
  "hype music", "emotional songs",
];

async function getSpotify() {
  const clientId = process.env.SPOTIPY_CLIENT_ID;
  const clientSecret = process.env.SPOTIPY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Spotify credentials not set. Add SPOTIPY_CLIENT_ID and SPOTIPY_CLIENT_SECRET in Settings.");
  }

  if (!spotifyApi) {
    spotifyApi = new SpotifyWebApi({ clientId, clientSecret });
  }

  // Refresh token if expired
  if (Date.now() >= tokenExpiry) {
    const data = await spotifyApi.clientCredentialsGrant();
    spotifyApi.setAccessToken(data.body.access_token);
    tokenExpiry = Date.now() + (data.body.expires_in - 60) * 1000;
  }

  return spotifyApi;
}

async function getTrendingPool() {
  const now = Date.now();
  if (trendingCache.pool.length > 0 && now - trendingCache.fetchedAt < CACHE_TTL) {
    return trendingCache.pool;
  }

  const pool = [];
  const seen = new Set();

  // TikTok trending (try importing)
  try {
    const fetch = require("node-fetch");
    const resp = await fetch(
      "https://ads.tiktok.com/business/creativecenter/inspiration/popular/music/pc/en",
      { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" } }
    );
    const html = await resp.text();
    const match = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
    if (match) {
      const data = JSON.parse(match[1]);
      const musicList =
        data?.props?.pageProps?.musicList ||
        data?.props?.pageProps?.dehydratedState?.queries?.[0]?.state?.data?.musicList ||
        [];
      for (const item of musicList) {
        const name = item.musicName || item.title || "";
        const artist = item.authorName || item.author || "";
        if (name) {
          const key = `${name.toLowerCase()}|${artist.toLowerCase()}`;
          if (!seen.has(key)) {
            seen.add(key);
            pool.push({ name, artist, source: "tiktok" });
          }
        }
      }
    }
  } catch (err) {
    console.error("TikTok trending failed:", err.message);
  }

  // Spotify search queries — run in parallel batches for speed
  try {
    const sp = await getSpotify();
    const BATCH_SIZE = 10;
    for (let i = 0; i < TRENDING_QUERIES.length; i += BATCH_SIZE) {
      const batch = TRENDING_QUERIES.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((query) => sp.searchTracks(query, { limit: 10 }))
      );
      for (const result of results) {
        if (result.status !== "fulfilled") continue;
        const tracks = result.value.body.tracks?.items || [];
        for (const track of tracks) {
          if (!track || !track.id) continue;
          const name = track.name;
          const artist = track.artists.map((a) => a.name).join(", ");
          const key = `${name.toLowerCase()}|${artist.toLowerCase()}`;
          if (!seen.has(key)) {
            seen.add(key);
            pool.push({ name, artist, source: "spotify" });
          }
        }
      }
    }
  } catch (err) {
    console.error("Spotify init failed:", err.message);
  }

  trendingCache.pool = pool;
  trendingCache.fetchedAt = now;
  console.log(`Trending pool: ${pool.length} songs`);
  return pool;
}

async function recommendTracks(suggestions) {
  if (!suggestions || suggestions.length === 0) return [];

  let sp;
  try {
    sp = await getSpotify();
  } catch {
    return [];
  }

  const tracks = [];

  for (const suggestion of suggestions) {
    const song = suggestion.song || "";
    const artist = suggestion.artist || "";
    if (!song) continue;

    let items = await searchTrack(sp, `track:"${song}" artist:"${artist}"`);
    if (!items.length) { await sleep(100); items = await searchTrack(sp, `${song} ${artist}`); }
    // Try swapped (Claude sometimes reverses song/artist)
    if (!items.length && artist) {
      await sleep(100);
      items = await searchTrack(sp, `track:"${artist}" artist:"${song}"`);
      if (!items.length) { await sleep(100); items = await searchTrack(sp, `${artist} ${song}`); }
    }

    if (items.length > 0) {
      const t = items[0];
      const images = t.album?.images || [];

      // Get genre from artist data
      let genre = suggestion.genre || "";
      if (t.artists?.[0]?.id) {
        try {
          const artistData = await sp.getArtist(t.artists[0].id);
          const genres = artistData.body.genres || [];
          if (genres.length > 0) genre = genres[0];
        } catch (_) {}
      }

      tracks.push({
        name: t.name,
        artist: t.artists.map((a) => a.name).join(", "),
        album: t.album.name,
        album_art: images[0]?.url || null,
        url: t.external_urls?.spotify || "",
        uri: t.uri,
        preview_url: t.preview_url || null,
        genre,
        reason: suggestion.reason || "",
        duration_ms: t.duration_ms || 0,
      });
    }
  }

  return tracks;
}

async function searchTrack(sp, query, retries = 2) {
  try {
    const results = await sp.searchTracks(query, { limit: 1 });
    return results.body.tracks?.items || [];
  } catch (err) {
    if (err.statusCode === 429 && retries > 0) {
      const retryAfter = parseInt(err.headers?.["retry-after"] || "2", 10);
      console.log(`Spotify 429 on search — waiting ${retryAfter}s`);
      await sleep(retryAfter * 1000);
      return searchTrack(sp, query, retries - 1);
    }
    if (err.statusCode === 401) {
      tokenExpiry = 0;
      try {
        sp = await getSpotify();
        const results = await sp.searchTracks(query, { limit: 1 });
        return results.body.tracks?.items || [];
      } catch (err2) {
        console.error(`Spotify retry failed for '${query}':`, err2.message);
        return [];
      }
    }
    console.error(`Spotify search failed for '${query}':`, err.message);
    return [];
  }
}

module.exports = { getTrendingPool, recommendTracks };
