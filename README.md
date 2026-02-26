# Video Vibe

Upload an MP4 video, detect the mood from speech, and get matching Spotify song suggestions.

## Prerequisites

- Python 3.9+
- ffmpeg: `brew install ffmpeg`
- A free [Spotify Developer](https://developer.spotify.com) account

## Setup

1. Install dependencies:
   ```bash
   cd video-vibe
   pip install -r requirements.txt
   ```

2. Create a `.env` file with your Spotify credentials:
   ```bash
   cp .env.example .env
   # Edit .env with your Client ID and Client Secret
   ```

3. Run the app:
   ```bash
   python app.py
   ```

4. Open http://localhost:5000 in your browser.

## How It Works

1. Upload an MP4 video with speech
2. Audio is extracted and transcribed locally using Whisper
3. The transcript is analyzed for emotions (joy, sadness, anger, etc.)
4. Emotions are mapped to Spotify audio features (valence, energy, tempo)
5. Spotify's Recommendations API returns matching songs
