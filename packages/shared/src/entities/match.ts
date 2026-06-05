// Zápas = jedna nahrávacia jednotka. Stav prechádza fázami:
//   recording → processing → ready_to_upload → published

export type ProcessingStatus = "pending" | "splitting" | "done" | "failed";
export type UploadStatus = "pending" | "uploading" | "published" | "failed";

export interface Match {
  id: string;
  clubId: string;
  homeTeam: string;
  awayTeam: string;
  kickoffAt: string;
  sportnetMatchId: string | null;
  venue: string | null;

  // Nahrávanie
  recordingStartedAt: string | null;
  recordingEndedAt: string | null;
  rawVideoUrl: string | null;

  // Spracovanie (FFmpeg split na polčasy)
  halftimeAt: number | null; // sekúnd od začiatku videa
  half1Url: string | null;
  half2Url: string | null;
  processingStatus: ProcessingStatus;

  // Upload do SportNetu
  sportnetUploadStatus: UploadStatus;
  sportnetVideoUrl: string | null;
  sportnetUploadedAt: string | null;

  createdAt: string;
  updatedAt: string;
}
