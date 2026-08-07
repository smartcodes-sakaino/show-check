export interface Env {
  ROOM_MONITOR: DurableObjectNamespace;
  ASSETS: Fetcher;

  ADMIN_TOKEN: string;
  GOOGLE_CLIENT_EMAIL: string;
  GOOGLE_PRIVATE_KEY: string;
  GOOGLE_SHEET_ID: string;
  GOOGLE_SHEET_NAME?: string;
}

export type MonitorStatus =
  | "idle" // 監視オフ
  | "polling" // 配信開始待ち（定期チェック中）
  | "live" // 配信中（WebSocket接続中）
  | "error"; // 直近の処理でエラー発生

export interface RoomConfig {
  /** ユーザーが入力したルームIDまたはルームURL */
  input: string;
  /** SHOWROOM上のroom_id（数値, 解決済みの場合） */
  roomId: string | null;
  /** 表示用のルーム名（取得できた場合） */
  roomName: string | null;
}

export interface GiftLogEntry {
  /** サーバーが受信した時刻 (ISO8601) */
  receivedAt: string;
  /** ギフト送信時刻 (created_at を変換したもの、取得できれば) */
  sentAt: string | null;
  roomId: string | null;
  roomName: string | null;
  /** 送信者ユーザー名 */
  senderName: string | null;
  /** 送信者ユーザーID */
  userId: string | number | null;
  /** ユーザー種別: 1=ビギナー 2=初見 3=リピーター */
  userAttribute: number | null;
  /** ギフトID */
  giftId: string | number | null;
  /** ギフト個数 */
  num: number | null;
  /** 1=無料 2=有料 */
  giftType: number | null;
  /** シートへの書き込みに成功したか */
  sheetSynced: boolean;
  sheetError: string | null;
}

export interface StatusResponse {
  status: MonitorStatus;
  monitoring: boolean;
  room: RoomConfig;
  lastCheckedAt: string | null;
  lastError: string | null;
  recentGifts: GiftLogEntry[];
}
