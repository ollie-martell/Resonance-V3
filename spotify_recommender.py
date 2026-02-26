import os
import spotipy
from spotipy.oauth2 import SpotifyClientCredentials

_sp = None


def _get_spotify():
    global _sp
    if _sp is None:
        client_id = os.getenv("SPOTIPY_CLIENT_ID")
        client_secret = os.getenv("SPOTIPY_CLIENT_SECRET")
        if not client_id or not client_secret:
            raise ValueError("Set SPOTIPY_CLIENT_ID and SPOTIPY_CLIENT_SECRET in your .env file.")
        _sp = spotipy.Spotify(
            auth_manager=SpotifyClientCredentials(
                client_id=client_id,
                client_secret=client_secret,
            )
        )
    return _sp


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
                "name":      t["name"],
                "artist":    ", ".join(a["name"] for a in t["artists"]),
                "album":     t["album"]["name"],
                "album_art": images[0]["url"] if images else None,
                "url":       t["external_urls"].get("spotify", ""),
                "uri":       t["uri"],
                "genre":     genre,
                "reason":    suggestion.get("reason", ""),
            })

    return tracks


def _search(sp, query):
    try:
        results = sp.search(q=query, type="track", limit=1)
        return results.get("tracks", {}).get("items", [])
    except Exception as e:
        print(f"Spotify search failed for '{query}': {e}")
        return []
