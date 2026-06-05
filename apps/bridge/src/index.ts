// Sportly Bridge — beží v klube (alebo na Macu pri teste).
//
// Čo robí:
//   1. Pripojí sa na Sportly cloud cez WebSocket (odchádzajúce spojenie —
//      prejde cez klubový firewall/NAT)
//   2. Autentifikuje sa tokenom kamery
//   3. Posiela heartbeat každú minútu
//   4. (M1C-2) Vykonáva príkazy z cloudu na lokálnej kamere cez ISAPI
//   5. Pri výpadku spojenia sa automaticky znova pripojí
//
// Toto je len skeleton (M1C-1): handshake + heartbeat + auto-reconnect.

import { config as loadDotenv } from "dotenv";
import WebSocket from "ws";
import type {
  CloudToBridgeMessage,
  BridgeToCloudMessage,
} from "@sportly/shared";
import { createReadStream } from "node:fs";
import { mkdir, stat, unlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HikvisionClient } from "./camera/hikvision-client.js";
import { transcodeToWebMp4 } from "./camera/ffmpeg.js";
import {
  DEFAULT_TRACK_IDS,
  PANORAMA_TRACK_ID,
  TRACKING_TRACK_ID,
} from "./camera/types.js";

loadDotenv();

const CLOUD_WS_URL = process.env.CLOUD_WS_URL ?? "ws://localhost:3001/bridge";
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN ?? "";
// HTTP URL cloudu pre video upload — odvodené z WS URL (wss→https, ws→http)
const CLOUD_HTTP_URL = CLOUD_WS_URL.replace(/^ws/, "http").replace(/\/bridge$/, "");
const WORK_DIR = path.join(tmpdir(), "sportly-bridge");
const BRIDGE_VERSION = "0.1.0";
const HEARTBEAT_INTERVAL_MS = 60_000;
const RECONNECT_DELAY_MS = 5_000;

if (!BRIDGE_TOKEN) {
  console.error("❌ CHÝBA BRIDGE_TOKEN v .env. Získaj ho v Sportly admin.");
  process.exit(1);
}

let ws: WebSocket | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let cameraClient: HikvisionClient | null = null;

function log(...args: unknown[]): void {
  console.log(`[${new Date().toLocaleTimeString("sk-SK")}]`, ...args);
}

function send(msg: BridgeToCloudMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

/**
 * Stiahne jeden track z kamery, prekonvertuje na MP4, uploadne na cloud.
 * Vráti URL na cloude alebo null ak track nemá nahrávku.
 */
async function downloadTrackAndUpload(
  client: HikvisionClient,
  trackId: number,
  matchId: string,
  from: Date,
  to: Date,
  kind: "panorama" | "tracking",
): Promise<{ url: string; sizeBytes: number } | null> {
  // 1. Nájdi VŠETKY segmenty na tracku v časovom rozsahu zápasu.
  // Hik kamera rozdeľuje dlhé nahrávky na ~2-min segmenty po ~250 MB —
  // musíme stiahnuť všetky a spojiť (predtým sa sťahoval len jeden!).
  const searchFrom = new Date(from.getTime() - 60_000);
  const searchTo = new Date(to.getTime() + 60_000);
  const all = await client.searchRecordings({ from: searchFrom, to: searchTo, trackId });
  if (all.length === 0) {
    log(`   ⚠ Track ${trackId} (${kind}): žiadna nahrávka`);
    return null;
  }
  // Filtruj len segmenty čo majú prekrytie so [from, to], zoradené podľa času.
  const ms = from.getTime();
  const me = to.getTime();
  const segments = all
    .filter((r) => {
      const rs = new Date(r.startTime).getTime();
      const re = new Date(r.endTime).getTime();
      return re > ms && rs < me;
    })
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());

  if (segments.length === 0) {
    log(`   ⚠ Track ${trackId} (${kind}): žiadny segment v rozsahu zápasu`);
    return null;
  }

  await mkdir(WORK_DIR, { recursive: true });
  const segDir = path.join(WORK_DIR, `${matchId}-${kind}-segs`);
  await mkdir(segDir, { recursive: true });
  const mp4Path = path.join(WORK_DIR, `${matchId}-${kind}.mp4`);

  // 2. Stiahni VŠETKY segmenty z kamery (sériovo, aby sme kameru nepretazili).
  // Pri reštarte Bridge: preskočíme segmenty čo už máme stiahnuté na disku
  // (resume po zlyhaní / náhodnom dvojklike Upload).
  log(`   ⬇ Track ${trackId} (${kind}): sťahujem ${segments.length} segmentov z kamery…`);
  const segFiles: string[] = [];
  let skipped = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const f = path.join(segDir, `seg-${i.toString().padStart(4, "0")}.raw`);
    // Resume: ak existuje rozumne veľký súbor, predpokladáme že je hotový.
    try {
      const st = await stat(f);
      if (st.size > 100_000) {
        segFiles.push(f);
        skipped++;
        continue;
      }
    } catch {
      // súbor neexistuje, sťahujeme nižšie
    }
    try {
      await client.downloadRecording(seg.playbackURI, f);
      segFiles.push(f);
    } catch (err) {
      log(`     ⚠ segment ${i + 1}/${segments.length} zlyhal: ${(err as Error).message} — preskakujem`);
    }
  }
  if (skipped > 0) log(`   ↺ Resume: ${skipped} segmentov už bolo stiahnutých (preskočené)`);
  if (segFiles.length === 0) {
    await rm(segDir, { recursive: true, force: true }).catch(() => {});
    throw new Error("Žiadny segment sa nepodarilo stiahnuť");
  }
  log(`   ✓ Stiahnutých ${segFiles.length}/${segments.length} segmentov`);

  // 3. Vytvor concat list pre ffmpeg (každý riadok: file '/cesta/k/segmentu.raw')
  const concatList = path.join(segDir, "concat.txt");
  await writeFile(
    concatList,
    segFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"),
    "utf8",
  );

  // 4. Konverzia: ffmpeg spojí všetky segmenty + transkóduje v jednom prechode
  log(`   🎬 Track ${trackId} (${kind}): konvertujem ${segFiles.length} segmentov do jedného videa…`);
  await transcodeToWebMp4(concatList, mp4Path, { concat: true });
  // Vyčisti segmenty + concat list
  await rm(segDir, { recursive: true, force: true }).catch(() => {});

  // 4. Uploadni na cloud cez HTTP (streamované, nie do RAM)
  const stats = await stat(mp4Path);
  log(`   ☁ Track ${trackId} (${kind}): uploadujem na cloud (${(stats.size / 1024 / 1024).toFixed(1)} MB)…`);
  const uploadUrl = `${CLOUD_HTTP_URL}/api/bridge/upload?token=${encodeURIComponent(BRIDGE_TOKEN)}&matchId=${encodeURIComponent(matchId)}&kind=${kind}`;
  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "video/mp4", "Content-Length": String(stats.size) },
    body: createReadStream(mp4Path) as unknown as BodyInit,
    duplex: "half",
  } as RequestInit);
  await unlink(mp4Path).catch(() => {});

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Upload zlyhal (HTTP ${res.status}): ${txt}`);
  }
  const body = (await res.json()) as { url: string; sizeBytes: number };
  log(`   ✓ Track ${trackId} (${kind}): hotové → ${body.url}`);
  return body;
}

/**
 * Stiahne OBA tracky (panorama 101 + AI tracking 201) pre zápas a uploadne.
 */
async function handleDownload(
  client: HikvisionClient,
  matchId: string,
  fromIso: string,
  toIso: string,
): Promise<{ panorama: unknown; tracking: unknown }> {
  if (!matchId || !fromIso || !toIso) {
    throw new Error("Chýba matchId / from / to pre download");
  }
  const from = new Date(fromIso);
  const to = new Date(toIso);
  log(`📦 Download videa pre zápas ${matchId}`);

  // Postupne (nie paralelne) — Bridge na slabšom HW (RPi) by paralelný ffmpeg nezvládol
  const panorama = await downloadTrackAndUpload(client, PANORAMA_TRACK_ID, matchId, from, to, "panorama");
  const tracking = await downloadTrackAndUpload(client, TRACKING_TRACK_ID, matchId, from, to, "tracking");

  if (!panorama && !tracking) {
    throw new Error("Žiadna nahrávka pre tento zápas (ani panorama ani tracking)");
  }
  return { panorama, tracking };
}

/**
 * Vykoná príkaz z cloudu na lokálnej kamere cez ISAPI a pošle výsledok späť.
 * Toto beží v klube (Bridge je na rovnakej sieti ako kamera), takže ISAPI
 * volania idú lokálne = rýchle a spoľahlivé.
 */
async function handleCommand(
  commandId: string,
  action: string,
  params?: Record<string, unknown>,
): Promise<void> {
  log(`📥 Príkaz: ${action} (${commandId})`);
  if (!cameraClient) {
    send({ type: "result", commandId, ok: false, error: "Kamera nie je inicializovaná" });
    return;
  }

  try {
    let data: unknown;
    switch (action) {
      case "info":
        data = await cameraClient.getDeviceInfo();
        break;
      case "start": {
        // Spustíme nahrávanie oboch trackov (101 panorama + 201 AI tracking).
        // POZOR: Sport Mode Director sa NEspúšťa tu — len pri "director-start"
        // akcii ktorá sa volá pri spustení časovača. Dôvod: kamera nahráva
        // aj pred zápasom (nástup hráčov), ale AI sledovanie lopty má bežať
        // až keď zápas reálne začne.
        await cameraClient.startRecordingMulti(DEFAULT_TRACK_IDS);
        data = { started: true };
        break;
      }
      case "stop": {
        // Vypneme Sport Mode (best-effort) a zastavíme nahrávanie oboch trackov.
        let directorStopped = false;
        try {
          await cameraClient.stopMatchDirector();
          directorStopped = true;
        } catch (err) {
          log(`   ⚠ Sport Mode Director stop zlyhal: ${(err as Error).message}`);
        }
        await cameraClient.stopRecordingMulti(DEFAULT_TRACK_IDS);
        data = { stopped: true, directorStopped };
        break;
      }
      case "director-start": {
        // Zapne Sport Mode na kamere — PTZ začne sledovať loptu.
        // Volá sa keď klub klikne "Spustiť časovač" v Sportly (na začiatku
        // zápasu, NIE pred ním). Toto presne zodpovedá kliku "Spustiť" pri
        // Časovači hry v Hikvision web UI kamery.
        const initialTime = (params?.initialTime as string) ?? "0:00:00";
        await cameraClient.startMatchDirector(initialTime);
        data = { directorStarted: true, matchTime: initialTime };
        break;
      }
      case "director-stop": {
        // Vypne Sport Mode (best-effort).
        try {
          await cameraClient.stopMatchDirector();
        } catch (err) {
          log(`   ⚠ Director stop zlyhal: ${(err as Error).message}`);
        }
        data = { directorStopped: true };
        break;
      }
      case "snapshot": {
        const channel = (params?.channel as number) ?? 101;
        const jpeg = await cameraClient.getSnapshot(channel);
        // JPEG pošleme ako base64 (malé snímky OK; veľké videá až M1C-3 cez HTTP)
        data = { jpegBase64: jpeg.toString("base64"), sizeBytes: jpeg.length };
        break;
      }
      case "reboot":
        await cameraClient.reboot();
        data = { rebooting: true };
        break;
      case "storage":
        data = await cameraClient.getStorageStatus();
        break;
      case "score": {
        // Sport Mode skóre: pridať body na kamere (overlay v živom videu).
        const team = String(params?.team ?? "");
        const points = Number(params?.points ?? 1);
        if (team !== "homeTeam" && team !== "awayTeam") {
          throw new Error(`Neplatný team: ${team} (očakávam "homeTeam" alebo "awayTeam")`);
        }
        await cameraClient.addMatchScore(team, points);
        data = { added: true, team, points };
        break;
      }
      case "isapi-proxy": {
        // HTTP tunnel cez Bridge na lokálnu kameru.
        // Sportly admin → cloud → Bridge → Hikvision web UI / ISAPI.
        // Umožňuje Dávidovi kalibrovať ihrisko a robiť advanced nastavenia
        // bez fyzickej návštevy klubu.
        const proxyMethod = String(params?.method ?? "GET");
        const proxyPath = String(params?.path ?? "/");
        const proxyBody = params?.body as string | undefined;
        const proxyHeaders = (params?.headers ?? {}) as Record<string, string>;

        // URL na kameru
        const targetUrl = `http://${process.env.CAMERA_HOST ?? "192.168.1.86"}${proxyPath}`;

        try {
          // Použi cameraClient internal fetch (digest auth handled)
          const camResponse = await (cameraClient as any).client.fetch(targetUrl, {
            method: proxyMethod,
            headers: proxyHeaders,
            body: proxyBody,
          });
          const buf = await camResponse.arrayBuffer();
          const responseHeaders: Record<string, string> = {};
          camResponse.headers.forEach((v: string, k: string) => {
            responseHeaders[k] = v;
          });
          data = {
            status: camResponse.status,
            headers: responseHeaders,
            // Binary-safe: base64 encoding
            bodyBase64: Buffer.from(buf).toString("base64"),
            contentType: camResponse.headers.get("content-type") ?? "application/octet-stream",
          };
        } catch (err) {
          data = {
            status: 502,
            headers: {},
            bodyBase64: Buffer.from(`Bridge proxy error: ${(err as Error).message}`).toString("base64"),
            contentType: "text/plain",
          };
        }
        break;
      }
      case "download":
        // Stiahne oba tracky z kamery (lokálne), prekonvertuje, uploadne na cloud
        data = await handleDownload(
          cameraClient,
          String(params?.matchId ?? ""),
          String(params?.from ?? ""),
          String(params?.to ?? ""),
        );
        break;
      default:
        send({ type: "result", commandId, ok: false, error: `Neznámy príkaz: ${action}` });
        return;
    }
    send({ type: "result", commandId, ok: true, data });
    log(`   ✓ ${action} hotové`);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    send({ type: "result", commandId, ok: false, error });
    log(`   ✗ ${action} zlyhalo: ${error}`);
  }
}

function connect(): void {
  log(`Pripájam sa na cloud: ${CLOUD_WS_URL}`);
  ws = new WebSocket(CLOUD_WS_URL);

  ws.on("open", () => {
    log("✓ Spojenie otvorené, posielam auth…");
    send({ type: "auth", token: BRIDGE_TOKEN, bridgeVersion: BRIDGE_VERSION });
  });

  ws.on("message", (raw) => {
    let msg: CloudToBridgeMessage;
    try {
      msg = JSON.parse(String(raw)) as CloudToBridgeMessage;
    } catch {
      return;
    }

    switch (msg.type) {
      case "auth.ok":
        cameraClient = new HikvisionClient({
          host: msg.cameraConfig.host,
          port: msg.cameraConfig.port,
          protocol: msg.cameraConfig.protocol,
          username: msg.cameraConfig.username,
          password: msg.cameraConfig.password,
        });
        log(
          `✓ Autentifikovaný! Kamera ${msg.cameraId} (klub ${msg.clubId}) @ ${msg.cameraConfig.host}`,
        );
        log("🟢 Bridge je ONLINE — cloud teraz vidí túto kameru");
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(() => {
          send({ type: "heartbeat" });
        }, HEARTBEAT_INTERVAL_MS);
        break;

      case "auth.fail":
        log(`❌ Autentifikácia zlyhala: ${msg.reason}`);
        ws?.close();
        break;

      case "command":
        void handleCommand(msg.commandId, msg.action, msg.params);
        break;
    }
  });

  ws.on("close", (code) => {
    log(`Spojenie zatvorené (kód ${code}). Pripojím sa znova za ${RECONNECT_DELAY_MS / 1000}s…`);
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    cameraClient = null;
    setTimeout(connect, RECONNECT_DELAY_MS);
  });

  ws.on("error", (err) => {
    log(`⚠ Chyba spojenia: ${err.message}`);
    // close handler sa postará o reconnect
  });
}

log("=== Sportly Bridge ===");
log(`Verzia: ${BRIDGE_VERSION}`);
connect();

// Graceful shutdown
process.on("SIGINT", () => {
  log("Vypínam Bridge…");
  ws?.close();
  process.exit(0);
});
