import express from "express";
import { exec } from "child_process";
import cors from "cors";
import morgan from "morgan";
import fs from "fs";
import path from "path";
import archiver from "archiver";
import pLimit from "p-limit"; // ✅ Now works!

const app = express();
app.use(express.json());

// Middleware to fix double extension issues (e.g. ".mp3.mp3")
app.use((req, res, next) => {
  const originalJson = res.json;
  res.json = function (data) {
    if (data && data.filename && data.filename.endsWith(".mp3.mp3")) {
      data.filename = data.filename.replace(/\.mp3\.mp3$/, ".mp3");
    }
    return originalJson.call(this, data);
  };
  next();
});
app.use(cors());
app.use(morgan("dev"));

const DOWNLOAD_FOLDER = "downloads";
if (!fs.existsSync(DOWNLOAD_FOLDER)) {
  fs.mkdirSync(DOWNLOAD_FOLDER);
}

// Enhanced sanitizer: removes forbidden characters while preserving non-ASCII characters.
function sanitizeFilenameForWindows(filename) {
  return filename.replace(/[\\/:*?"<>|]/g, "").trim();
}

// FETCH VIDEOS: returns video objects with consistent file naming.
// The folderName is based on the playlist title (if available) or uploader.
app.post("/fetch-videos", (req, res) => {
  const { channelUrl } = req.body;
  if (!channelUrl) {
    return res.status(400).json({ error: "Channel URL is required" });
  }

  // If it's a single video, extract full metadata
  const isSingleVideo = channelUrl.includes("watch?v=");
  const ytCommand = isSingleVideo
    ? `yt-dlp -j --no-playlist "${channelUrl}"`
    : `yt-dlp -j --flat-playlist "${channelUrl}"`;

  exec(ytCommand, (error, stdout) => {
    if (error) {
      console.log(error);
      return res.status(500).json({ error: "Failed to fetch videos" });
    }
    try {
      let videos = stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter(
          (video) =>
            video.title !== "[Deleted video]" &&
            video.title !== "[Private video]"
        );

      if (isSingleVideo) {
        const video = videos[0]; // Get the single video
        const folderName = sanitizeFilenameForWindows(
          video.uploader || "SingleVideo"
        );
        const originalFilename = `${video.title}_${video.id}.mp3`;
        const safeFilename = sanitizeFilenameForWindows(
          originalFilename
        ).replace(/ /g, "_");

        return res.json({
          videos: [
            {
              id: video.id,
              title: video.title,
              url: `https://www.youtube.com/watch?v=${video.id}`,
              originalFilename: originalFilename.replace(/ /g, "_"),
              safeFilename,
              folderName: folderName.replace(/ /g, "_"),
              thumbnail:
                video.thumbnail ||
                (video.thumbnails && video.thumbnails[0]?.url) ||
                "",
            },
          ],
        });
      }

      videos = videos.map((video) => {
        const folderName = video.playlist_title
          ? sanitizeFilenameForWindows(video.playlist_title)
          : video.uploader
          ? sanitizeFilenameForWindows(video.uploader)
          : "default";

        const originalFilename = `${video.title}_${video.id}.mp3`;
        const safeFilename = sanitizeFilenameForWindows(
          originalFilename
        ).replace(/ /g, "_");

        return {
          id: video.id,
          title: video.title,
          url: `https://www.youtube.com/watch?v=${video.id}`,
          originalFilename: originalFilename.replace(/ /g, "_"),
          safeFilename,
          folderName: folderName.replace(/ /g, "_"),
          thumbnail:
            video.thumbnail ||
            (video.thumbnails && video.thumbnails[0]?.url) ||
            "",
        };
      });

      res.json({ videos });
    } catch (err) {
      res.status(500).json({ error: "Error parsing video data" });
    }
  });
});

// NEW Endpoint: List all downloaded MP3 files.
app.get("/list-downloads", (req, res) => {
  try {
    const files = getFilesRecursively(DOWNLOAD_FOLDER);
    const relativeFiles = files.map((file) =>
      path.relative(DOWNLOAD_FOLDER, file)
    );
    res.json({ files: relativeFiles });
  } catch (err) {
    res.status(500).json({ error: "Error listing downloaded files" });
  }
});

// Helper: Recursively get all MP3 files in a directory.
function getFilesRecursively(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  files.forEach((file) => {
    const filePath = path.join(dir, file);
    if (fs.statSync(filePath).isDirectory()) {
      getFilesRecursively(filePath, fileList);
    } else {
      if (filePath.endsWith(".mp3")) fileList.push(filePath);
    }
  });
  return fileList;
}

// NEW Endpoint: Download a specific file.
app.get("/download-file", (req, res) => {
  const relativePath = req.query.file;
  const decodedPath = decodeURIComponent(relativePath);
  if (!decodedPath) return res.status(400).json({ error: "No file specified" });
  const filePath = path.join(path.resolve(DOWNLOAD_FOLDER), decodedPath);
  if (!filePath.startsWith(path.resolve(DOWNLOAD_FOLDER))) {
    return res.status(400).json({ error: "Invalid file path" });
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }
  res.download(filePath);
});

// NEW Endpoint: Delete a specific file.
app.delete("/delete-file", (req, res) => {
  const relativePath = req.query.file;
  const decodedPath = decodeURIComponent(relativePath);
  if (!decodedPath) return res.status(400).json({ error: "No file specified" });
  const filePath = path.join(path.resolve(DOWNLOAD_FOLDER), decodedPath);
  if (!filePath.startsWith(path.resolve(DOWNLOAD_FOLDER))) {
    return res.status(400).json({ error: "Invalid file path" });
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }
  try {
    fs.unlinkSync(filePath);
    res.json({ message: "File deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: "Error deleting file" });
  }
});

// Create a queue for processing downloads
app.post("/download-mp3", (req, res) => {
  const {
    videoUrl,
    originalFilename,
    safeFilename,
    folderName,
    startTime,
    endTime,
  } = req.body;

  if (!videoUrl || !originalFilename || !safeFilename || !folderName) {
    return res.status(400).json({ error: "Missing required parameters" });
  }

  // Create directory and build file paths
  const safeOriginalFilename = sanitizeFilenameForWindows(
    originalFilename
  ).replace(/ /g, "_");
  const subFolder = path.join(DOWNLOAD_FOLDER, folderName);
  if (!fs.existsSync(subFolder)) {
    fs.mkdirSync(subFolder, { recursive: true });
  }
  const safeFilePath = path.join(subFolder, safeFilename);
  const finalFilePath = path.join(subFolder, safeOriginalFilename);

  if (fs.existsSync(finalFilePath)) {
    return res.json({ message: "Already downloaded", skipped: true });
  }

  // Step 1: Download the MP3 using yt-dlp
  const downloadCommand = `yt-dlp --restrict-filenames -x --audio-format mp3 -o "${safeFilePath}" ${videoUrl}`;
  exec(downloadCommand, (downloadError, downloadStdout, downloadStderr) => {
    if (downloadError) {
      console.error("Download error:", downloadStderr);
      return res.status(500).json({ error: "MP3 Download failed" });
    }

    // Step 2: Run Demucs to separate vocals from accompaniment
    const execOptions = { env: { ...process.env, PYTHONIOENCODING: "utf-8" } };
    const baseName = path.basename(safeFilePath, ".mp3");

    // Example: Using Demucs 2-stem for vocals
    const demucsCommand = `python demucs_wrapper.py --two-stems=vocals -o "temp_output" "${safeFilePath}"`;

    exec(
      demucsCommand,
      execOptions,
      (demucsError, demucsStdout, demucsStderr) => {
        if (demucsError) {
          console.error("Demucs separation failed:", demucsStderr);
          return res.json({
            message: "Downloaded but vocal separation failed",
            skipped: false,
          });
        }

        // By default, Demucs will place the separated files under:
        // temp_output/htdemucs/<baseName>/vocals.wav and no_vocals.wav
        // Adjust as needed if you specify a different model
        const vocalsPath = path.join(
          "temp_output",
          "htdemucs",
          baseName,
          "vocals.wav"
        );

        // Build an enhanced filter chain:
        // 1. Silence removal (first pass)
        // 2. Silence removal (final pass)
        // 3. Noise reduction (afftdn)
        // 4. Dynamic range compression (acompressor)
        // 5. Increase volume +10dB
        // 6. Upsample to 96 kHz (aresample)
        let filterChain = [
          `silenceremove=stop_threshold=-50dB:stop_duration=0.1:start_threshold=-50dB:start_periods=1`,
          `silenceremove=stop_threshold=0:stop_duration=0.1:start_threshold=0:start_duration=0.1`,
          `afftdn`,
          `acompressor`,
          `volume=10dB`,
          `aresample=96000`,
        ].join(",");

        // Determine time flags – either a default duration or use start/stop if provided
        let timeFlags = `-t 120`; // default duration if no segment is specified
        const segmentSelected =
          typeof startTime === "number" && typeof endTime === "number";
        if (segmentSelected) {
          timeFlags = `-ss ${startTime} -to ${endTime}`;
        }

        // Step 3: Process the vocals with FFmpeg using the enhanced filter chain
        const ffmpegCommand =
          `ffmpeg ${timeFlags} -i "${vocalsPath}" -af "${filterChain}" -c:a libmp3lame -b:a 64k -y "${finalFilePath}"`.replace(
            /\s+/g,
            " "
          );

        exec(ffmpegCommand, (ffmpegError, ffmpegStdout, ffmpegStderr) => {
          if (ffmpegError) {
            console.error("Final ffmpeg processing error:", ffmpegStderr);
            return res.status(500).json({ error: "Audio processing failed" });
          }

          // Step 4: Cleanup – remove the Demucs temporary folder
          try {
            const demucsOutDir = path.join("temp_output", "htdemucs", baseName);
            if (fs.existsSync(demucsOutDir)) {
              fs.rmdirSync(demucsOutDir, { recursive: true });
            }
            const relativePath = path
              .join(folderName, safeOriginalFilename)
              .replace(/\\/g, "/");
            return res.json({
              message: "MP3 downloaded, vocals enhanced, and processed",
              file: relativePath,
              skipped: false,
            });
          } catch (cleanupErr) {
            console.error("Error during cleanup:", cleanupErr);
            return res
              .status(500)
              .json({ error: "Error finalizing audio file" });
          }
        });
      }
    );
  });
});

app.post("/download-mp3-simple", (req, res) => {
  const { videoUrl, originalFilename, safeFilename, folderName } = req.body;

  if (!videoUrl || !originalFilename || !safeFilename || !folderName) {
    return res.status(400).json({ error: "Missing required parameters" });
  }

  // Create directory, build paths
  const safeOriginalFilename = sanitizeFilenameForWindows(
    originalFilename
  ).replace(/ /g, "_");
  const subFolder = path.join(DOWNLOAD_FOLDER, folderName);
  if (!fs.existsSync(subFolder)) {
    fs.mkdirSync(subFolder, { recursive: true });
  }
  const safeFilePath = path.join(subFolder, safeFilename);
  const finalFilePath = path.join(subFolder, safeOriginalFilename);

  if (fs.existsSync(finalFilePath)) {
    return res.json({ message: "Already downloaded", skipped: true });
  }

  // Download the MP3 using yt-dlp
  const downloadCommand = `yt-dlp --restrict-filenames -x --audio-format mp3 -o "${safeFilePath}" ${videoUrl}`;
  exec(downloadCommand, (downloadError, downloadStdout, downloadStderr) => {
    if (downloadError) {
      console.error("Download error:", downloadStderr);
      return res.status(500).json({ error: "MP3 Download failed" });
    }

    // Compress the MP3 to 64k bitrate
    const tempFilePath = finalFilePath.replace(".mp3", "_temp.mp3");

    const compressionCommand = `
      ffmpeg -i "${safeFilePath.replace(/\\/g, "/")}" 
      -b:a 64k -c:a libmp3lame 
      -y "${tempFilePath.replace(/\\/g, "/")}"
    `.replace(/\s+/g, " ");

    exec(compressionCommand, (ffmpegError, ffmpegStdout, ffmpegStderr) => {
      if (ffmpegError) {
        console.error("Compression error:", ffmpegStderr);
        return res.status(500).json({ error: "MP3 Compression failed" });
      }

      try {
        // Ensure temp file exists before renaming
        if (!fs.existsSync(tempFilePath)) {
          return res
            .status(500)
            .json({ error: "Compression failed: temp file missing" });
        }

        // Rename temp file to final filename
        fs.renameSync(tempFilePath, finalFilePath);

        // Only delete the original file if it's different from the final output
        if (safeFilePath !== finalFilePath && fs.existsSync(safeFilePath)) {
          fs.unlinkSync(safeFilePath);
        }

        const relativePath = path
          .join(folderName, safeOriginalFilename)
          .replace(/\\/g, "/");
        return res.json({
          message: "MP3 downloaded and compressed",
          file: relativePath,
          skipped: false,
        });
      } catch (cleanupErr) {
        console.error("Cleanup error:", cleanupErr);
        return res.status(500).json({ error: "Error finalizing MP3 file" });
      }
    });
  });
});

// Helper function for single MP3 download & process
async function downloadAndProcessMp3({
  videoUrl,
  originalFilename,
  safeFilename,
  folderName,
  startTime,
  endTime,
}) {
  return new Promise((resolve) => {
    const safeOriginalFilename = sanitizeFilenameForWindows(
      originalFilename
    ).replace(/ /g, "_");
    const subFolder = path.join(DOWNLOAD_FOLDER, folderName);
    if (!fs.existsSync(subFolder)) {
      fs.mkdirSync(subFolder, { recursive: true });
    }
    const safeFilePath = path.join(subFolder, safeFilename);
    const finalFilePath = path.join(subFolder, safeOriginalFilename);

    if (fs.existsSync(finalFilePath)) {
      console.log(`Skipping ${safeOriginalFilename}, already downloaded.`);
      return resolve(finalFilePath);
    }

    // Step A: Download
    const downloadCommand = `yt-dlp --restrict-filenames -x --audio-format mp3 -o "${safeFilePath}" ${videoUrl}`;
    exec(downloadCommand, (downloadError, downloadStdout, downloadStderr) => {
      if (downloadError || downloadStderr.includes("Video unavailable")) {
        console.warn(`Skipping ${safeOriginalFilename}: Video unavailable.`);
        return resolve(null); // Instead of rejecting, we return null.
      }

      // Step B: Demucs
      const execOptions = {
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      };
      const baseName = path.basename(safeFilePath, ".mp3");
      const demucsCommand = `python demucs_wrapper.py --two-stems=vocals -o "temp_output" "${safeFilePath}"`;

      exec(demucsCommand, execOptions, (demucsError) => {
        if (demucsError) {
          console.warn(
            `Skipping ${safeOriginalFilename}: Vocal separation failed.`
          );
          return resolve(null);
        }

        // Step C: FFmpeg chain (using vocals.wav from Demucs)
        const vocalsPath = path.join(
          "temp_output",
          "htdemucs",
          baseName,
          "vocals.wav"
        );

        let timeFlags = `-t 90`;
        let filterChain =
          `silenceremove=stop_threshold=-50dB:stop_duration=0.1:start_threshold=-50dB:start_periods=1,` +
          `silenceremove=stop_threshold=0:stop_duration=0.1:start_threshold=0:start_duration=0.1`;

        const segmentSelected =
          typeof startTime === "number" && typeof endTime === "number";
        if (segmentSelected) {
          timeFlags = `-ss ${startTime} -to ${endTime}`;
        }

        const ffmpegCommand = `
          ffmpeg ${timeFlags} -i "${vocalsPath}" 
          -af "${filterChain}" 
          -c:a libmp3lame -b:a 64k 
          -y "${finalFilePath}"
        `.replace(/\s+/g, " ");

        exec(ffmpegCommand, (ffmpegError) => {
          if (ffmpegError) {
            console.warn(
              `Skipping ${safeOriginalFilename}: Audio processing failed.`
            );
            return resolve(null);
          }

          // Step D: Cleanup
          try {
            const demucsOutDir = path.join("temp_output", "htdemucs", baseName);
            if (fs.existsSync(demucsOutDir)) {
              fs.rmSync(demucsOutDir, { recursive: true, force: true });
            }
          } catch (cleanupErr) {
            console.error("Cleanup error:", cleanupErr);
          }

          return resolve(finalFilePath);
        });
      });
    });
  });
}

const limit = pLimit(1); // Limit concurrency if needed
app.post("/batch-download-mp3", async (req, res) => {
  try {
    const { videos } = req.body;
    if (!Array.isArray(videos) || videos.length === 0) {
      return res.status(400).json({ error: "No videos provided" });
    }

    // Limit concurrent downloads to avoid overloading CPU
    const downloadPromises = videos.map((vid) =>
      limit(() => downloadAndProcessMp3(vid))
    );

    // Wait for all downloads, allowing some failures (null values)
    let finalPaths = await Promise.all(downloadPromises);

    // Remove failed downloads (null values)
    finalPaths = finalPaths.filter((filePath) => filePath !== null);

    // If all failed, return an error
    if (finalPaths.length === 0) {
      return res.status(500).json({ error: "No MP3s could be downloaded." });
    }

    // Proceed with zipping logic
    const timestamp = Date.now();
    const zipName = `batch_${timestamp}.zip`;
    const zipSubfolder = path.join(DOWNLOAD_FOLDER, "tmp");
    if (!fs.existsSync(zipSubfolder)) {
      fs.mkdirSync(zipSubfolder, { recursive: true });
    }
    const zipPath = path.join(zipSubfolder, zipName);

    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    archive.on("error", (err) => {
      throw err;
    });
    archive.pipe(output);

    // Add each successful MP3 to the ZIP
    finalPaths.forEach((mp3Path) => {
      if (fs.existsSync(mp3Path)) {
        archive.file(mp3Path, { name: path.basename(mp3Path) });
      }
    });

    await archive.finalize();

    const relativeZip = path
      .relative(DOWNLOAD_FOLDER, zipPath)
      .replace(/\\/g, "/");

    return res.json({
      message: "Batch MP3s downloaded & zipped",
      file: relativeZip,
      skipped: true, // Indicate some files were possibly skipped.
    });
  } catch (err) {
    console.error("Batch download error:", err);
    return res.status(500).json({ error: "Batch download failed" });
  }
});

app.listen(8001, () => console.log("Server running on port 8001"));
