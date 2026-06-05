// Kamera = fyzické zariadenie priradené ku klubu.
// Model je v MVP vždy Hikvision DS-2CD6982G0-WU/4G, ale necháme to ako string
// pre prípad neskoršej podpory alternatívnych modelov (Dahua, Milesight).

export type CameraStatus = "online" | "offline" | "recording" | "error";

export interface Camera {
  id: string;
  clubId: string;
  serialNumber: string;
  model: string;
  ipAddress: string | null;
  lastHeartbeatAt: string | null;
  status: CameraStatus;
  firmware: string | null;
}
