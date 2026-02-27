"""
exporter.py — YouTube instrumental download + video export for Resonance
"""

import os
import re
import json
import uuid
import subprocess

UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "uploads")
EXPORT_DIR = os.path.join(os.path.dirname(__file__), "exports")
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(EXPORT_DIR, exist_ok=True)


# ── Scoring helper ──────────────────────────────────────────────────────

def _score_result(entry, song_name, artist, target_duration_s):
    """Score a yt-dlp flat-search entry. Returns None if hard-disqualified."""
    title = (entry.get("title") or "").lower()

    # Hard disqualifier: every word >=3 chars from the song name must appear
    for word in song_name.lower().split():
        if len(word) >= 3 and word not in title:
            return None

    score = 0

    # +20 if any artist name word appears
    for word in artist.lower().split():
        if len(word) >= 3 and word in title:
            score += 20
            break

    # +15 for instrumental keywords
    for kw in ["instrumental", "karaoke", "no vocals", "backing track", "minus one"]:
        if kw in title:
            score += 15

    # -10 for bad keywords
    for kw in ["lyrics", "lyric video", "official video", "official music video",
                "live", "cover", "remix", "reaction", "full album"]:
        if kw in title:
            score -= 10

    # Duration bonus
    if target_duration_s and entry.get("duration"):
        diff = abs(entry["duration"] - target_duration_s)
        score += max(0, 30 - diff) * 1.5

    return score


# ── Download a single entry ─────────────────────────────────────────────

def _download_entry(entry):
    """Download the best-scoring entry as mp3. Returns the file path."""
    uid = uuid.uuid4().hex
    out_template = os.path.join(UPLOAD_DIR, f"instr_{uid}.%(ext)s")

    url = entry.get("url") or entry.get("webpage_url")
    if not url or not url.startswith("http"):
        url = f"https://www.youtube.com/watch?v={entry['id']}"

    opts = {
        "format": "bestaudio/best",
        "outtmpl": out_template,
        "postprocessors": [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": "mp3",
            "preferredquality": "192",
        }],
        "quiet": True,
        "no_warnings": True,
    }

    import yt_dlp
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([url])

    mp3_path = os.path.join(UPLOAD_DIR, f"instr_{uid}.mp3")
    if not os.path.isfile(mp3_path):
        raise RuntimeError("yt-dlp download succeeded but mp3 file not found")
    return mp3_path


# ── Main search + download ──────────────────────────────────────────────

def download_instrumental(song_name, artist, duration_ms=None):
    """Search YouTube for an instrumental version of the song, download as mp3."""
    import yt_dlp

    target_duration_s = (duration_ms / 1000.0) if duration_ms else None

    queries = [
        f"{song_name} {artist} instrumental no vocals",
        f"{song_name} {artist} instrumental",
        f"{song_name} {artist} karaoke",
        f"{song_name} instrumental",
    ]

    best_entry = None
    best_score = -999

    for query in queries:
        search_opts = {
            "extract_flat": True,
            "quiet": True,
            "no_warnings": True,
        }
        with yt_dlp.YoutubeDL(search_opts) as ydl:
            try:
                result = ydl.extract_info(f"ytsearch5:{query}", download=False)
            except Exception:
                continue

        entries = result.get("entries") or []
        for entry in entries:
            if not entry:
                continue
            sc = _score_result(entry, song_name, artist, target_duration_s)
            if sc is None:
                continue
            if sc > best_score:
                best_score = sc
                best_entry = entry

        # Early exit if we already have a strong match
        if best_score >= 15:
            break

    if best_entry is None:
        raise RuntimeError(
            f"No suitable instrumental found for '{song_name}' by '{artist}'"
        )

    return _download_entry(best_entry)


# ── Audio duration via ffprobe ──────────────────────────────────────────

def get_audio_duration_ms(path):
    """Return duration of an audio file in milliseconds via ffprobe."""
    cmd = [
        "ffprobe", "-v", "quiet", "-print_format", "json",
        "-show_format", path,
    ]
    out = subprocess.check_output(cmd, stderr=subprocess.DEVNULL)
    info = json.loads(out)
    return int(float(info["format"]["duration"]) * 1000)


# ── Mix + export ────────────────────────────────────────────────────────

def mix_and_export(video_path, audio_path, start_ms, video_vol, music_vol):
    """Overlay instrumental audio onto video and export as mp4."""
    # Get video duration
    probe_cmd = [
        "ffprobe", "-v", "quiet", "-print_format", "json",
        "-show_format", "-show_streams", video_path,
    ]
    probe_out = subprocess.check_output(probe_cmd, stderr=subprocess.DEVNULL)
    probe_info = json.loads(probe_out)
    vid_duration = float(probe_info["format"]["duration"])

    # Check if video has an audio stream
    has_audio = any(
        s["codec_type"] == "audio"
        for s in probe_info.get("streams", [])
        if s.get("codec_type")
    )

    start_s = start_ms / 1000.0

    # Build filter_complex
    music_filter = (
        f"[1:a]atrim=start={start_s}:duration={vid_duration},"
        f"asetpts=PTS-STARTPTS,volume={music_vol}[ma]"
    )

    if has_audio and video_vol > 0:
        filter_complex = (
            f"[0:a]volume={video_vol}[va]; "
            f"{music_filter}; "
            f"[va][ma]amix=inputs=2:duration=first:normalize=0[aout]"
        )
        map_audio = "[aout]"
    else:
        filter_complex = f"{music_filter}; [ma]anull[aout]"
        map_audio = "[aout]"

    export_id = uuid.uuid4().hex
    output_path = os.path.join(EXPORT_DIR, f"{export_id[:12]}.mp4")

    cmd = [
        "ffmpeg", "-y",
        "-i", video_path,
        "-i", audio_path,
        "-filter_complex", filter_complex,
        "-map", "0:v",
        "-map", map_audio,
        "-c:v", "copy",
        "-c:a", "aac",
        "-b:a", "192k",
        "-movflags", "+faststart",
        "-shortest",
        output_path,
    ]

    subprocess.run(cmd, check=True, capture_output=True)

    return export_id, output_path
