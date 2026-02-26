import os
import subprocess
import tempfile
from faster_whisper import WhisperModel

# Use the bundled ffmpeg binary
FFMPEG_PATH = os.path.join(os.path.dirname(__file__), "ffmpeg")


_model = None


def _get_model():
    global _model
    if _model is None:
        _model = WhisperModel("base", device="cpu", compute_type="int8")
    return _model


def extract_audio(video_path):
    """Extract audio from an MP4 video file to a temporary WAV file."""
    audio_path = tempfile.mktemp(suffix=".wav")
    subprocess.run(
        [
            FFMPEG_PATH, "-i", video_path,
            "-vn", "-acodec", "pcm_s16le",
            "-ar", "16000", "-ac", "1",
            "-y", audio_path,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=True,
    )
    return audio_path


def transcribe(video_path):
    """Transcribe speech from a video file.

    Returns a dict with 'text' (full transcript) and 'segments' (timestamped chunks).
    """
    audio_path = extract_audio(video_path)
    try:
        model = _get_model()
        segments_iter, info = model.transcribe(audio_path, beam_size=5)

        segments = []
        full_text_parts = []
        for seg in segments_iter:
            segments.append({
                "start": round(seg.start, 2),
                "end": round(seg.end, 2),
                "text": seg.text.strip(),
            })
            full_text_parts.append(seg.text.strip())

        return {
            "text": " ".join(full_text_parts),
            "segments": segments,
            "language": info.language,
            "duration": info.duration,
        }
    finally:
        if os.path.exists(audio_path):
            os.remove(audio_path)
