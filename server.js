const express = require("express");
const { exec } = require("child_process");
const cors = require("cors");
const morgan = require("morgan");
const fs = require("fs");
const path = require("path");

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
  exec(`yt-dlp -j --flat-playlist "${channelUrl}"`, (error, stdout) => {
    if (error) {
      console.log(error);
      return res.status(500).json({ error: "Failed to fetch videos" });
    }
    try {
      const videos = stdout
        .trim()
        .split("\n")
        .filter((line) => {
          const video = JSON.parse(line);
          return (
            video.title !== "[Deleted video]" &&
            video.title !== "[Private video]"
          );
        })
        .map((line) => {
          const video = JSON.parse(line);
          const folderName = video.playlist_title
            ? sanitizeFilenameForWindows(video.playlist_title)
            : video.uploader
            ? sanitizeFilenameForWindows(video.uploader)
            : "default";
          // Build the filename as "<title>_<id>.mp3"
          const originalFilename = `${video.title}_${video.id}.mp3`;
          // Sanitize the filename and replace spaces with underscores.
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
              (video.thumbnails &&
                video.thumbnails[0] &&
                video.thumbnails[0].url) ||
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

// DOWNLOAD MP3: This endpoint downloads the video, processes it,
// and then saves the file using the consistent, sanitized naming scheme.
// app.post("/download-mp3", (req, res) => {
//   const {
//     videoUrl,
//     originalFilename,
//     safeFilename,
//     folderName,
//     startTime,
//     endTime,
//   } = req.body;
//   if (!videoUrl || !originalFilename || !safeFilename || !folderName) {
//     return res.status(400).json({ error: "Missing required parameters" });
//   }

//   // Sanitize the original filename and replace spaces with underscores.
//   const safeOriginalFilename = sanitizeFilenameForWindows(
//     originalFilename
//   ).replace(/ /g, "_");

//   const subFolder = path.join(DOWNLOAD_FOLDER, folderName);
//   if (!fs.existsSync(subFolder)) {
//     fs.mkdirSync(subFolder, { recursive: true });
//   }
//   const safeFilePath = path.join(subFolder, safeFilename);
//   const finalFilePath = path.join(subFolder, safeOriginalFilename);

//   if (fs.existsSync(finalFilePath)) {
//     return res.json({ message: "Already downloaded", skipped: true });
//   }

//   // Step 0: Download MP3 using yt-dlp.
//   const downloadCommand = `yt-dlp --restrict-filenames -x --audio-format mp3 -o "${safeFilePath}" ${videoUrl}`;
//   exec(downloadCommand, (downloadError, downloadStdout, downloadStderr) => {
//     if (downloadError) {
//       console.error("Download error:", downloadStderr);
//       return res.status(500).json({ error: "MP3 Download failed" });
//     }

//     const execOptions = {
//       env: { ...process.env, PYTHONIOENCODING: "utf-8" },
//     };

//     // Step 1: Run Spleeter separation directly on the downloaded MP3
//     const baseName = path.basename(safeFilePath, ".mp3");
//     const spleeterCommand1 = `py -3.10 -m spleeter separate -p spleeter:2stems -o "temp_output" "${safeFilePath}"`;
//     exec(
//       spleeterCommand1,
//       execOptions,
//       (spleeterError1, spleeterStdout1, spleeterStderr1) => {
//         if (spleeterError1) {
//           console.error("First Spleeter separation failed:", spleeterStderr1);
//           return res.json({
//             message: "Downloaded but vocal separation failed",
//             skipped: false,
//           });
//         }
//         const firstVocalsPath = path.join(
//           "temp_output",
//           baseName,
//           "vocals.wav"
//         );

//         // Step 2: Remove silence from the Spleeter output
//         const noSilenceFilePath = path.join(
//           subFolder,
//           `nosilence_${safeFilename}`
//         );
//         const silenceRemoveCommand = `ffmpeg -i "${firstVocalsPath}" -af "silenceremove=stop_threshold=-50dB:stop_duration=0.1:start_threshold=-50dB:start_periods=1" "${noSilenceFilePath}"`;
//         exec(
//           silenceRemoveCommand,
//           (silenceError, silenceStdout, silenceStderr) => {
//             if (silenceError) {
//               console.error("Silence removal error:", silenceStderr);
//               return res.status(500).json({ error: "Silence removal failed" });
//             }

//             // Step 3: Final trimming & compression
//             const segmentSelected =
//               typeof startTime === "number" && typeof endTime === "number";

//             const parsed = path.parse(finalFilePath);
//             const tempFinalPath = path.join(
//               parsed.dir,
//               parsed.name + "_temp" + parsed.ext
//             );
//             const finalNoSilencePath = path.join(
//               parsed.dir,
//               parsed.name + "_final" + parsed.ext
//             );

//             // Trim command varies based on whether segment is selected
//             let trimCommand;
//             if (segmentSelected) {
//               trimCommand = `ffmpeg -ss ${startTime} -to ${endTime} -i "${noSilenceFilePath}" -c:a libmp3lame -b:a 64k -y "${tempFinalPath}"`;
//             } else {
//               trimCommand = `ffmpeg -i "${noSilenceFilePath}" -t 45 -c:a libmp3lame -b:a 64k -y "${tempFinalPath}"`;
//             }

//             exec(trimCommand, (trimError, trimStdout, trimStderr) => {
//               if (trimError) {
//                 console.error("Trimming failed:", trimStderr);
//                 return res.status(500).json({ error: "Audio trimming failed" });
//               }

//               // Step 4: Final silence removal
//               const finalSilenceRemoveCommand = `ffmpeg -i "${tempFinalPath}" -af "silenceremove=stop_threshold=0:stop_duration=0.1:start_threshold=0:start_duration=0.1" -c:a libmp3lame -b:a 64k -y "${finalNoSilencePath}"`;
//               exec(
//                 finalSilenceRemoveCommand,
//                 (finalSilenceError, finalSilenceStdout, finalSilenceStderr) => {
//                   if (finalSilenceError) {
//                     console.error(
//                       "Final silence removal failed:",
//                       finalSilenceStderr
//                     );
//                     return res
//                       .status(500)
//                       .json({ error: "Final silence removal failed" });
//                   }

//                   // Cleanup and rename final file
//                   try {
//                     fs.renameSync(finalNoSilencePath, finalFilePath);
//                     if (fs.existsSync(tempFinalPath))
//                       fs.unlinkSync(tempFinalPath);
//                     if (fs.existsSync(noSilenceFilePath))
//                       fs.unlinkSync(noSilenceFilePath);
//                     if (fs.existsSync(firstVocalsPath))
//                       fs.unlinkSync(firstVocalsPath);
//                     if (fs.existsSync(path.join("temp_output", baseName)))
//                       fs.rmdirSync(path.join("temp_output", baseName), {
//                         recursive: true,
//                       });

//                     const relativePath = path
//                       .join(folderName, safeOriginalFilename)
//                       .replace(/\\/g, "/");

//                     return res.json({
//                       message: "MP3 downloaded, trimmed, and silence removed",
//                       file: relativePath,
//                       skipped: false,
//                     });
//                   } catch (err) {
//                     console.error("Error during file cleanup:", err);
//                     return res
//                       .status(500)
//                       .json({ error: "Error finalizing audio file" });
//                   }
//                 }
//               );
//             });
//           }
//         );
//       }
//     );
//   });
// });

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

  // 1) Create directory, build paths, etc.
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

  // 2) Download the MP3 (yt-dlp)
  const downloadCommand = `yt-dlp --restrict-filenames -x --audio-format mp3 -o "${safeFilePath}" ${videoUrl}`;
  exec(downloadCommand, (downloadError, downloadStdout, downloadStderr) => {
    if (downloadError) {
      console.error("Download error:", downloadStderr);
      return res.status(500).json({ error: "MP3 Download failed" });
    }

    // 3) Spleeter to separate vocals
    const execOptions = { env: { ...process.env, PYTHONIOENCODING: "utf-8" } };
    const baseName = path.basename(safeFilePath, ".mp3");
    const spleeterCommand = `py -3.10 -m spleeter separate -p spleeter:2stems -o "temp_output" "${safeFilePath}"`;

    exec(
      spleeterCommand,
      execOptions,
      (spleeterError, spleeterStdout, spleeterStderr) => {
        if (spleeterError) {
          console.error("Spleeter separation failed:", spleeterStderr);
          return res.json({
            message: "Downloaded but vocal separation failed",
            skipped: false,
          });
        }

        // Vocals output path from Spleeter:
        const vocalsPath = path.join("temp_output", baseName, "vocals.wav");

        // 4) Now do everything in ONE ffmpeg command:
        //    - First pass silence removal @ -50dB
        //    - Then (optionally) trim (ss/to or 45s)
        //    - Then final silence removal at 0 threshold
        //    - Compress to 64k MP3
        //
        // We’ll build the actual ffmpeg command conditionally:

        let timeFlags = `-t 45`; // default to 45s
        let filterChain = `silenceremove=stop_threshold=-50dB:stop_duration=0.1:start_threshold=-50dB:start_periods=1,silenceremove=stop_threshold=0:stop_duration=0.1:start_threshold=0:start_duration=0.1`;

        // If user specified startTime & endTime:
        const segmentSelected =
          typeof startTime === "number" && typeof endTime === "number";
        if (segmentSelected) {
          // Instead of limiting to 45s, we do -ss / -to:
          timeFlags = `-ss ${startTime} -to ${endTime}`;
        }

        // Construct final ffmpeg command:
        const ffmpegCommand = `
        ffmpeg ${timeFlags} -i "${vocalsPath}" 
        -af "${filterChain}" 
        -c:a libmp3lame -b:a 64k 
        -y "${finalFilePath}"
      `.replace(/\s+/g, " "); // flatten out whitespace

        exec(ffmpegCommand, (ffmpegError, ffmpegStdout, ffmpegStderr) => {
          if (ffmpegError) {
            console.error("Final ffmpeg processing error:", ffmpegStderr);
            return res.status(500).json({ error: "Audio processing failed" });
          }

          // 5) Cleanup — remove Spleeter folder + rename or remove original MP3 if desired
          try {
            // Remove entire Spleeter output subdir
            if (fs.existsSync(path.join("temp_output", baseName))) {
              fs.rmdirSync(path.join("temp_output", baseName), {
                recursive: true,
              });
            }
            // Optionally remove the original splitted MP3 if you don’t need it:
            // if (fs.existsSync(safeFilePath)) fs.unlinkSync(safeFilePath);

            // Build a relative path for the final file
            const relativePath = path
              .join(folderName, safeOriginalFilename)
              .replace(/\\/g, "/");

            return res.json({
              message: "MP3 downloaded, split, silence-removed, and trimmed",
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

app.listen(5000, () => console.log("Server running on port 5000"));
