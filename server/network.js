/**
 * Public address detection and QR code generation.
 *
 * Priority:
 *   1. PUBLIC_URL           - explicit override
 *   2. RAILWAY_PUBLIC_DOMAIN - managed hosting
 *   3. Best local IPv4       - laptop + phone on the same Wi-Fi
 */

import os from 'node:os';
import QRCode from 'qrcode';
import { IS_RAILWAY, PORT, PUBLIC_URL } from './config.js';

const ignoredInterfaces = /^(lo|utun|awdl|llw|bridge|docker|veth|tun|tap)/i;

export function detectLanAddress() {
  const interfaces = os.networkInterfaces();
  const candidates = [];

  for (const [name, addresses] of Object.entries(interfaces)) {
    if (!addresses || ignoredInterfaces.test(name)) continue;
    for (const address of addresses) {
      if (address.family !== 'IPv4' || address.internal) continue;
      candidates.push({ name, address: address.address });
    }
  }

  const preferred = candidates.find(({ name }) => /^(en0|eth0|wlan0|en1)$/i.test(name));
  if (preferred) return preferred.address;
  return candidates[0]?.address ?? '127.0.0.1';
}

export function resolveBaseUrl() {
  if (PUBLIC_URL) return PUBLIC_URL;
  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (railwayDomain) return `https://${railwayDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
  return `http://${detectLanAddress()}:${PORT}`;
}

export const BASE_URL = resolveBaseUrl();

export function joinUrlFor(code) {
  return `${BASE_URL}/play?code=${encodeURIComponent(code)}`;
}

const qrCache = new Map();

export async function qrDataUrlFor(code) {
  const url = joinUrlFor(code);
  if (qrCache.has(url)) return qrCache.get(url);
  const dataUrl = await QRCode.toDataURL(url, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 640,
    color: { dark: '#03121b', light: '#eaffff' },
  });
  if (qrCache.size > 12) qrCache.clear();
  qrCache.set(url, dataUrl);
  return dataUrl;
}

export function serverDescription() {
  return {
    baseUrl: BASE_URL,
    isRailway: IS_RAILWAY,
    port: PORT,
  };
}
