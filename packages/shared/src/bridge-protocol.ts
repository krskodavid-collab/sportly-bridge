// Protokol správ medzi Sportly Bridge (v klube) a cloudom (sportly.sk).
// Obojstranne cez WebSocket. Zdieľané typy aby Bridge aj cloud "hovorili
// rovnakým jazykom".

// --- Bridge → Cloud ---

export interface BridgeAuthMessage {
  type: "auth";
  token: string; // Camera.bridgeToken
  bridgeVersion: string;
}

export interface BridgeHeartbeatMessage {
  type: "heartbeat";
}

/** Odpoveď Bridge na príkaz z cloudu (M1C-2). */
export interface BridgeResultMessage {
  type: "result";
  commandId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export type BridgeToCloudMessage =
  | BridgeAuthMessage
  | BridgeHeartbeatMessage
  | BridgeResultMessage;

// --- Cloud → Bridge ---

export interface CloudAuthOkMessage {
  type: "auth.ok";
  cameraId: string;
  clubId: string;
  cameraConfig: {
    host: string;
    port: number;
    protocol: "http" | "https";
    username: string;
    password: string;
  };
}

export interface CloudAuthFailMessage {
  type: "auth.fail";
  reason: string;
}

/** Príkaz z cloudu pre Bridge vykonať na kamere (M1C-2). */
export interface CloudCommandMessage {
  type: "command";
  commandId: string;
  action: "start" | "stop" | "snapshot" | "download" | "info" | "reboot" | "storage" | "score";
  params?: Record<string, unknown>;
}

export type CloudToBridgeMessage =
  | CloudAuthOkMessage
  | CloudAuthFailMessage
  | CloudCommandMessage;
