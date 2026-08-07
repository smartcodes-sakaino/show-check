import { SignJWT, importPKCS8 } from "jose";
import type { Env, GiftLogEntry, HistoryDate, HistorySenderSummary, HistorySummaryResponse } from "./types";

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

function sheetsRange(env: Env): string {
  const sheetName = env.GOOGLE_SHEET_NAME || "Sheet1";
  return `${sheetName}!A:I`;
}

function buildRow(entry: GiftLogEntry): (string | number)[] {
  return [
    entry.sentAt ?? entry.receivedAt,
    entry.roomName ?? entry.roomId ?? "",
    entry.senderName ?? "",
    userAttributeLabel(entry.userAttribute),
    entry.giftName ?? "",
    entry.giftId ?? "",
    entry.num ?? 0,
    entry.totalG ?? 0,
    giftTypeLabel(entry.giftType),
  ];
}

/**
 * シート列: 受信日時 / ルーム / 送信者 / ユーザー種別 / ギフト名 / ギフトID / 個数 / G(合計) / 無料・有料
 * valueInputOption=RAW で書き込む（USER_ENTEREDだとSheetsが日時文字列を日付型として
 * 自動変換し、タイムゾーン・表示形式に依存して読み戻しが不安定になるため、
 * 文字列はそのままテキストとして保存する）。
 *
 * 複数件をまとめて1回のリクエストで追記する。Sheets APIのクォータは
 * リクエスト回数ベース（デフォルトはユーザーあたり毎分60件程度）なので、
 * ギフトが連続で飛んできても1件ずつ書き込まずまとめて送ることでクォータ消費を抑える。
 */
export async function appendGiftRows(env: Env, entries: GiftLogEntry[]): Promise<void> {
  if (entries.length === 0) return;

  const accessToken = await getAccessToken(env);
  const range = sheetsRange(env);
  const values = entries.map(buildRow);

  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ values }),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`スプレッドシートへの書き込みに失敗しました (HTTP ${res.status}): ${text}`);
  }
}

interface SheetGiftRow {
  timestamp: string;
  senderName: string;
  giftName: string;
  giftId: string;
  num: number;
  totalG: number;
}

async function getGiftRows(env: Env): Promise<SheetGiftRow[]> {
  const accessToken = await getAccessToken(env);
  const range = sheetsRange(env);

  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`スプレッドシートの読み込みに失敗しました (HTTP ${res.status}): ${text}`);
  }

  const data = (await res.json()) as { values?: unknown[][] };
  const rows: SheetGiftRow[] = [];
  for (const raw of data.values ?? []) {
    const timestamp = String(raw[0] ?? "");
    // ヘッダー行・空行など、ISO8601日時で始まらない行は集計対象から除外する
    if (!/^\d{4}-\d{2}-\d{2}T/.test(timestamp)) continue;
    rows.push({
      timestamp,
      senderName: String(raw[2] ?? "") || "不明",
      giftName: String(raw[4] ?? ""),
      giftId: String(raw[5] ?? ""),
      num: Number(raw[6]) || 0,
      totalG: Number(raw[7]) || 0,
    });
  }
  return rows;
}

/** ISO8601文字列(UTC)からJST基準の日付キー(YYYY-MM-DD)を求める */
function toJstDateKey(isoTimestamp: string): string {
  const utcMs = new Date(isoTimestamp).getTime();
  const jst = new Date(utcMs + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

export async function listHistoryDates(env: Env): Promise<HistoryDate[]> {
  const rows = await getGiftRows(env);
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = toJstDateKey(row.timestamp);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

export async function getHistorySummary(env: Env, date: string): Promise<HistorySummaryResponse> {
  const rows = await getGiftRows(env);
  const targetRows = rows.filter((row) => toJstDateKey(row.timestamp) === date);

  const bySender = new Map<string, HistorySenderSummary>();
  let grandTotalG = 0;

  for (const row of targetRows) {
    let sender = bySender.get(row.senderName);
    if (!sender) {
      sender = { userId: row.senderName, senderName: row.senderName, totalG: 0, breakdown: [] };
      bySender.set(row.senderName, sender);
    }
    sender.totalG += row.totalG;
    grandTotalG += row.totalG;

    const existing = sender.breakdown.find((b) => b.giftId === row.giftId);
    if (existing) {
      existing.num += row.num;
      existing.totalG += row.totalG;
    } else {
      sender.breakdown.push({
        giftId: row.giftId,
        giftName: row.giftName || null,
        num: row.num,
        totalG: row.totalG,
      });
    }
  }

  const senders = [...bySender.values()].sort((a, b) => b.totalG - a.totalG);
  for (const sender of senders) {
    sender.breakdown.sort((a, b) => b.totalG - a.totalG);
  }

  return { date, grandTotalG, senders };
}
