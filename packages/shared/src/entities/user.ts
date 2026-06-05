// Používateľ = člen klubu, ktorý sa prihlasuje do dashboardu.
// Role:
//   admin   — predseda klubu, plné práva vrátane pozývania ďalších členov
//   manager — tréneri/funkcionári, vedia spustiť/ukončiť nahrávanie a publikovať
//   viewer  — len pozeranie záznamov (napr. členská základňa)

export type UserRole = "admin" | "manager" | "viewer";

export interface User {
  id: string;
  clubId: string;
  email: string;
  name: string | null;
  role: UserRole;
  phone: string | null;
  notifyEmail: boolean;
  notifyWhatsapp: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}
