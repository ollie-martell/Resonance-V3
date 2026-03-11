import os
import re
import random
import anthropic

SYSTEM_PROMPT = """Background Music Selector for Instagram/TikTok Reels
You are a music supervisor selecting background tracks for short-form video content. You'll receive a video transcription and video duration.
Content style: business, AI, relationships, mindset, lifestyle. Tone is educational, entertaining, sometimes storytelling. Never corporate.

Analysis
From the transcription and video duration, assess:
Pacing — estimate WPM from word count ÷ duration. Lower WPM = chill/atmospheric. Mid = conversational/feel-good. High = uptempo/confident.
Mood — what's the emotional tone? (e.g. motivational, reflective, playful, serious, confident)
Content type — quick tip, story, hot take, listicle, personal share
Combine these to land on a music vibe. The track plays as an instrumental underneath spoken content — it supports the voice, never competes.

Selection Rules
The only goal is the best possible match for each video — no genre restrictions
Popular recognizable tracks are good — familiar instrumentals connect subconsciously
The only thing to avoid is generic corporate/stock music that sounds like a royalty-free library
Think like a video editor with taste, not an algorithm
Currently trending songs are STRONGLY preferred — they perform better on social media and feel current

Reference Examples
Video 1 — Hype / rebellious / fast-paced Transcript: "D students for sure end up being millionaires more than A students..." Track: I Ain't Worried — OneRepublic Why it worked: Cocky, carefree energy matched the rebellious tone.
Video 2 — Raw / emotional / storytelling Transcript: "My son just got arrested again..." Track: Outro — M83 Why it worked: Cinematic, slow build that lets the weight of the story land.
Video 3 — Warm / reflective / conversational Transcript: "People are like, what's more important, your wife being happy or your kids being happy?..." Track: Anchor — Novo Amor Why it worked: Soft, intimate, acoustic feel matched the personal and genuine tone.
Video 4 — Passionate / educational / building intensity Transcript: "The reason why kids have a hard time in school is because their number one strength becomes their biggest problem in class..." Track: Way Down We Go — Kaleo Why it worked: Moody, building intensity that matched the rising passion in the delivery.

Output Format
Return your response in this exact format:

Vibe read: [One conversational sentence — your read on the video's energy and what music it needs.]

Trending picks:
[Song] — [Artist] — [Genre] — [One line reason it fits]
(Pick 5 from the trending list. These are songs currently blowing up on social media. Be generous — if a song's energy is even close to the vibe, include it. Only skip songs that truly clash with the mood.)

Backup picks:
[Song] — [Artist] — [Genre] — [One line reason it fits]
(5 additional songs from your own knowledge — these are classic/proven picks that fit the vibe, as a fallback.)

IMPORTANT: You MUST pick exactly 5 trending songs if 5+ trending songs are provided. Only pick fewer if the trending list itself has fewer than 5 songs, or if a song truly does not work at all. Err on the side of including rather than excluding.

If no trending list is provided, only output "Backup picks:" (renamed as "Picks:") with 5 songs."""

_client = None


def _get_client():
    global _client
    if _client is None:
        api_key = os.getenv("ANTHROPIC_API_KEY")
        if not api_key:
            raise ValueError("Set ANTHROPIC_API_KEY in your .env file.")
        _client = anthropic.Anthropic(api_key=api_key)
    return _client


def analyze_vibe(text, duration=None, exclude=None, trending_pool=None):
    client = _get_client()

    word_count = len(text.split())
    duration_str = f"{int(duration)} seconds" if duration else "unknown"
    wpm = round(word_count / (duration / 60)) if duration else "unknown"

    user_message = f"""Video duration: {duration_str}
Word count: {word_count}
Estimated WPM: {wpm}

Transcript:
{text}"""

    if exclude:
        user_message += f"\n\nDo not suggest any of these previously shown tracks: {', '.join(exclude)}"

    if trending_pool:
        # Send a random sample of 50 to keep context manageable
        sample = trending_pool if len(trending_pool) <= 50 else random.sample(trending_pool, 50)
        trending_lines = "\n".join(
            f"- {t['name']} — {t['artist']}" for t in sample
        )
        user_message += f"\n\nCurrently trending songs ({len(sample)} of {len(trending_pool)} available):\n{trending_lines}"

    response = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=2048,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_message}],
    )

    raw = response.content[0].text.strip()
    print(f"=== CLAUDE RAW RESPONSE ===\n{raw}\n=== END ===")
    result = _parse_response(raw)
    print(f"Parsed: {len(result['trending_suggestions'])} trending, {len(result['track_suggestions'])} backup")
    return result


def _parse_track_line(line):
    """Parse a single track line: Song — Artist — Genre — Reason"""
    # Strip leading numbering like "1.", "1)", "- ", "* "
    line = re.sub(r"^\s*(\d+[\.\)]\s*|[-*•]\s*)", "", line)
    parts = re.split(r"\s*[—–]\s*", line, maxsplit=3)
    if len(parts) >= 2 and parts[0]:
        return {
            "song":   parts[0].strip(),
            "artist": parts[1].strip() if len(parts) > 1 else "",
            "genre":  parts[2].strip() if len(parts) > 2 else "",
            "reason": parts[3].strip() if len(parts) > 3 else "",
        }
    return None


def _parse_response(raw):
    lines = [l.strip() for l in raw.split("\n") if l.strip()]

    vibe_read = ""
    picks = []
    trending_picks = []
    section = "picks"  # default section

    for line in lines:
        lower = line.lower()

        if lower.startswith("vibe read:"):
            vibe_read = line[len("vibe read:"):].strip()
        elif lower in ("picks:", "picks", "backup picks:", "backup picks"):
            section = "picks"
        elif lower in ("trending picks:", "trending picks"):
            section = "trending"
        else:
            track = _parse_track_line(line)
            if track:
                if section == "trending":
                    trending_picks.append(track)
                else:
                    picks.append(track)

    return {
        "vibe_read": vibe_read,
        "track_suggestions": picks[:5],
        "trending_suggestions": trending_picks[:5],
    }
