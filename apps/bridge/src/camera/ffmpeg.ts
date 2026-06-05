// Pomocné funkcie nad ffmpeg. Pre teraz potrebujeme len konverziu IMKH → MP4
// (bez transkódovania, len remux — rýchle, žiadna strata kvality).
//
// Predpokladáme že ffmpeg je v PATH (brew install ffmpeg). V produkcii bude
// v Docker image.

import { spawn } from "node:child_process";

export class FfmpegError extends Error {
  constructor(message: string, public readonly stderr: string) {
    super(message);
    this.name = "FfmpegError";
  }
}

/**
 * Generický runner pre ffmpeg s automatickým error handlingom.
 */
function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    proc.on("error", (err) => {
      reject(new FfmpegError(`ffmpeg spawn failed: ${err.message}`, stderr));
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new FfmpegError(`ffmpeg exited with code ${code}`, stderr));
    });
  });
}

/**
 * Remuxuje Hikvision IMKH súbor na štandardný MP4 BEZ transkódovania.
 * Veľmi rýchle (~1000× real-time), ale výstup zachováva pôvodné rozlíšenie
 * (7168×2160 HEVC pre PanoVu), ktoré browser nevie prehrať. Použitie:
 * archív, downloady, Sportnet upload (predpokladá že akceptuje HEVC).
 */
export async function remuxToMp4(inputPath: string, outputPath: string): Promise<void> {
  await runFfmpeg([
    "-y",
    "-i", inputPath,
    "-c", "copy",
    "-movflags", "+faststart",
    outputPath,
  ]);
}

/**
 * Transkóduje Hikvision IMKH na web-friendly MP4 (H.264 1080p + AAC).
 * Výsledok je univerzálne prehratiteľný v browseroch a oveľa menší
 * (typicky 5-10× menší než originál). Konverzia: ~3-5× rýchlejšia ako
 * real-time na Apple Silicon.
 *
 * Pre 90-min zápas:
 *   - Originál (8K HEVC):  ~6 GB
 *   - Web verzia (1080p):  ~500 MB
 *   - Konverzia:           ~15-25 minút
 */
export async function transcodeToWebMp4(
  inputPath: string,
  outputPath: string,
  options: { maxWidth?: number; crf?: number; preset?: string; concat?: boolean } = {},
): Promise<void> {
  const maxWidth = options.maxWidth ?? 1920;
  const crf = options.crf ?? 23;
  const preset = options.preset ?? "fast";

  // Concat mode: inputPath je súbor s "file '...'" riadkami pre ffmpeg concat demuxer.
  // Tým spojíme N segmentov z Hik kamery do jedného videa počas konverzie.
  const inputArgs = options.concat
    ? ["-f", "concat", "-safe", "0", "-i", inputPath]
    : ["-i", inputPath];

  await runFfmpeg([
    "-y",
    ...inputArgs,
    // Filter chain: scale + format na vynútenie yuv420p (limited color range).
    // Hikvision IMKH má často yuvj (full range), ktorý Chrome niekedy zobrazí čierne.
    "-vf", `scale=${maxWidth}:trunc(ow/a/2)*2,format=yuv420p`,
    "-c:v", "libx264",
    "-preset", preset,
    "-crf", String(crf),
    "-profile:v", "baseline", // maximálna kompatibilita (Safari, Chrome, iOS, Android)
    "-level", "4.0",
    "-color_range", "tv",
    "-colorspace", "bt709",
    "-color_primaries", "bt709",
    "-color_trc", "bt709",
    // Audio: AAC 128k
    "-c:a", "aac",
    "-b:a", "128k",
    // Web optimalizácia: hlavička na začiatok pre rýchle prehrávanie
    "-movflags", "+faststart",
    outputPath,
  ]);
}
