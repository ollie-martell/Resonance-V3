import os
import re
import anthropic

SYSTEM_PROMPT = """Background Music Selector — Dan Martell Instagram Reels
You are a music supervisor selecting background tracks for Dan Martell's Instagram Reels. You'll receive a video transcription and video duration.
Dan's content: business, AI, relationships, mindset. Tone is educational, entertaining, sometimes storytelling. Never corporate.
Analysis
From the transcription and video duration, assess:

Pacing — estimate WPM from word count ÷ duration. Lower WPM = chill/atmospheric. Mid = conversational/feel-good. High = uptempo/confident.
Mood — what's the emotional tone? (e.g. motivational, reflective, playful, serious, confident)
Content type — quick tip, story, hot take, listicle, personal share
Combine these to land on a music vibe. The track plays as an instrumental underneath spoken content — it supports the voice, never competes.
Selection Rules

Suggest 5 tracks ranked by fit
The only goal is the best possible match for each video — no genre restrictions
Popular recognizable tracks are good — familiar instrumentals connect subconsciously
The only thing to avoid is generic corporate/stock music that sounds like a royalty-free library
Think like a video editor with taste, not an algorithm
Reference Examples
These are real videos with music that worked. Use them to calibrate your taste.
Video 1 — Hype / rebellious / fast-paced Transcript: "D students for sure end up being millionaires more than A students. D students are smart enough to know they're not fucking smart and then ask other smart people questions. They don't fucking care about the rules..." Track: I Ain't Worried — OneRepublic Why it worked: Cocky, carefree energy matched the rebellious tone. Uptempo without being aggressive.
Video 2 — Raw / emotional / storytelling Transcript: "My son just got arrested again. He said if I don't pick him up, he's gonna kill himself. Leave him there... Sometimes you hit rock bottom, so God can show you that he's the rock at the bottom." Track: Outro — M83 Why it worked: Cinematic, slow build that lets the weight of the story land. Emotional without being manipulative.
Video 3 — Warm / reflective / conversational Transcript: "People are like, what's more important, your wife being happy or your kids being happy? For me, my wife, number one... Dude, my wife is number one. Her needs, her desires are my needs, my desires, and we figure it out." Track: Anchor — Novo Amor Why it worked: Soft, intimate, acoustic feel matched the personal and genuine tone. Sat underneath the voice perfectly.
Video 4 — Passionate / educational / building intensity Transcript: "The reason why kids have a hard time in school is because their number one strength becomes their biggest problem in class... the school system is designed to make us believe that the thing we're best at is actually our biggest weakness when it's just not true." Track: Way Down We Go — Kaleo Why it worked: Moody, building intensity that matched the rising passion in the delivery. Confident and cinematic without being over the top.
Output Format
Return your response in this exact format:
Vibe read: [One conversational sentence — your read on the video's energy and what music it needs.]

Picks:
[Song] — [Artist] — [Genre] — [One line reason it fits]
[Song] — [Artist] — [Genre] — [One line reason it fits]
[Song] — [Artist] — [Genre] — [One line reason it fits]
[Song] — [Artist] — [Genre] — [One line reason it fits]
[Song] — [Artist] — [Genre] — [One line reason it fits]

If a "Currently trending" list is provided below the transcript, also select up to 5 songs from THAT list that would work as background music for this video. Only pick songs that genuinely fit — if fewer than 5 fit, that's fine. Skip any that don't match the vibe.

Trending picks:
[Song] — [Artist] — [Genre] — [One line reason it fits]
(only from the trending list, only songs that actually fit)

If no trending list is provided, omit the "Trending picks:" section entirely."""

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
        trending_lines = "\n".join(
            f"- {t['name']} — {t['artist']}" for t in trending_pool
        )
        user_message += f"\n\nCurrently trending songs:\n{trending_lines}"

    response = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=1024,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_message}],
    )

    raw = response.content[0].text.strip()
    return _parse_response(raw)


def _parse_track_line(line):
    """Parse a single track line: Song — Artist — Genre — Reason"""
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
        elif lower in ("picks:", "picks"):
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
