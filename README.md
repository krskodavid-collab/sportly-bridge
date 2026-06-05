# Sportly Bridge

Most medzi Hikvision PanoVu kamerou v klube a Sportly cloudom (`sportly.sk`).
Beží na Raspberry Pi 5 (ARM64) ako systemd služba.

## Inštalácia

Príkaz získate v Sportly admin → Bridge zariadenia → 📥 Inštalátor:

```bash
curl -sSL https://sportly.sk/install/bridge/<token> | sudo bash
```

Skript:
- Inštaluje Node.js 20 LTS + pnpm
- Klonuje tento repo do `/opt/sportly-bridge`
- Naskenuje sieť pre Hikvision kameru (MAC OUI `58:e4:eb`)
- Vytvorí systemd službu `sportly-bridge`

## Manuálne spustenie (dev)

```bash
pnpm install
cd apps/bridge && pnpm dev
```

Premenné v `.env`:
- `CLOUD_WS_URL` — `wss://sportly.sk/bridge`
- `BRIDGE_TOKEN` — unikátny token z onboardingu klubu v Sportly admin
- `CAMERA_HOST` — IP kamery (typicky 192.168.x.x)
- `CAMERA_USERNAME`, `CAMERA_PASSWORD` — Hikvision creds

## Update

```bash
cd /opt/sportly-bridge
git pull
pnpm install
sudo systemctl restart sportly-bridge
```

## Logy

```bash
sudo journalctl -fu sportly-bridge
```

## Licencia

Proprietárny. © 2026 Sportly. Všetky práva vyhradené.
