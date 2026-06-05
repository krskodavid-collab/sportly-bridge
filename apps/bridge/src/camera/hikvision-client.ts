// Hikvision ISAPI klient — komunikuje s kamerou cez HTTP/HTTPS s digest autentifikáciou.
//
// ISAPI = Internet Server API od Hikvision. Volania:
//   - GET  /ISAPI/System/deviceInfo                                → info o kamere
//   - GET  /ISAPI/System/status                                    → uptime, CPU, RAM
//   - GET  /ISAPI/ContentMgmt/record/profile/manual/tracks/{id}    → status nahrávania
//   - PUT  /ISAPI/ContentMgmt/record/control/manual/start/tracks/{id}  → spustí
//   - PUT  /ISAPI/ContentMgmt/record/control/manual/stop/tracks/{id}   → zastaví
//
// Všetky volania vracajú XML, preto použijeme fast-xml-parser na parsovanie.

import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import DigestClient from "digest-fetch";
import { XMLParser } from "fast-xml-parser";
import {
  CameraConfig,
  DeviceInfo,
  SystemStatus,
  RecordingStatus,
  RecordingItem,
  DEFAULT_TRACK_ID,
} from "./types.js";

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: true,
});

export class HikvisionError extends Error {
  constructor(
    message: string,
    public readonly httpStatus?: number,
    public readonly responseBody?: string,
  ) {
    super(message);
    this.name = "HikvisionError";
  }
}

export class HikvisionClient {
  private readonly client: DigestClient;
  private readonly baseUrl: string;

  constructor(private readonly config: CameraConfig) {
    this.client = new DigestClient(config.username, config.password, {
      algorithm: "MD5",
    });
    this.baseUrl = `${config.protocol}://${config.host}:${config.port}`;
  }

  // -------- Helper pre HTTP volania s digest auth + XML parsing --------

  private async request<T = unknown>(
    method: "GET" | "PUT" | "POST" | "DELETE",
    path: string,
    body?: string,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = {
      method,
      headers: body ? { "Content-Type": "application/xml" } : undefined,
      body,
    };

    let response: Response;
    try {
      response = (await this.client.fetch(url, init)) as Response;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new HikvisionError(`Nedostupná kamera (${this.baseUrl}): ${msg}`);
    }

    const text = await response.text();

    if (!response.ok) {
      throw new HikvisionError(
        `Kamera vrátila chybu ${response.status} na ${method} ${path}`,
        response.status,
        text,
      );
    }

    // ISAPI ResponseStatus XML obsahuje statusCode != 1 pri logickej chybe,
    // aj keď HTTP status je 200. Skontrolujeme to.
    if (text.includes("<ResponseStatus")) {
      const parsed = xmlParser.parse(text) as { ResponseStatus?: { statusCode?: number; statusString?: string; subStatusCode?: string } };
      const status = parsed.ResponseStatus;
      if (status?.statusCode !== undefined && status.statusCode !== 1) {
        throw new HikvisionError(
          `Kamera odmietla príkaz: ${status.statusString ?? "neznáma chyba"} (subCode: ${status.subStatusCode ?? "n/a"})`,
          response.status,
          text,
        );
      }
    }

    return xmlParser.parse(text) as T;
  }

  // -------- Verejné API --------

  /** Informácie o kamere: model, sériové číslo, firmware. */
  async getDeviceInfo(): Promise<DeviceInfo> {
    const raw = await this.request<{
      DeviceInfo: {
        deviceName?: string;
        deviceID?: string;
        model?: string;
        serialNumber?: string;
        firmwareVersion?: string;
        firmwareReleasedDate?: string;
        hardwareVersion?: string;
        macAddress?: string;
      };
    }>("GET", "/ISAPI/System/deviceInfo");

    const info = raw.DeviceInfo ?? {};
    return {
      deviceName: info.deviceName ?? "Unknown",
      deviceID: info.deviceID ?? "Unknown",
      model: info.model ?? "Unknown",
      serialNumber: info.serialNumber ?? "Unknown",
      firmwareVersion: info.firmwareVersion ?? "Unknown",
      firmwareReleasedDate: info.firmwareReleasedDate ?? "Unknown",
      hardwareVersion: info.hardwareVersion ?? null,
      macAddress: info.macAddress ?? null,
    };
  }

  /** Stav systému kamery: uptime, využitie CPU/RAM. */
  async getSystemStatus(): Promise<SystemStatus> {
    const raw = await this.request<{
      DeviceStatus: {
        currentDeviceTime?: string;
        deviceUpTime?: number;
        CPUList?: { CPU?: { cpuUtilization?: number } };
        MemoryList?: { Memory?: { memoryUsage?: number } };
      };
    }>("GET", "/ISAPI/System/status");

    const s = raw.DeviceStatus ?? {};
    return {
      currentDeviceTime: s.currentDeviceTime ?? new Date().toISOString(),
      deviceUpTime: Number(s.deviceUpTime ?? 0),
      cpuUtilization: s.CPUList?.CPU?.cpuUtilization ?? null,
      memoryUsage: s.MemoryList?.Memory?.memoryUsage ?? null,
    };
  }

  /**
   * Spustí Sport Mode "Director" — aktivuje AI tracking PTZ (kamera začne
   * sledovať loptu na track 201). Bez tohto volania track 201 nahráva,
   * ale obraz je statický (PTZ stojí na mieste).
   *
   * Reverzný engineering: presný request použitý webovým UI kamery na stránke
   * "Streamovanie športov naživo pomocou AI" → tlačidlo "Spustiť" pri Časovači hry.
   *
   * @param initialTime počiatočný čas vo formáte "h:mm:ss" (typicky "0:00:00")
   */
  async startMatchDirector(initialTime: string = "0:00:00"): Promise<void> {
    const url = `${this.baseUrl}/ISAPI/Intelligent/PhysicalMatchMgr/channels/1/PhysicalMatchDirectorMgr?format=json`;
    const body = JSON.stringify({
      matchDirectorType: "matchTimed",
      matchTime: initialTime,
    });
    const response = (await this.client.fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
    })) as Response;
    const text = await response.text();
    if (!response.ok) {
      throw new HikvisionError(
        `Sport Mode start (matchTimed) zlyhalo: HTTP ${response.status}`,
        response.status,
        text,
      );
    }
  }

  /**
   * "Zastaviť" Sport Mode tracking — kamera bohužiaľ nedokumentuje hodnotu
   * pre matchDirectorType ktorá by celý Director vypla (skúšali sme matchStopped,
   * matchPaused, matchEnd, matchReset, matchClear, … všetky vrátili
   * "Invalid JSON Content"). Z webového UI sa "Vymazať" pošle iným endpointom
   * ktorý ešte nemáme zachytený.
   *
   * Sport Mode necháme po zápase bežať — neškodí to (PTZ jednoducho sleduje
   * čokoľvek čo na ihrisku vidí), a track 201 už nenahráva pretože sme zavolali
   * stopRecording. Pri ďalšom match.start sa Director reštartuje cez matchTimed.
   */
  async stopMatchDirector(): Promise<{ skipped: true; reason: string }> {
    return {
      skipped: true,
      reason: "matchDirectorType pre stop nie je známy — Director nechávame bežať",
    };
  }

  /** Aktuálny stav Sport Mode (timing | paused | stopped, prebehnutý čas). */
  async getMatchDirectorStatus(): Promise<{
    matchTimeStatus: string;
    matchTime: string;
  }> {
    return await this.request<{
      matchTimeStatus: string;
      matchTime: string;
    }>(
      "GET",
      "/ISAPI/Intelligent/PhysicalMatchMgr/channels/1/GetPhysicalMatchDirectorStatus",
    );
  }

  /**
   * Pridá body do skóre Sport Mode na kamere (overlay v živom videu).
   * Kamera renderuje skóre priamo do streamu aj nahrávky.
   */
  async addMatchScore(team: "homeTeam" | "awayTeam", points: number): Promise<void> {
    const url = `${this.baseUrl}/ISAPI/Intelligent/PhysicalMatchMgr/channels/1/PhysicalMatchGradesMgr?format=json`;
    const body = JSON.stringify({
      matchGradesMgrType: "add",
      addGradeTeam: team,
      addGradeNumber: points,
    });
    const response = (await this.client.fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
    })) as Response;
    const text = await response.text();
    if (!response.ok) {
      throw new HikvisionError(
        `Sport Mode score update zlyhal: HTTP ${response.status}`,
        response.status,
        text,
      );
    }
  }

  /** Stav úložiska kamery (eMMC / SD karta): kapacita a voľné miesto v MB. */
  async getStorageStatus(): Promise<{
    totalMB: number;
    freeMB: number;
    usedMB: number;
    usedPercent: number | null;
  }> {
    const raw = await this.request<{
      storage?: {
        hddList?: {
          hdd?:
            | { capacity?: number; freeSpace?: number; status?: string }
            | Array<{ capacity?: number; freeSpace?: number; status?: string }>;
        };
      };
    }>("GET", "/ISAPI/ContentMgmt/Storage");

    const hddRaw = raw.storage?.hddList?.hdd;
    const hdds = Array.isArray(hddRaw) ? hddRaw : hddRaw ? [hddRaw] : [];
    let totalMB = 0;
    let freeMB = 0;
    for (const h of hdds) {
      totalMB += Number(h.capacity ?? 0);
      freeMB += Number(h.freeSpace ?? 0);
    }
    const usedMB = Math.max(0, totalMB - freeMB);
    return {
      totalMB,
      freeMB,
      usedMB,
      usedPercent: totalMB > 0 ? Math.round((usedMB / totalMB) * 100) : null,
    };
  }

  /**
   * Zistí, či track existuje a má povolené nahrávanie (cez Schedule).
   *
   * Pozor: Hikvision PanoVu firmware V5.9.1 NEMÁ endpoint pre stav manuálneho
   * nahrávania. Vraciame Track.Enable z všeobecnej konfigurácie. Skutočný stav
   * "práve teraz nahráva manuálne" si Sportly backend pamätá v RAM po posledných
   * start/stop volaniach (viď routes/camera.ts → recordingStateStore).
   */
  async getRecordingStatus(trackId: number = DEFAULT_TRACK_ID): Promise<RecordingStatus> {
    try {
      const raw = await this.request<{
        TrackList?: { Track?: { id?: number; Enable?: boolean } | Array<{ id?: number; Enable?: boolean }> };
      }>("GET", "/ISAPI/ContentMgmt/record/tracks");

      const tracks = Array.isArray(raw.TrackList?.Track)
        ? raw.TrackList.Track
        : raw.TrackList?.Track
          ? [raw.TrackList.Track]
          : [];
      const track = tracks.find((t) => Number(t.id) === trackId);

      return {
        isRecording: track?.Enable === true,
        trackId,
      };
    } catch {
      return { isRecording: false, trackId };
    }
  }

  /** Spustí manuálne nahrávanie na jednom tracku. */
  async startRecording(trackId: number = DEFAULT_TRACK_ID): Promise<void> {
    await this.request(
      "PUT",
      `/ISAPI/ContentMgmt/record/control/manual/start/tracks/${trackId}`,
    );
  }

  /** Ukončí manuálne nahrávanie na jednom tracku. */
  async stopRecording(trackId: number = DEFAULT_TRACK_ID): Promise<void> {
    await this.request(
      "PUT",
      `/ISAPI/ContentMgmt/record/control/manual/stop/tracks/${trackId}`,
    );
  }

  /**
   * Stiahne JPEG snapshot z konkrétneho kanála (live preview).
   * Channel 101 = panoramatický 180°, 7168×2160 (~800 KB).
   * Channel 201 = AI tracking ePTZ — funguje len keď je tracking aktívny.
   */
  async getSnapshot(channelId: number = 101): Promise<Buffer> {
    const url = `${this.baseUrl}/ISAPI/Streaming/channels/${channelId}/picture`;
    const response = (await this.client.fetch(url)) as Response;
    if (!response.ok) {
      throw new HikvisionError(
        `Snapshot zlyhal pre channel ${channelId}`,
        response.status,
      );
    }
    const arr = await response.arrayBuffer();
    return Buffer.from(arr);
  }

  /** Spustí nahrávanie na viacerých trackoch paralelne (101 + 201 = pano + AI tracking). */
  async startRecordingMulti(trackIds: number[]): Promise<void> {
    await Promise.all(trackIds.map((id) => this.startRecording(id)));
  }

  /** Ukončí nahrávanie na viacerých trackoch paralelne. */
  async stopRecordingMulti(trackIds: number[]): Promise<void> {
    await Promise.all(trackIds.map((id) => this.stopRecording(id)));
  }

  /**
   * Reštartuje kameru. Trvá ~30 sek kým kamera nabehne. Vracia okamžite,
   * netreba čakať. ISAPI volanie: PUT /System/reboot.
   */
  async reboot(): Promise<void> {
    await this.request("PUT", "/ISAPI/System/reboot");
  }

  /**
   * Vyhľadá nahrávky v zadanom časovom intervale. Hikvision na to používa
   * "CMSearch" — ISAPI POST /ISAPI/ContentMgmt/search.
   *
   * Volajúci môže špecifikovať buď `trackId` (jeden) alebo `trackIds` (pole).
   * Ak nezadá nič, hľadá len v default tracku 101.
   */
  async searchRecordings(params: {
    from: Date;
    to: Date;
    trackId?: number;
    trackIds?: number[];
    maxResults?: number;
  }): Promise<RecordingItem[]> {
    const trackIds = params.trackIds ?? (params.trackId !== undefined ? [params.trackId] : [DEFAULT_TRACK_ID]);
    const max = params.maxResults ?? 50;
    const searchId = `sportly-${randomUUID()}`;
    const trackIdListXml = trackIds.map((t) => `<trackID>${t}</trackID>`).join("");

    const body = `<?xml version="1.0" encoding="UTF-8"?>
<CMSearchDescription>
  <searchID>${searchId}</searchID>
  <trackIDList>${trackIdListXml}</trackIDList>
  <timeSpanList>
    <timeSpan>
      <startTime>${params.from.toISOString().replace(/\.\d+/, "")}</startTime>
      <endTime>${params.to.toISOString().replace(/\.\d+/, "")}</endTime>
    </timeSpan>
  </timeSpanList>
  <maxResults>${max}</maxResults>
  <searchResultPostion>0</searchResultPostion>
  <metadataList><metadataDescriptor>//metadata.ksh</metadataDescriptor></metadataList>
</CMSearchDescription>`;

    type Match = {
      trackID?: number;
      timeSpan?: { startTime?: string; endTime?: string };
      mediaSegmentDescriptor?: {
        contentType?: string;
        codecType?: string;
        playbackURI?: string;
      };
      metadataMatches?: { metadataDescriptor?: string };
    };
    type SearchResp = {
      CMSearchResult?: {
        matchList?: { searchMatchItem?: Match | Match[] };
        totalMatches?: number;
      };
    };

    const raw = await this.request<SearchResp>(
      "POST",
      "/ISAPI/ContentMgmt/search",
      body,
    );

    const matches = raw.CMSearchResult?.matchList?.searchMatchItem;
    if (!matches) return [];
    const list = Array.isArray(matches) ? matches : [matches];

    return list.map((m): RecordingItem => {
      const startTime = m.timeSpan?.startTime ?? "";
      const endTime = m.timeSpan?.endTime ?? "";
      const start = startTime ? new Date(startTime).getTime() : 0;
      const end = endTime ? new Date(endTime).getTime() : 0;
      const playbackURI = m.mediaSegmentDescriptor?.playbackURI ?? "";

      // Veľkosť parsujeme z URL parametra `size`
      const sizeMatch = playbackURI.match(/[?&]size=(\d+)/);
      const sizeBytes = sizeMatch?.[1] ? parseInt(sizeMatch[1], 10) : 0;

      // Typ záznamu z metadataDescriptor (manual / schedule / event)
      const descriptor = m.metadataMatches?.metadataDescriptor ?? "";
      const recordType: RecordingItem["recordType"] = descriptor.includes(
        "manual",
      )
        ? "manual"
        : descriptor.includes("schedule")
          ? "schedule"
          : descriptor.includes("event")
            ? "event"
            : "unknown";

      // Fallback trackId — ak XML chýba, vezmeme prvý zo zoznamu trackov
      // (typicky pri single-track search to vráti správny track)
      return {
        trackId: Number(m.trackID ?? trackIds[0] ?? DEFAULT_TRACK_ID),
        startTime,
        endTime,
        durationSec: Math.max(0, Math.round((end - start) / 1000)),
        sizeBytes,
        codecType: m.mediaSegmentDescriptor?.codecType ?? "unknown",
        recordType,
        playbackURI,
      };
    });
  }

  /**
   * Stiahne konkrétnu nahrávku do súboru. Hikvision vracia natívny "IMKH"
   * proprietárny container, ktorý ffmpeg vie čítať a vie ho prekonvertovať
   * na štandardný MP4 (-c copy, bez transkódovania).
   */
  async downloadRecording(playbackURI: string, destPath: string): Promise<{ sizeBytes: number }> {
    // Hikvision wants the playbackURI s host súčasťou. Niekedy ho vráti
    // ako "rtsp:///Streaming/..." (bez host). Doplníme ho keď chýba.
    let uriToUse = playbackURI;
    if (uriToUse.startsWith("rtsp:///")) {
      uriToUse = `rtsp://${this.config.host}/${uriToUse.slice(8)}`;
    }

    const body = `<?xml version="1.0" encoding="UTF-8"?>
<downloadRequest version="1.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
  <playbackURI>${uriToUse.replace(/&/g, "&amp;")}</playbackURI>
</downloadRequest>`;

    // Hikvision ISAPI download tradične dokumentuje GET s XML body, ale moderný
    // fetch API to nedovolí (Request with GET/HEAD method cannot have body).
    // Otestované: kamera akceptuje aj POST s rovnakým telom a vracia binárny stream.
    const url = `${this.baseUrl}/ISAPI/ContentMgmt/download`;
    const response = (await this.client.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body,
    })) as Response;

    if (!response.ok) {
      const text = await response.text();
      throw new HikvisionError(
        `Stiahnutie zlyhalo (HTTP ${response.status})`,
        response.status,
        text,
      );
    }
    if (!response.body) {
      throw new HikvisionError("Stiahnutie zlyhalo: žiadne dáta v odpovedi");
    }

    const fileStream = createWriteStream(destPath);
    // Cast — Node 20+ má rozdielne typy ReadableStream vs Web ReadableStream.
    const nodeReadable = Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream);
    await pipeline(nodeReadable, fileStream);

    const { stat } = await import("node:fs/promises");
    const stats = await stat(destPath);
    return { sizeBytes: stats.size };
  }
}
