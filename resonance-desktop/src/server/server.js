/**
 * Local Express server — handles all heavy I/O locally:
 *   - Video transcription (whisper.cpp / system whisper)
 *   - Instrumental download (yt-dlp)
 *   - Video export (ffmpeg)
 *   - Vibe analysis (Claude API)
 *   - Spotify search (Client Credentials for now)
 */
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

// Load .env from project root or parent (for dev mode)
const dotenv = require("dotenv");
const PROJECT_ROOT = path.join(__dirname, "../../..");
dotenv.config({ path: path.join(__dirname, "../../.env") });
dotenv.config({ path: path.join(PROJECT_ROOT, ".env") });

const { transcribe } = require("./transcriber");
const { analyzeVibe } = require("./vibe-analyzer");
const { getTrendingPool, resolveTrackSuggestions, resolveTrendingTracks } = require("./music");
const { downloadInstrumental, getAudioDuration } = require("./exporter");
const { mixAndExport } = require("./exporter");

// Directories
const DATA_DIR = path.join(
  require("os").homedir(),
  ".resonance"
);
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const EXPORTS_DIR = path.join(DATA_DIR, "exports");
const INSTRUMENTALS_DIR = path.join(DATA_DIR, "instrumentals");

[DATA_DIR, UPLOADS_DIR, EXPORTS_DIR, INSTRUMENTALS_DIR].forEach((d) =>
  fs.mkdirSync(d, { recursive: true })
);

const upload = multer({ dest: UPLOADS_DIR });

let server = null;

function startServer(port = 17532) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(cors());
    app.use(express.json({ limit: "50mb" }));

    // Health check
    app.get("/health", (req, res) => {
      res.json({ status: "ok", version: require("../../package.json").version });
    });

    // ── Analyze by file path (Premiere extension — no upload needed) ──
    app.post("/analyze-path", async (req, res) => {
      const { video_path } = req.body;
      if (!video_path || !fs.existsSync(video_path)) {
        return res.status(400).json({ error: "video_path not found: " + video_path });
      }
      return analyzeVideo(video_path, [], req, res);
    });

    // ── Shared analysis logic ──────────────────────────────────────────
    async function analyzeVideo(videoPath, exclude, req, res) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const send = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      try {
        send("progress", { step: "transcribe", message: "Transcribing audio..." });
        const { text, duration } = await transcribe(videoPath);
        send("progress", { step: "transcribe_done", message: "Transcription complete" });

        send("progress", { step: "trending", message: "Fetching trending songs..." });
        const trendingPool = await getTrendingPool();
        send("progress", { step: "trending_done", message: `Found ${trendingPool.length} trending songs` });

        send("progress", { step: "vibe", message: "Analyzing vibe..." });
        const vibeResult = await analyzeVibe(text, duration, exclude, trendingPool);
        send("progress", { step: "vibe_done", message: "Vibe analysis complete" });

        send("progress", { step: "spotify", message: "Finding matching tracks..." });
        const [trendingTracks, backupTracks] = await Promise.all([
          resolveTrendingTracks(vibeResult.trending_suggestions || [], trendingPool),
          resolveTrackSuggestions(vibeResult.track_suggestions || []),
        ]);
        send("progress", { step: "spotify_done", message: "Tracks found!" });

        const shownNames = new Set([
          ...exclude,
          ...trendingTracks.map((t) => t.name),
          ...backupTracks.map((t) => t.name),
        ]);
        const remaining = trendingPool.filter((t) => !shownNames.has(t.name)).length;

        send("result", {
          transcript: text,
          duration,
          vibe_read: vibeResult.vibe_read,
          trending: trendingTracks,
          tracks: backupTracks,
          pool_exhausted: remaining < 5,
          remaining_count: remaining,
          video_path: videoPath,
        });

        res.end();
      } catch (err) {
        console.error("Analyze error:", err);
        send("error", { error: err.message });
        res.end();
      }
    }

    // ── Upload + Analyze (full pipeline) ──────────────────────────────
    app.post("/analyze", upload.single("video"), async (req, res) => {
      if (!req.file) {
        return res.status(400).json({ error: "No video file provided" });
      }
      const exclude = req.body.exclude ? JSON.parse(req.body.exclude) : [];
      return analyzeVideo(req.file.path, exclude, req, res);
    });

    // ── Reroll ────────────────────────────────────────────────────────
    app.post("/reroll", async (req, res) => {
      try {
        const { transcript, duration, exclude = [], fallback_mode = false } = req.body;

        const trendingPool = await getTrendingPool();

        const vibeResult = await analyzeVibe(
          transcript,
          duration,
          exclude,
          fallback_mode ? null : trendingPool
        );

        const [trendingTracks, backupTracks] = await Promise.all([
          fallback_mode ? Promise.resolve([]) : resolveTrendingTracks(vibeResult.trending_suggestions || [], trendingPool),
          resolveTrackSuggestions(vibeResult.track_suggestions || []),
        ]);

        const shownNames = new Set([
          ...exclude,
          ...trendingTracks.map((t) => t.name),
          ...backupTracks.map((t) => t.name),
        ]);
        const remaining = trendingPool.filter(
          (t) => !shownNames.has(t.name)
        ).length;

        res.json({
          vibe_read: vibeResult.vibe_read,
          trending: trendingTracks,
          tracks: backupTracks,
          pool_exhausted: remaining < 5,
          remaining_count: remaining,
        });
      } catch (err) {
        console.error("Reroll error:", err);
        res.status(500).json({ error: err.message });
      }
    });

    // ── Download instrumental (JSON response) ──────────────────────────
    app.post("/download-instrumental", async (req, res) => {
      try {
        const { song, artist, duration_ms } = req.body;
        const mp3Path = await downloadInstrumental(song, artist, duration_ms);
        const durationMs = await getAudioDuration(mp3Path);
        const id = path.basename(mp3Path, ".mp3");

        res.json({ id, path: mp3Path, duration_ms: durationMs });
      } catch (err) {
        console.error("Instrumental download error:", err);
        res.status(500).json({ error: err.message });
      }
    });

    // ── Prepare instrumental (SSE response — used by Premiere extension) ─
    app.post("/prepare-instrumental", async (req, res) => {
      const { song_name, artist, duration_ms } = req.body;

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const send = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      try {
        send({ message: "Searching for instrumental...", progress: 20 });
        const mp3Path = await downloadInstrumental(song_name, artist, duration_ms);
        send({ message: "Processing audio...", progress: 80 });
        const durationMs = await getAudioDuration(mp3Path);
        const id = path.basename(mp3Path, ".mp3");

        send({
          done: true,
          instrumental_id: id,
          duration_ms: durationMs,
          progress: 100,
        });
      } catch (err) {
        send({ error: err.message });
      }

      res.end();
    });

    // ── Serve instrumental audio ──────────────────────────────────────
    app.get("/serve-instrumental/:id", (req, res) => {
      // Look in both uploads and instrumentals dirs
      const candidates = [
        path.join(INSTRUMENTALS_DIR, `${req.params.id}.mp3`),
        path.join(UPLOADS_DIR, `${req.params.id}.mp3`),
        path.join(UPLOADS_DIR, `instr_${req.params.id}.mp3`),
      ];
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          return res.sendFile(p);
        }
      }
      // Try glob match
      const files = fs.readdirSync(UPLOADS_DIR).filter(
        (f) => f.includes(req.params.id) && f.endsWith(".mp3")
      );
      if (files.length > 0) {
        return res.sendFile(path.join(UPLOADS_DIR, files[0]));
      }
      res.status(404).json({ error: "Instrumental not found" });
    });

    // ── Export video with music ───────────────────────────────────────
    app.post("/export", async (req, res) => {
      try {
        const { video_path, audio_path, audio_id, start_ms, video_vol, music_vol } = req.body;

        // Resolve audio path from ID if needed
        let resolvedAudioPath = audio_path;
        if (!resolvedAudioPath && audio_id) {
          // Search for the instrumental mp3 by ID
          const candidates = [
            path.join(UPLOADS_DIR, `${audio_id}.mp3`),
            path.join(UPLOADS_DIR, `instr_${audio_id}.mp3`),
            path.join(INSTRUMENTALS_DIR, `${audio_id}.mp3`),
          ];
          for (const p of candidates) {
            if (fs.existsSync(p)) { resolvedAudioPath = p; break; }
          }
          if (!resolvedAudioPath) {
            // Glob match
            const files = fs.readdirSync(UPLOADS_DIR).filter(
              (f) => f.includes(audio_id) && f.endsWith(".mp3")
            );
            if (files.length > 0) {
              resolvedAudioPath = path.join(UPLOADS_DIR, files[0]);
            }
          }
          if (!resolvedAudioPath) {
            return res.status(404).json({ error: "Instrumental audio not found" });
          }
        }

        const { exportId, outputPath } = await mixAndExport(
          video_path,
          resolvedAudioPath,
          start_ms,
          video_vol,
          music_vol
        );

        res.json({ id: exportId, path: outputPath });
      } catch (err) {
        console.error("Export error:", err);
        res.status(500).json({ error: err.message });
      }
    });

    // ── Serve exported video ──────────────────────────────────────────
    app.get("/exports/:id", (req, res) => {
      const filePath = path.join(EXPORTS_DIR, `${req.params.id}.mp4`);
      if (fs.existsSync(filePath)) {
        return res.sendFile(filePath);
      }
      res.status(404).json({ error: "Export not found" });
    });

    // ── Set environment variables (from renderer settings) ────────────
    app.post("/set-env", (req, res) => {
      const vars = req.body || {};
      for (const [key, value] of Object.entries(vars)) {
        if (value) {
          process.env[key] = value;
        }
      }
      // Reset clients so they pick up new keys
      try { require("./vibe-analyzer").resetClient(); } catch (_) {}
      res.json({ ok: true });
    });

    server = app.listen(port, "127.0.0.1", () => {
      resolve(port);
    });

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        // Try next port
        server = app.listen(port + 1, "127.0.0.1", () => {
          resolve(port + 1);
        });
      } else {
        reject(err);
      }
    });
  });
}

function stopServer() {
  if (server) {
    server.close();
    server = null;
  }
}

module.exports = { startServer, stopServer };
