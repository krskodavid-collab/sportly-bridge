// Typy pre Hikvision ISAPI komunikáciu.
// ISAPI = Internet Server API od Hikvision, odpovedá v XML formáte.

export interface CameraConfig {
  host: string;
  port: number;
  protocol: "http" | "https";
  username: string;
  password: string;
}

export interface DeviceInfo {
  deviceName: string;
  deviceID: string;
  model: string;
  serialNumber: string;
  firmwareVersion: string;
  firmwareReleasedDate: string;
  hardwareVersion: string | null;
  macAddress: string | null;
}

export interface SystemStatus {
  currentDeviceTime: string;
  deviceUpTime: number; // sekúnd
  cpuUtilization: number | null; // 0-100 %
  memoryUsage: number | null; // 0-100 %
}

export interface RecordingStatus {
  isRecording: boolean;
  trackId: number;
}

// Track ID 101 = main stream pre IP kamery Hikvision.
// Pre Hikvision PanoVu DS-2CD6982G0-WU/4G:
//   Track 101 = panoramatický 7168×2160 H.265 (celé ihrisko)
//   Track 201 = AI tracking ePTZ 1920×1080 H.264 (kropované sledovanie lopty)
//
// Pri zápase nahrávame oba paralelne — klub má potom 2 perspektívy:
// panoramatickú pre taktický rozbor a tracking pre normálny TV pohľad.
export const DEFAULT_TRACK_ID = 101;
export const PANORAMA_TRACK_ID = 101;
export const TRACKING_TRACK_ID = 201;
export const DEFAULT_TRACK_IDS = [PANORAMA_TRACK_ID, TRACKING_TRACK_ID];

/**
 * Záznam nahrávky vrátený z ISAPI CMSearch.
 * playbackURI vyzerá typicky takto:
 *   rtsp://192.168.1.84/Streaming/tracks/101/?starttime=...&endtime=...&name=...&size=...
 * Veľkosť (sizeBytes) parsujeme z URL parametra "size", trvanie z timestamps.
 */
export interface RecordingItem {
  trackId: number;
  startTime: string; // ISO 8601
  endTime: string;
  durationSec: number;
  sizeBytes: number;
  codecType: string;
  recordType: "manual" | "schedule" | "event" | "unknown";
  playbackURI: string;
}

