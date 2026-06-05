// Klub = jeden zákazník služby (napr. OŠK Rosina).
// Pole zodpovedajú schéme z technického návrhu, kapitola 6.1.

export type ClubPlan = "start" | "klub" | "liga";
export type ClubStatus = "active" | "paused" | "churned";

export interface Club {
  id: string;
  name: string;
  league: string | null;
  city: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  sportnetId: string | null;
  plan: ClubPlan;
  status: ClubStatus;
  createdAt: string;
  updatedAt: string;
}
