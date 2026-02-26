import os
import json
import secrets
from urllib.parse import urlencode
from flask import Flask, render_template, request, jsonify, redirect, session, Response, stream_with_context
import requests as http
from dotenv import load_dotenv
from transcriber import transcribe
from vibe_analyzer import analyze_vibe
from spotify_recommender import recommend

load_dotenv()

app = Flask(__name__)
app.secret_key = secrets.token_hex(32)
app.config["MAX_CONTENT_LENGTH"] = 500 * 1024 * 1024

UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

CLIENT_ID     = os.getenv("SPOTIPY_CLIENT_ID")
CLIENT_SECRET = os.getenv("SPOTIPY_CLIENT_SECRET")
REDIRECT_URI  = "https://localhost:5001/callback"
SCOPES        = "user-read-email user-read-private"


@app.route("/")
def index():
    return render_template("index.html",
                           spotify_client_id=CLIENT_ID,
                           spotify_token=session.get("token", ""),
                           redirect_uri=REDIRECT_URI)


@app.route("/login")
def login():
    params = urlencode({
        "client_id": CLIENT_ID,
        "response_type": "code",
        "redirect_uri": REDIRECT_URI,
        "scope": SCOPES,
    })
    url = "https://accounts.spotify.com/authorize?" + params
    print("LOGIN URL:", url)
    return redirect(url)


@app.route("/callback")
def callback():
    code = request.args.get("code")
    if not code:
        return redirect("/")
    resp = http.post("https://accounts.spotify.com/api/token", data={
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": REDIRECT_URI,
    }, auth=(CLIENT_ID, CLIENT_SECRET))
    session["token"] = resp.json().get("access_token", "")
    return redirect("/")


@app.route("/logout")
def logout():
    session.clear()
    return redirect("/")


@app.route("/reroll", methods=["POST"])
def reroll():
    data = request.get_json()
    transcript = data.get("transcript", "")
    duration = data.get("duration")
    exclude = data.get("exclude", [])
    if not transcript.strip():
        return jsonify({"error": "No transcript provided"}), 400
    try:
        vibe = analyze_vibe(transcript, duration, exclude=exclude)
        tracks = recommend(vibe["track_suggestions"])
        return jsonify({"tracks": tracks})
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        print(f"Reroll error: {e}")
        return jsonify({"error": f"Reroll failed: {str(e)}"}), 500


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload)}\n\n"


@app.route("/analyze", methods=["POST"])
def analyze():
    if "video" not in request.files:
        return jsonify({"error": "No video file provided"}), 400
    video = request.files["video"]
    if video.filename == "":
        return jsonify({"error": "No file selected"}), 400
    if not video.filename.lower().endswith(".mp4"):
        return jsonify({"error": "Only MP4 files are supported"}), 400

    video_path = os.path.join(UPLOAD_DIR, "temp_upload.mp4")
    video.save(video_path)

    def generate():
        try:
            yield _sse({"progress": 8, "message": "Extracting audio\u2026"})

            transcript = transcribe(video_path)
            if not transcript["text"].strip():
                yield _sse({"error": "No speech detected in the video"})
                return

            yield _sse({"progress": 45, "message": "Analyzing vibe\u2026"})

            vibe = analyze_vibe(transcript["text"], transcript.get("duration"))

            yield _sse({"progress": 78, "message": "Finding matching songs\u2026"})

            tracks = recommend(vibe["track_suggestions"])

            yield _sse({
                "progress": 100,
                "done": True,
                "transcript": transcript["text"],
                "vibe_read": vibe["vibe_read"],
                "tracks": tracks,
                "duration": transcript.get("duration"),
            })
        except ValueError as e:
            yield _sse({"error": str(e)})
        except Exception as e:
            print(f"Error: {e}")
            yield _sse({"error": f"Processing failed: {str(e)}"})
        finally:
            if os.path.exists(video_path):
                os.remove(video_path)

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5001,
            ssl_context=("localhost.pem", "localhost-key.pem"))
