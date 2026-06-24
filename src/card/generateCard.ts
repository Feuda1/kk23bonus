import sharp from "sharp";
import { LEVELS } from "../domain/loyalty.js";
import type { Guest } from "../domain/types.js";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export async function generateLoyaltyCard(guest: Guest): Promise<Buffer> {
  const levelTitle = LEVELS[guest.level].title;
  const updated = new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow",
  }).format(guest.cardUpdatedAt ? new Date(guest.cardUpdatedAt) : new Date());

  const svg = `
  <svg width="1200" height="720" viewBox="0 0 1200 720" fill="none" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1200" y2="720" gradientUnits="userSpaceOnUse">
        <stop stop-color="#2c160c"/>
        <stop offset="0.42" stop-color="#7a4b24"/>
        <stop offset="1" stop-color="#d5a76c"/>
      </linearGradient>
      <radialGradient id="cup" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(900 360) rotate(90) scale(230 260)">
        <stop stop-color="#f6ddbd"/>
        <stop offset="0.48" stop-color="#b8793e"/>
        <stop offset="1" stop-color="#392012"/>
      </radialGradient>
    </defs>
    <rect width="1200" height="720" fill="url(#bg)"/>
    <path d="M0 0H1200V720H0V0Z" fill="#1d0e08" opacity="0.18"/>
    <ellipse cx="930" cy="566" rx="150" ry="30" fill="#160a04" opacity="0.28"/>
    <circle cx="930" cy="360" r="190" fill="url(#cup)"/>
    <circle cx="930" cy="360" r="132" fill="#f1c995"/>
    <circle cx="930" cy="360" r="92" fill="#7b3f1d"/>
    <path d="M858 367C894 306 968 306 1002 367C958 334 902 334 858 367Z" fill="#f8e8d1"/>
    <path d="M930 304C960 338 960 382 930 416C900 382 900 338 930 304Z" fill="#f8e8d1"/>
    <path d="M1048 256C1112 238 1148 270 1154 326C1110 324 1062 304 1048 256Z" fill="#d6a25e" opacity="0.95"/>
    <path d="M1018 204C1078 176 1124 198 1142 250C1098 258 1048 248 1018 204Z" fill="#e4b86f" opacity="0.9"/>
    <path d="M1084 320C1124 292 1170 302 1194 340C1160 356 1114 358 1084 320Z" fill="#bc7d35" opacity="0.88"/>
    <circle cx="848" cy="563" r="18" fill="#2a1308"/>
    <circle cx="895" cy="580" r="20" fill="#1e0d06"/>
    <circle cx="826" cy="610" r="17" fill="#3a1c0c"/>
    <circle cx="872" cy="628" r="18" fill="#2a1308"/>

    <text x="82" y="126" fill="#fff5e8" font-family="Georgia, serif" font-size="76" letter-spacing="6">KK</text>
    <text x="86" y="188" fill="#fff5e8" font-family="Georgia, serif" font-size="70">23</text>
    <text x="220" y="142" fill="#fff5e8" font-family="Arial, sans-serif" font-size="26" font-weight="700">КОФЕ. КАК ИСКУССТВО</text>

    <text x="82" y="274" fill="#f8dfc2" font-family="Arial, sans-serif" font-size="30">Гость</text>
    <text x="82" y="322" fill="#ffffff" font-family="Arial, sans-serif" font-size="46" font-weight="700">${escapeXml(guest.name)}</text>

    <text x="82" y="410" fill="#f8dfc2" font-family="Arial, sans-serif" font-size="34">Ваш бонусный PIN</text>
    <text x="82" y="520" fill="#ffffff" font-family="Georgia, serif" font-size="128" letter-spacing="24">${guest.loyaltyCode}</text>

    <text x="82" y="602" fill="#f8dfc2" font-family="Arial, sans-serif" font-size="28">Баланс</text>
    <text x="82" y="660" fill="#ffffff" font-family="Arial, sans-serif" font-size="60" font-weight="700">${guest.balance}</text>
    <text x="238" y="660" fill="#f8dfc2" font-family="Arial, sans-serif" font-size="34">баллов</text>

    <rect x="740" y="72" width="320" height="72" rx="36" fill="#fff5e8" opacity="0.18"/>
    <text x="780" y="119" fill="#ffffff" font-family="Arial, sans-serif" font-size="30" font-weight="700">Уровень: ${escapeXml(levelTitle)}</text>
    <text x="740" y="662" fill="#fff5e8" font-family="Arial, sans-serif" font-size="24">Обновлено: ${escapeXml(updated)}</text>
  </svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}
