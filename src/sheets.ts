import { SignJWT, importPKCS8 } from "jose";
import type { Env } from "./types";
import type { GiftLogEntry } from "./types";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";

let cachedToken: { accessToken: string; expiresAt: number } | null = null;

async function getAccessToken(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt - 60 > now) {
    return cachedToken.accessToken;
  }

  const privateKeyPem = env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n");
  const privateKey = await importPKCS8(privateKeyPem, "RS256");

  const jwt = await new SignJWT({ scope: SCOPE })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(env.GOOGLE_CLIENT_EMAIL)
    .setAudience(TOKEN_URL)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Googleアクセストークンの取得に失敗しました (HTTP ${res.status}): ${text}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { accessToken: data.access_token, expiresAt: now + data.expires_in };
  return data.access_token;
}

function giftTypeLabel(gt: number | null): string {
  if (gt === 1) return "無料";
  if (gt === 2) return "有料";
  return "";
}

function userAttributeLabel(ua: number | null): string {
  if (ua === 1) return "ビギナー";
  if (ua === 2) return "初見";
  if (ua === 3) return "リピーター";
  return "";
}

export async function appendGiftRow(env: Env, entry: GiftLogEntry): Promise<void> {
  const accessToken = await getAccessToken(env);
  const sheetName = env.GOOGLE_SHEET_NAME || "Sheet1";
  const range = `${sheetName}!A:G`;

  const row = [
    entry.sentAt ?? entry.receivedAt,
    entry.roomName ?? entry.roomId ?? "",
    entry.senderName ?? "",
    userAttributeLabel(entry.userAttribute),
    entry.giftId ?? "",
    entry.num ?? "",
    giftTypeLabel(entry.giftType),
  ];

  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ values: [row] }),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`スプレッドシートへの書き込みに失敗しました (HTTP ${res.status}): ${text}`);
  }
}
