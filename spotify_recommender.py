import os
import time
import spotipy
from spotipy.oauth2 import SpotifyClientCredentials

_sp = None

# Trending playlists to pull from
_TRENDING_PLAYLISTS = [
    "37i9dQZF1DXcBWIGoYBM5M",  # Today's Top Hits
    "37i9dQZF1DX0kbJZpiYdZl",  # Hot Hits USA
    "37i9dQZEVXbLiRSasKsNU9",  # Viral 50 – Global
    "37i9dQZF1DWcJqBMXTBTHW",  # New Music Friday
    "37i9dQZF1DX2L0iB23Enbq",  # Viral Hits
]

# Cache: { "pool": [...], "fetched_at": timestamp }
_trending_cache = {"pool": [], "fetched_at": 0}
_CACHE_TTL = 900  # refresh every 15 minutes


def _get_spotify():
    global _sp
    client_id = os.getenv("SPOTIPY_CLIENT_ID")
    client_secret = os.getenv("SPOTIPY_CLIENT_SECRET")
    if not client_id or not client_secret:
        raise ValueError("Set SPOTIPY_CLIENT_ID and SPOTIPY_CLIENT_SECRET in your .env file.")
    if _sp is None:
        _sp = spotipy.Spotify(
            auth_manager=SpotifyClientCredentials(
                client_id=client_id,
                client_secret=client_secret,
            )
        )
    else:
        # Force token refresh if needed
        try:
            _sp.auth_manager.get_access_token(as_dict=False)
        except Exception:
            _sp = spotipy.Spotify(
                auth_manager=SpotifyClientCredentials(
                    client_id=client_id,
                    client_secret=client_secret,
                )
            )
    return _sp


def get_trending_pool():
    """Fetch trending tracks from TikTok Creative Center + Spotify playlists.

    TikTok songs come first (actual social media trending), then Spotify
    playlist tracks fill out the pool. Cached for 15 minutes.
    """
    global _sp
    now = time.time()
    if _trending_cache["pool"] and (now - _trending_cache["fetched_at"]) < _CACHE_TTL:
        return _trending_cache["pool"]

    pool = []
    seen = set()

    # 1) TikTok Creative Center — real social media trending audio
    try:
        from trending_scraper import get_tiktok_trending
        for song in get_tiktok_trending():
            key = (song["name"].lower(), song["artist"].lower())
            if key not in seen:
                seen.add(key)
                pool.append(song)
    except Exception as e:
        print(f"TikTok trending failed: {e}")

    # 2) Spotify new releases + popular searches — client credentials (no user auth)
    try:
        sp = _get_spotify()

        # 2a) New album releases → extract tracks from each
        try:
            new_releases = sp.new_releases(limit=20)
            for album in new_releases.get("albums", {}).get("items", []):
                try:
                    album_tracks = sp.album_tracks(album["id"], limit=5)
                    for track in album_tracks.get("items", []):
                        if not track or not track.get("id"):
                            continue
                        name = track["name"]
                        artist = ", ".join(a["name"] for a in track.get("artists", []))
                        key = (name.lower(), artist.lower())
                        if key not in seen:
                            seen.add(key)
                            pool.append({"name": name, "artist": artist})
                except Exception:
                    pass
        except Exception as e:
            print(f"New releases failed: {e}")

        # 2b) Search for currently popular songs across genres
        _TRENDING_QUERIES = [
            "tag:new year:2025",
            "tag:new year:2026",
            "tag:hipster",
            "viral TikTok",
            "trending",
            "new music friday",
            "hot hits",
            "top songs 2025",
            "top songs 2026",
            "viral hits",
            "popular right now",
            "Drake", "Kendrick Lamar", "Taylor Swift", "SZA",
            "Bad Bunny", "Doja Cat", "Travis Scott", "Billie Eilish",
            "The Weeknd", "Sabrina Carpenter", "Chappell Roan",
            "Tyla", "Peso Pluma", "Jack Harlow", "Dua Lipa",
            "Future", "Metro Boomin", "21 Savage", "Gunna",
        ]
        for query in _TRENDING_QUERIES:
            try:
                results = sp.search(q=query, type="track", limit=10)
                for track in results.get("tracks", {}).get("items", []):
                    if not track or not track.get("id"):
                        continue
                    # Only include reasonably popular tracks
                    if track.get("popularity", 0) < 40:
                        continue
                    name = track["name"]
                    artist = ", ".join(a["name"] for a in track.get("artists", []))
                    key = (name.lower(), artist.lower())
                    if key not in seen:
                        seen.add(key)
                        pool.append({"name": name, "artist": artist})
            except Exception as e:
                print(f"Trending search '{query}' failed: {e}")

    except ValueError:
        pass

    _trending_cache["pool"] = pool
    _trending_cache["fetched_at"] = now
    print(f"Trending pool: {len(pool)} songs ({len(pool)} unique)")
    return pool


def recommend(track_suggestions):
    try:
        sp = _get_spotify()
    except ValueError:
        return []

    tracks = []
    for suggestion in track_suggestions:
        song = suggestion.get("song", "")
        artist = suggestion.get("artist", "")
        if not song:
            continue

        # Try exact search first
        items = _search(sp, f'track:"{song}" artist:"{artist}"')

        # Fall back to looser search
        if not items:
            items = _search(sp, f"{song} {artist}")

        # Try swapping song/artist (Claude sometimes reverses them)
        if not items and artist:
            items = _search(sp, f'track:"{artist}" artist:"{song}"')
            if not items:
                items = _search(sp, f"{artist} {song}")

        if items:
            t = items[0]
            images = t.get("album", {}).get("images", [])

            # Pull genre from Spotify's artist data — more accurate than Claude's label
            genre = suggestion.get("genre", "")
            if t.get("artists"):
                try:
                    artist_data = sp.artist(t["artists"][0]["id"])
                    spotify_genres = artist_data.get("genres", [])
                    if spotify_genres:
                        genre = spotify_genres[0]
                except Exception:
                    pass

            tracks.append({
                "name":        t["name"],
                "artist":      ", ".join(a["name"] for a in t["artists"]),
                "album":       t["album"]["name"],
                "album_art":   images[0]["url"] if images else None,
                "url":         t["external_urls"].get("spotify", ""),
                "uri":         t["uri"],
                "preview_url": t.get("preview_url"),
                "genre":       genre,
                "reason":      suggestion.get("reason", ""),
                "duration_ms": t.get("duration_ms", 0),
            })

    return tracks


def _search(sp, query):
    try:
        results = sp.search(q=query, type="track", limit=1)
        return results.get("tracks", {}).get("items", [])
    except spotipy.exceptions.SpotifyException as e:
        if e.http_status == 401:
            # Token expired — force new client and retry once
            global _sp
            _sp = None
            try:
                sp = _get_spotify()
                results = sp.search(q=query, type="track", limit=1)
                return results.get("tracks", {}).get("items", [])
            except Exception as e2:
                print(f"Spotify search retry failed for '{query}': {e2}")
                return []
        print(f"Spotify search failed for '{query}': {e}")
        return []
    except Exception as e:
        print(f"Spotify search failed for '{query}': {e}")
        return []
