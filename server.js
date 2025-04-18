/* ============================================================================
 * yt‑converter‑back ‑ main server
 * Updated: 2025‑04‑18
 * ‑ Adds ASCII‑safe twins for Demucs / torchaudio (fix Unicode path crash)
 * ‑ Final files keep original Arabic / emoji names
 * ==========================================================================*/
import express from "express";
import { exec } from "child_process";
import cors from "cors";
import morgan from "morgan";
import fs from "fs";
import path from "path";
import archiver from "archiver";
import pLimit from "p-limit";
import { transliterate } from "transliteration";

const app = express();
app.use(express.json());
app.use(cors());
app.use(morgan("dev"));

// ------------------------------------------------------------
// constants
// ------------------------------------------------------------
const DOWNLOAD_FOLDER = "downloads";
fs.mkdirSync(DOWNLOAD_FOLDER, { recursive: true });

// ------------------------------------------------------------
// utils
// ------------------------------------------------------------
function sanitizeFilenameForWindows(filename = "unnamed") {
  return (
    filename
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/[\x00-\x1f\x80-\x9f]/g, "_")
      .trim()
      .replace(/[_\s]+/g, "_")
      .slice(0, 250) || "unnamed"
  );
}
function toAsciiSafe(s) {
  return (
    transliterate(s)
      .replace(/[^\w.-]/g, "_")
      .replace(/_+/g, "_")
      .slice(0, 200) || "file"
  );
}
function ensureAsciiCopy(originalPath) {
  const dir = path.dirname(originalPath);
  const asciiBase = toAsciiSafe(path.basename(originalPath));
  if (asciiBase === path.basename(originalPath))
    return { asciiPath: originalPath, cleanup: () => {} };
  const asciiPath = path.join(dir, asciiBase);
  fs.copyFileSync(originalPath, asciiPath);
  return {
    asciiPath,
    cleanup: () => fs.existsSync(asciiPath) && fs.unlinkSync(asciiPath),
  };
}
// Revised dependency check: confirm demucs CLI + torchaudio backend
function checkPythonDependencies() {
  return new Promise((resolve) => {
    // 1) Is the demucs CLI accessible?
    exec("demucs --help", (cliErr) => {
      if (cliErr) {
        console.warn("[Deps] demucs CLI not in PATH");
        return resolve(false);
      }
      // 2) Does the same python have torchaudio + soundfile?
      const py = `python3 - <<'PY'
try:
 import torchaudio, soundfile; print('OK')
except Exception as e:
 print('FAIL')
PY`;
      exec(py, (pyErr, out) => {
        const ok = !pyErr && out.trim() === "OK";
        if (!ok) console.warn("[Deps] Python missing torchaudio or soundfile");
        resolve(ok);
      });
    });
  });
}
function getFilesRecursively(dir, out = []) {
  fs.readdirSync(dir).forEach((f) => {
    const p = path.join(dir, f);
    fs.statSync(p).isDirectory()
      ? getFilesRecursively(p, out)
      : p.endsWith(".mp3") && out.push(p);
  });
  return out;
}

// ----------------------------------------------------------------------------
// /fetch‑videos  (same as before, just uses sanitize helpers)
// ----------------------------------------------------------------------------
app.post("/fetch-videos", (req, res) => {
  const { channelUrl } = req.body;
  if (!channelUrl)
    return res.status(400).json({ error: "Channel URL is required" });

  const single = channelUrl.includes("watch?v=");
  const cmd = single
    ? `yt-dlp -j --no-playlist \"${channelUrl}\"`
    : `yt-dlp -j --flat-playlist \"${channelUrl}\"`;

  exec(cmd, (err, out) => {
    if (err) return res.status(500).json({ error: "Failed to fetch videos" });

    try {
      let vids = out
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
        .filter(
          (v) => v.title !== "[Deleted video]" && v.title !== "[Private video]"
        );
      if (single) vids = [vids[0]];

      vids = vids.map((v) => {
        const folderName = sanitizeFilenameForWindows(
          v.playlist_title || v.uploader || "default"
        );
        const originalFilename = `${v.title}_${v.id}.mp3`;
        return {
          id: v.id,
          title: v.title,
          url: `https://www.youtube.com/watch?v=${v.id}`,
          originalFilename: originalFilename.replace(/ /g, "_"),
          safeFilename: sanitizeFilenameForWindows(originalFilename).replace(
            / /g,
            "_"
          ),
          folderName: folderName.replace(/ /g, "_"),
          thumbnail: v.thumbnail || v.thumbnails?.[0]?.url || "",
        };
      });
      res.json({ videos: vids });
    } catch (e) {
      res.status(500).json({ error: "Error parsing video data" });
    }
  });
});

// ----------------------------------------------------------------------------
// list‑downloads
// ----------------------------------------------------------------------------
app.get("/list-downloads", (req, res) => {
  try {
    const files = getFilesRecursively(DOWNLOAD_FOLDER).map((f) =>
      path.relative(DOWNLOAD_FOLDER, f)
    );
    res.json({ files });
  } catch {
    res.status(500).json({ error: "Error listing downloaded files" });
  }
});

// ----------------------------------------------------------------------------
// download‑file & delete‑file
// ----------------------------------------------------------------------------
app.get("/download-file", (req, res) => {
  const { file } = req.query;
  const decoded = decodeURIComponent(file ?? "");
  const full = path.join(path.resolve(DOWNLOAD_FOLDER), decoded);
  if (!decoded || !full.startsWith(path.resolve(DOWNLOAD_FOLDER)))
    return res.status(400).json({ error: "Invalid file" });
  if (!fs.existsSync(full))
    return res.status(404).json({ error: "File not found" });
  res.download(full);
});

app.delete("/delete-file", (req, res) => {
  const { file } = req.query;
  const decoded = decodeURIComponent(file ?? "");
  const full = path.join(path.resolve(DOWNLOAD_FOLDER), decoded);
  if (!decoded || !full.startsWith(path.resolve(DOWNLOAD_FOLDER)))
    return res.status(400).json({ error: "Invalid file" });
  if (!fs.existsSync(full))
    return res.status(404).json({ error: "File not found" });
  fs.unlinkSync(full);
  res.json({ message: "File deleted successfully" });
});

// ----------------------------------------------------------------------------
// Core: /download-mp3  (Demucs with ASCII twin)
// ----------------------------------------------------------------------------

// ------------------------------------------------------------
// core endpoint: /download-mp3
// ------------------------------------------------------------
app.post("/download-mp3", async (req, res) => {
  const {
    videoUrl,
    originalFilename,
    safeFilename,
    folderName,
    startTime,
    endTime,
  } = req.body;
  if (!videoUrl || !originalFilename || !safeFilename || !folderName)
    return res.status(400).json({ error: "Missing required parameters" });

  const sub = path.join(DOWNLOAD_FOLDER, folderName);
  fs.mkdirSync(sub, { recursive: true });

  const finalFile = path.join(
    sub,
    sanitizeFilenameForWindows(originalFilename).replace(/ /g, "_")
  );
  let ytFile = path.join(sub, safeFilename);
  if (ytFile === finalFile) {
    const ext = path.extname(finalFile);
    ytFile = finalFile.replace(ext, `__src${ext}`); // ensure different name
  }
  if (fs.existsSync(finalFile))
    return res.json({ message: "Already downloaded", skipped: true });

  exec(
    `yt-dlp --restrict-filenames -x --audio-format mp3 -o \"${ytFile}\" \"${videoUrl}\"`,
    async (dlErr) => {
      if (dlErr) return res.status(500).json({ error: "MP3 download failed" });

      const deps = await checkPythonDependencies();
      if (!deps) return basicProcess();

      const { asciiPath, cleanup } = ensureAsciiCopy(ytFile);
      exec(
        `python demucs_wrapper.py --two-stems=vocals -o temp_output \"${asciiPath}\"`,
        (demErr) => {
          cleanup();
          if (demErr) return basicProcess();
          const vocals = path.join(
            "temp_output",
            "htdemucs",
            path.basename(asciiPath, ".mp3"),
            "vocals.wav"
          );
          if (!fs.existsSync(vocals)) return basicProcess();
          runFfmpeg(vocals, true);
        }
      );
    }
  );

  function basicProcess() {
    runFfmpeg(ytFile, false);
  }

  function runFfmpeg(inputPath, removeTempOut) {
    const tmpOut = finalFile + "__tmp.mp3";
    const filters = removeTempOut
      ? [
          "silenceremove=stop_threshold=-50dB:stop_duration=0.1:start_threshold=-50dB:start_periods=1",
          "silenceremove=stop_threshold=0:stop_duration=0.1:start_threshold=0:start_duration=0.1",
          "afftdn",
          "acompressor",
          "volume=10dB",
          "aresample=96000",
        ].join(",")
      : "volume=2,afftdn,acompressor";

    const time =
      typeof startTime === "number" && typeof endTime === "number"
        ? `-ss ${startTime} -to ${endTime}`
        : "";
    exec(
      `ffmpeg ${time} -i \"${inputPath}\" -af \"${filters}\" -c:a libmp3lame -b:a 64k -y \"${tmpOut}\"`,
      (e) => {
        if (e)
          return res.status(500).json({ error: "Audio processing failed" });
        fs.renameSync(tmpOut, finalFile);
        inputPath !== ytFile ||
          (fs.existsSync(ytFile) && fs.unlinkSync(ytFile));
        fs.existsSync("temp_output") &&
          fs.rmSync("temp_output", { recursive: true, force: true });
        return res.json({
          message: "Done",
          file: path
            .join(folderName, path.basename(finalFile))
            .replace(/\\/g, "/"),
          skipped: false,
        });
      }
    );
  }
});

// ----------------------------------------------------------------------------
// /process-external-audio  (same ASCII‑twin logic)
// ----------------------------------------------------------------------------
app.post("/process-external-audio", async (req, res) => {
  const { url, filename } = req.body;
  if (!url) return res.status(400).json({ error: "URL is required" });

  const provided = filename || path.basename(url).split("?")[0];
  const safeName = sanitizeFilenameForWindows(provided).replace(/ /g, "_");
  const sub = path.join(DOWNLOAD_FOLDER, "external_audio");
  fs.mkdirSync(sub, { recursive: true });

  const downloadPath = path.join(sub, `original_${safeName}`);
  const finalFile = path.join(sub, safeName.replace(/\.\w+$/, "") + ".mp3");
  if (fs.existsSync(finalFile))
    return res.json({ message: "Already processed", skipped: true });

  exec(`curl -L \"${url}\" -o \"${downloadPath}\"`, async (dlErr) => {
    if (dlErr)
      return res.status(500).json({ error: "Failed to download file" });

    const src = downloadPath.endsWith(".mp3")
      ? downloadPath
      : await convertToMp3(downloadPath);
    const haveDeps = await checkPythonDependencies();
    if (!haveDeps) return basic(src);

    const { asciiPath, cleanup } = ensureAsciiCopy(src);
    const asciiBase = path.basename(asciiPath, ".mp3");
    exec(
      `python demucs_wrapper.py --two-stems=vocals -o temp_output \"${asciiPath}\"`,
      (demErr) => {
        cleanup();
        if (demErr) return basic(src);

        const vocals = path.join(
          "temp_output",
          "htdemucs",
          asciiBase,
          "vocals.wav"
        );
        const filters =
          "silenceremove=stop_threshold=-50dB:stop_duration=0.1:start_threshold=-50dB:start_periods=1,afftdn,acompressor,volume=10dB";
        exec(
          `ffmpeg -i \"${vocals}\" -af \"${filters}\" -c:a libmp3lame -b:a 64k -y \"${finalFile}\"`,
          (ffErr) => {
            if (ffErr) return basic(src);
            cleanupDemucs();
            success();
          }
        );
      }
    );

    /* helpers */
    function convertToMp3(inp) {
      return new Promise((resolve, reject) => {
        const tmp = path.join(
          sub,
          "tmp_" + path.basename(inp, path.extname(inp)) + ".mp3"
        );
        exec(`ffmpeg -i \"${inp}\" -vn -acodec libmp3lame -y \"${tmp}\"`, (e) =>
          e ? reject(e) : resolve(tmp)
        );
      });
    }
    function basic(srcPath) {
      exec(
        `ffmpeg -i \"${srcPath}\" -af \"volume=2,afftdn,acompressor\" -c:a libmp3lame -b:a 64k -y \"${finalFile}\"`,
        (e) => (e ? fail() : success())
      );
    }
    function cleanupDemucs() {
      fs.existsSync("temp_output") &&
        fs.rmSync("temp_output", { recursive: true, force: true });
    }
    function success() {
      const rel = path
        .join("external_audio", path.basename(finalFile))
        .replace(/\\/g, "/");
      res.json({ message: "Processed", file: rel, skipped: false });
    }
    function fail() {
      res.status(500).json({ error: "Audio processing failed" });
    }
  });
});

// ----------------------------------------------------------------------------
// download-mp3-simple  (unchanged)
// ----------------------------------------------------------------------------
app.post("/download-mp3-simple", (req, res) => {
  const { videoUrl, originalFilename, safeFilename, folderName } = req.body;
  if (!videoUrl || !originalFilename || !safeFilename || !folderName)
    return res.status(400).json({ error: "Missing required parameters" });

  const sub = path.join(DOWNLOAD_FOLDER, folderName);
  fs.mkdirSync(sub, { recursive: true });

  const finalFile = path.join(
    sub,
    sanitizeFilenameForWindows(originalFilename).replace(/ /g, "_")
  );
  const ytFile = path.join(sub, safeFilename);
  if (fs.existsSync(finalFile))
    return res.json({ message: "Already downloaded", skipped: true });

  exec(
    `yt-dlp --restrict-filenames -x --audio-format mp3 -o \"${ytFile}\" \"${videoUrl}\"`,
    (dlErr) => {
      if (dlErr) return res.status(500).json({ error: "MP3 Download failed" });
      const tmp = finalFile.replace(/\.mp3$/, "_temp.mp3");
      exec(
        `ffmpeg -i \"${ytFile}\" -b:a 64k -c:a libmp3lame -y \"${tmp}\"`,
        (ffErr) => {
          if (ffErr)
            return res.status(500).json({ error: "Compression failed" });
          fs.renameSync(tmp, finalFile);
          ytFile !== finalFile &&
            fs.existsSync(ytFile) &&
            fs.unlinkSync(ytFile);
          const rel = path
            .join(folderName, path.basename(finalFile))
            .replace(/\\/g, "/");
          res.json({ message: "Downloaded", file: rel, skipped: false });
        }
      );
    }
  );
});

// ----------------------------------------------------------------------------
// batch‑download‑mp3  (uses downloadAndProcessMp3 helper)
// ----------------------------------------------------------------------------
const limit = pLimit(1);
app.post("/batch-download-mp3", async (req, res) => {
  const { videos } = req.body;
  if (!Array.isArray(videos) || !videos.length)
    return res.status(400).json({ error: "No videos provided" });

  const paths = (
    await Promise.all(videos.map((v) => limit(() => downloadAndProcessMp3(v))))
  ).filter(Boolean);
  if (!paths.length)
    return res.status(500).json({ error: "No MP3s could be downloaded." });

  const zipDir = path.join(DOWNLOAD_FOLDER, "tmp");
  fs.mkdirSync(zipDir, { recursive: true });
  const zipPath = path.join(zipDir, `batch_${Date.now()}.zip`);

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.pipe(output);
    paths.forEach(
      (p) => fs.existsSync(p) && archive.file(p, { name: path.basename(p) })
    );
    archive.finalize();
    output.on("close", resolve).on("error", reject);
  });

  const relZip = path.relative(DOWNLOAD_FOLDER, zipPath).replace(/\\/g, "/");
  res.json({ message: "Batch complete", file: relZip, skipped: true });
});

/* Helper used above ------------------------------------------------------------------*/
async function downloadAndProcessMp3({
  videoUrl,
  originalFilename,
  safeFilename,
  folderName,
  startTime,
  endTime,
}) {
  return new Promise(async (resolve) => {
    const sub = path.join(DOWNLOAD_FOLDER, folderName);
    fs.mkdirSync(sub, { recursive: true });

    const finalFile = path.join(
      sub,
      sanitizeFilenameForWindows(originalFilename).replace(/ /g, "_")
    );
    if (fs.existsSync(finalFile)) return resolve(finalFile);

    const ytFile = path.join(sub, safeFilename);
    exec(
      `yt-dlp --restrict-filenames -x --audio-format mp3 -o \"${ytFile}\" \"${videoUrl}\"`,
      async (err) => {
        if (err) return resolve(null);
        const deps = await checkPythonDependencies();
        if (!deps) return basic();

        const { asciiPath, cleanup } = ensureAsciiCopy(ytFile);
        const asciiBase = path.basename(asciiPath, ".mp3");
        exec(
          `python demucs_wrapper.py --two-stems=vocals -o temp_output \"${asciiPath}\"`,
          (demErr) => {
            cleanup();
            if (demErr) return basic();

            const vocals = path.join(
              "temp_output",
              "htdemucs",
              asciiBase,
              "vocals.wav"
            );
            exec(
              `ffmpeg -i \"${vocals}\" -af \"afftdn,acompressor\" -c:a libmp3lame -b:a 64k -y \"${finalFile}\"`,
              (ffErr) => {
                if (ffErr) return basic();
                fs.rmSync("temp_output", { recursive: true, force: true });
                return resolve(finalFile);
              }
            );
          }
        );

        function basic() {
          exec(
            `ffmpeg -i \"${ytFile}\" -af \"afftdn,acompressor\" -c:a libmp3lame -b:a 64k -y \"${finalFile}\"`,
            (e) => resolve(e ? null : finalFile)
          );
        }
      }
    );
  });
}

// ----------------------------------------------------------------------------
// Start server
// ----------------------------------------------------------------------------
app.listen(8001, () => {
  console.log("Server running on port 8001");
  console.log("Requires: pip install torchaudio demucs transliteration");
  console.log(
    "pip install --upgrade \
    torch==2.6.0 \
    torchaudio==2.6.0 \
    demucs==4.0.1 \
    soundfile \
    transliteration"
  );
});
