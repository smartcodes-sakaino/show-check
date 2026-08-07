/**
 * SHOWROOM の非公式APIクライアント。
 *
 * ここに書いてあるエンドポイント・フィールド名は、実際に本番環境へリクエストを送って
 * レスポンスを確認した内容がベースになっている（2026-08-07 実データ検証済み）。
 * ただし非公式APIである以上、仕様変更で突然動かなくなるリスクは残る。
 * エンドポイント・フィールド名はこのファイルに集約してあるので、挙動が変わった場合はここだけ直せばよい。
 */

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function commonHeaders(): HeadersInit {
  return {
    "User-Agent": USER_AGENT,
    Accept: "application/json, text/html, */*",
  };
}

export interface RoomStatus {
  isLive: boolean;
  roomId: string;
  roomName: string | null;
  /** ギフトWebSocket購読に必要なキー。配信中のみ取得できる想定。 */
  bcsvrKey: string | null;
}

function extractRoomIdFromHtml(html: string): string | null {
  // ページ内の「room/profile?room_id=NNN」リンクから room_id を拾う（実データで確認済みの安定した抽出元）
  const match = html.match(/room\/profile\?room_id=(\d+)/);
  return match ? match[1] : null;
}

function extractRoomNameFromHtml(html: string): string | null {
  const match = html.match(/<title>([^<]*)<\/title>/);
  if (!match) return null;
  // タイトルは "ルーム名｜SHOWROOM(ショールーム)" の形式なので末尾の装飾を落とす
  return match[1].split("｜SHOWROOM")[0].trim() || null;
}

/**
 * ルームのページ（https://www.showroom-live.com/r/<room_url_key> や
 * https://www.showroom-live.com/<room_url_key>）のHTMLから room_id を抽出する。
 * room_url_key は英数字とは限らず、数字だけの文字列のこともある
 * （例: /r/615191698244 は room_id ではなく room_url_key）ため、
 * 見た目が数字だけでも room_id と決め打ちせず、必ずページから解決する。
 */
async function resolveRoomIdFromPage(pageUrl: string): Promise<{ roomId: string; roomName: string | null }> {
  const res = await fetch(pageUrl, { headers: commonHeaders() });
  const html = await res.text();
  const roomId = extractRoomIdFromHtml(html);
  if (!roomId) {
    throw new Error(`ルームが見つかりませんでした（URLが正しいか確認してください）: ${pageUrl}`);
  }
  return { roomId, roomName: extractRoomNameFromHtml(html) };
}

/**
 * ユーザー入力から room_id を解決する。対応パターン:
 * - 数値のみ → そのまま room_id とみなす（room_id は6〜7桁程度が実際の値）
 * - room_id=クエリ付きURL（例: /room/profile?room_id=87911）→ クエリの値を使う
 * - それ以外のURL・文字列（例: /r/xxxxx, /xxxxx）→ room_url_key とみなし、
 *   実際にページを取得してHTML内の room_id を抽出する
 */
export async function resolveRoomId(input: string): Promise<{ roomId: string; roomName: string | null }> {
  const trimmed = input.trim();

  if (/^\d+$/.test(trimmed)) {
    return { roomId: trimmed, roomName: null };
  }

  try {
    const url = new URL(trimmed);
    const qRoomId = url.searchParams.get("room_id");
    if (qRoomId) {
      return { roomId: qRoomId, roomName: null };
    }
    return await resolveRoomIdFromPage(url.toString());
  } catch (err) {
    if (err instanceof TypeError) {
      // new URL() が失敗した = URLではなく room_url_key がそのまま渡されたケース
      return await resolveRoomIdFromPage(`https://www.showroom-live.com/${encodeURIComponent(trimmed)}`);
    }
    throw err;
  }
}

/**
 * 対象ルームが配信中かどうかを確認する。
 * live_status: 2 = 配信中（実データで確認済み）。
 * HTTP 403 "Your room is in private mode" は、配信していない通常時によく返る
 * レスポンスなのでエラー扱いにせず「未配信」として扱う。
 * HTTP 404 は room_id 自体が存在しない設定ミスの可能性が高いのでエラーとして投げる。
 */
export async function checkRoomStatus(roomId: string): Promise<RoomStatus> {
  const res = await fetch(
    `https://www.showroom-live.com/api/live/live_info?room_id=${encodeURIComponent(roomId)}`,
    { headers: commonHeaders() },
  );

  if (res.status === 403) {
    return { isLive: false, roomId, roomName: null, bcsvrKey: null };
  }
  if (!res.ok) {
    throw new Error(`配信ステータスの取得に失敗しました (HTTP ${res.status})`);
  }

  const data = (await res.json()) as any;
  const isLive = data?.live_status === 2 || data?.live_status === "2";
  const bcsvrKey: string | null = data?.bcsvr_key ?? null;
  const roomName: string | null = data?.room_name ?? null;

  return { isLive, roomId, roomName, bcsvrKey: isLive ? bcsvrKey : null };
}

export interface GiftEvent {
  ac: string | null; // 送信者ユーザー名
  av: string | number | null; // アバターID
  g: string | number | null; // ギフトID
  gt: number | null; // 1=無料 2=有料
  n: number | null; // 個数
  u: string | number | null; // ユーザーID
  ua: number | null; // 1=ビギナー 2=初見 3=リピーター
  created_at: number | null; // UNIXタイムスタンプ
}

/**
 * WebSocketで受信したメッセージのJSON部分から、ギフトイベントかどうかを判定する。
 * 実データ検証結果: `t` フィールドがギフトは "2"、コメントは "1"、
 * ファンレベルアップ通知は "18"、テロップ更新は "8"。キー数は変動する
 * （ギフトは17前後、コメントは13前後）ためキー数では判定せず t の値のみで判定する。
 */
export function parseGiftEvent(obj: Record<string, unknown>): GiftEvent | null {
  const t = obj.t !== undefined ? String(obj.t) : null;
  if (t !== "2") return null;

  return {
    ac: (obj.ac as string) ?? null,
    av: (obj.av as string | number) ?? null,
    g: (obj.g as string | number) ?? null,
    gt: obj.gt !== undefined ? Number(obj.gt) : null,
    n: obj.n !== undefined ? Number(obj.n) : null,
    u: (obj.u as string | number) ?? null,
    ua: obj.ua !== undefined ? Number(obj.ua) : null,
    created_at: obj.created_at !== undefined ? Number(obj.created_at) : null,
  };
}

/** `MSG\t{bcsvr_key}\t{json}` 形式のWSメッセージをパースする */
export function parseWsFrame(raw: string): { type: string; key: string | null; payload: unknown } {
  const parts = raw.split("\t");
  const type = parts[0] ?? "";
  if (type === "MSG" && parts.length >= 3) {
    const jsonPart = parts.slice(2).join("\t");
    try {
      return { type, key: parts[1], payload: JSON.parse(jsonPart) };
    } catch {
      return { type, key: parts[1] ?? null, payload: null };
    }
  }
  return { type, key: null, payload: null };
}

export const SHOWROOM_WS_URL = "wss://online.showroom-live.com/";
