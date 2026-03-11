/**
 * Resonance — Premiere Pro ExtendScript
 * Handles sequence info, export, and audio import/placement.
 */

// ── Sequence Info ───────────────────────────────────────────────────────

function getSequenceInfo() {
    var seq = app.project.activeSequence;
    if (!seq) {
        return JSON.stringify({ error: "No active sequence" });
    }

    var inPt  = seq.getInPointAsTime();
    var outPt = seq.getOutPointAsTime();
    var seqEnd = seq.end;

    // Premiere returns very large numbers when in/out are not set
    var inSec  = inPt.seconds;
    var outSec = outPt.seconds;
    var hasInOut = false;

    // If in > 0 or out < sequence end (with tolerance), in/out are set
    if (inSec > 0.1 || (outSec > 0 && outSec < (seqEnd - 0.1))) {
        hasInOut = true;
    }

    var rangeDuration = hasInOut ? (outSec - inSec) : seqEnd;

    return JSON.stringify({
        name:          seq.name,
        duration:      seqEnd,
        inPoint:       inSec,
        outPoint:      outSec,
        hasInOut:      hasInOut,
        rangeDuration: rangeDuration,
        videoTracks:   seq.videoTracks.numTracks,
        audioTracks:   seq.audioTracks.numTracks
    });
}


// ── Find H.264 Export Preset ────────────────────────────────────────────

function findExportPreset() {
    // H.264 codec UUIDs (varies by Adobe version)
    var h264Uuids = [
        "4E49434B_48323634",                   // Modern Premiere/AME (2022+)
        "4028B9D3-3B68-4D4A-B3F0-4EF792F3C4A7" // Legacy AME
    ];
    var fallback = null;

    // Search Adobe Media Encoder and Premiere Pro app bundles
    var appNames = [
        "Adobe Premiere Pro 2026", "Adobe Premiere Pro 2025",
        "Adobe Premiere Pro 2024", "Adobe Premiere Pro 2023",
        "Adobe Premiere Pro 2022", "Adobe Premiere Pro 2021",
        "Adobe Premiere Pro 2020",
        "Adobe Media Encoder 2026", "Adobe Media Encoder 2025",
        "Adobe Media Encoder 2024", "Adobe Media Encoder 2023",
        "Adobe Media Encoder 2022", "Adobe Media Encoder 2021",
        "Adobe Media Encoder 2020"
    ];

    for (var i = 0; i < appNames.length; i++) {
        var appFolder = new Folder("/Applications/" + appNames[i]);
        if (!appFolder.exists) continue;

        var bundles = appFolder.getFiles("*.app");
        for (var b = 0; b < bundles.length; b++) {
            for (var u = 0; u < h264Uuids.length; u++) {
                var presetDir = new Folder(
                    bundles[b].fsName + "/Contents/MediaIO/systempresets/" + h264Uuids[u]
                );
                if (!presetDir.exists) continue;

                var presets = presetDir.getFiles("*.epr");
                for (var p = 0; p < presets.length; p++) {
                    var name = presets[p].name.toLowerCase();
                    // Best: "Match Source - High bitrate"
                    if (name.indexOf("match source") >= 0 && name.indexOf("high") >= 0) {
                        return presets[p].fsName;
                    }
                    // Good: any "Match Source"
                    if (name.indexOf("match source") >= 0 && name.indexOf("medium") >= 0 && !fallback) {
                        fallback = presets[p].fsName;
                    }
                    if (name.indexOf("match source") >= 0 && !fallback) {
                        fallback = presets[p].fsName;
                    }
                    // Acceptable: any H.264 preset
                    if (!fallback) {
                        fallback = presets[p].fsName;
                    }
                }
            }

            // Also search ALL subfolders in systempresets for any .epr with H264/h264 in path
            if (!fallback) {
                var sysDir = new Folder(bundles[b].fsName + "/Contents/MediaIO/systempresets");
                if (sysDir.exists) {
                    var subDirs = sysDir.getFiles();
                    for (var sd = 0; sd < subDirs.length; sd++) {
                        if (!(subDirs[sd] instanceof Folder)) continue;
                        var subPresets = subDirs[sd].getFiles("*.epr");
                        for (var sp = 0; sp < subPresets.length; sp++) {
                            var spName = subPresets[sp].name.toLowerCase();
                            if (spName.indexOf("match source") >= 0 && spName.indexOf("high") >= 0) {
                                return subPresets[sp].fsName;
                            }
                            if (spName.indexOf("match source") >= 0 && !fallback) {
                                fallback = subPresets[sp].fsName;
                            }
                        }
                    }
                }
            }

            if (fallback) return fallback;
        }
    }

    return fallback || "";
}


// ── Export Sequence ─────────────────────────────────────────────────────

function exportSequence(outputPath, presetPath, useInOut) {
    var seq = app.project.activeSequence;
    if (!seq) {
        return JSON.stringify({ error: "No active sequence" });
    }

    if (!presetPath || presetPath === "") {
        presetPath = findExportPreset();
        if (!presetPath) {
            return JSON.stringify({
                error: "No H.264 export preset found. Please install Adobe Media Encoder."
            });
        }
    }

    var presetFile = new File(presetPath);
    if (!presetFile.exists) {
        return JSON.stringify({ error: "Preset file not found: " + presetPath });
    }

    var workArea = useInOut ? 1 : 0; // 1 = IN_TO_OUT, 0 = ENTIRE

    // Try direct export first (synchronous, no AME needed)
    try {
        var result = seq.exportAsMediaDirect(outputPath, presetPath, workArea);
        var outFile = new File(outputPath);
        if (outFile.exists && outFile.length > 0) {
            return JSON.stringify({
                success: true,
                method:  "direct",
                path:    outputPath
            });
        }
    } catch (e) {
        // Direct export not available or failed, try AME
    }

    // Fallback: export via Adobe Media Encoder
    try {
        app.encoder.launchEncoder();
        var jobId = app.encoder.encodeSequence(
            seq, outputPath, presetPath, workArea, 1
        );
        return JSON.stringify({
            success: true,
            method:  "ame",
            path:    outputPath,
            jobId:   String(jobId)
        });
    } catch (e) {
        return JSON.stringify({
            error: "Export failed: " + e.message
        });
    }
}


// ── Get Temp Folder ─────────────────────────────────────────────────────

function getTempFolder() {
    return Folder.temp.fsName;
}


// ── Get Project Folder (for saving instrumentals) ───────────────────────

function getProjectFolder() {
    if (app.project.path) {
        var projFile = new File(app.project.path);
        return projFile.parent.fsName;
    }
    return Folder.desktop.fsName;
}


// ── Import Audio and Place on Timeline ──────────────────────────────────

function importAndPlaceAudio(filePath, startTimeSeconds, trackIndex) {
    var seq = app.project.activeSequence;
    if (!seq) {
        return JSON.stringify({ error: "No active sequence" });
    }

    var audioFile = new File(filePath);
    if (!audioFile.exists) {
        return JSON.stringify({ error: "Audio file not found: " + filePath });
    }

    // Import file into project
    var importSuccess = app.project.importFiles(
        [filePath],
        true,              // suppress UI
        app.project.rootItem,
        false              // import as numbered stills = false
    );

    if (!importSuccess) {
        return JSON.stringify({ error: "Failed to import audio file" });
    }

    // Find the imported item (last child in root bin)
    var rootItem = app.project.rootItem;
    var imported = null;
    for (var i = rootItem.children.numItems - 1; i >= 0; i--) {
        var child = rootItem.children[i];
        if (child.name.indexOf(audioFile.displayName.replace(/\.[^.]+$/, "")) >= 0) {
            imported = child;
            break;
        }
    }

    if (!imported) {
        imported = rootItem.children[rootItem.children.numItems - 1];
    }

    // Determine target audio track
    var targetTrackIdx = (trackIndex !== undefined && trackIndex >= 0)
        ? trackIndex
        : -1;

    if (targetTrackIdx < 0) {
        // Find the first empty audio track, or use the last one
        for (var t = 0; t < seq.audioTracks.numTracks; t++) {
            if (seq.audioTracks[t].clips.numItems === 0) {
                targetTrackIdx = t;
                break;
            }
        }
        if (targetTrackIdx < 0) {
            targetTrackIdx = seq.audioTracks.numTracks - 1;
        }
    }

    var targetTrack = seq.audioTracks[targetTrackIdx];

    // Place at in-point or specified start time
    var startTime = startTimeSeconds || 0;
    if (startTime === 0 && seq.getInPointAsTime().seconds > 0.1) {
        startTime = seq.getInPointAsTime().seconds;
    }

    try {
        targetTrack.insertClip(imported, startTime);
    } catch (e) {
        return JSON.stringify({
            error: "Failed to place clip on timeline: " + e.message
        });
    }

    return JSON.stringify({
        success:   true,
        trackName: targetTrack.name,
        trackIndex: targetTrackIdx,
        startTime: startTime
    });
}


// ── Check if file exists (for polling) ──────────────────────────────────

function fileExists(filePath) {
    var f = new File(filePath);
    return JSON.stringify({
        exists: f.exists,
        size:   f.exists ? f.length : 0
    });
}
