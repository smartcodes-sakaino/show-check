import type { Env, GiftLogEntry, MonitorStatus, RoomConfig, StatusResponse } from "./types";
import {
  SHOWROOM_WS_URL,
  checkRoomStatus,
  fetchGiftCatalog,
  parseGiftEvent,
  parseWsFrame,
  resolveRoomId,
  type GiftMasterEntry,
} from "./showroom";
import { appendGiftRow } from "./sheets";

const POLL_INTERVAL_MS = 45_000; // 未配信中のポーリング間隔（数十秒〜1分の想定内）
const LIVE_SAFETY_CHECK_MS = 5 * 60_000; // WS接続中でも念のため生存確認する間隔
const MAX_GIFT_LOG = 50;
const RECONNECT_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000];

const STORAGE_KEYS = {
  config: "config",
  status: "status",
  monitoring: "monitoring",
  lastError: "lastError",
  lastCheckedAt: "lastCheckedAt",
  giftLog: "giftLog",
} as const;

export class RoomMonitor implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private wsGeneration = 0; // 古いWS接続からのイベントを無視するための世代カウンタ

  private giftCatalog: Map<number, GiftMasterEntry> | null = null;
  private giftCatalogRoomId: string | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case "/status":
          return Response.json(await this.getStatusResponse());
        case "/room":
          if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
          return Response.json(await this.setRoom(await request.json()));
        case "/monitor/start":
          if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
          return Response.json(await this.startMonitoring());
        case "/monitor/stop":
          if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
          return Response.json(await this.stopMonitoring());
        case "/gifts/clear":
          if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
          await this.state.storage.put(STORAGE_KEYS.giftLog, []);
          return Response.json(await this.getStatusResponse());
        default:
          return new Response("Not Found", { status: 404 });
      }
    } catch (err: any) {
      return Response.json({ error: String(err?.message ?? err) }, { status: 500 });
    }
  }

  async alarm(): Promise<void> {
    const monitoring = (await this.state.storage.get<boolean>(STORAGE_KEYS.monitoring)) ?? false;
    if (!monitoring) return;

    const status = await this.getStatus();
    if (status === "live") {
      // WSが生きているか念のため確認（安全網）。切れていればポーリングに戻す。
      if (!this.ws) {
        await this.setStatus("polling");
        await this.pollOnce();
      } else {
        await this.scheduleAlarm(LIVE_SAFETY_CHECK_MS);
      }
      return;
    }

    await this.pollOnce();
  }

  // ---- 内部ロジック ----

  private async getConfig(): Promise<RoomConfig> {
    return (
      (await this.state.storage.get<RoomConfig>(STORAGE_KEYS.config)) ?? {
        input: "",
        roomId: null,
        roomName: null,
      }
    );
  }

  private async getStatus(): Promise<MonitorStatus> {
    return (await this.state.storage.get<MonitorStatus>(STORAGE_KEYS.status)) ?? "idle";
  }

  private async setStatus(status: MonitorStatus): Promise<void> {
    await this.state.storage.put(STORAGE_KEYS.status, status);
  }

  private async setLastError(message: string | null): Promise<void> {
    await this.state.storage.put(STORAGE_KEYS.lastError, message);
  }

  private async getStatusResponse(): Promise<StatusResponse> {
    const [status, monitoring, room, lastError, lastCheckedAt, giftLog] = await Promise.all([
      this.getStatus(),
      this.state.storage.get<boolean>(STORAGE_KEYS.monitoring),
      this.getConfig(),
      this.state.storage.get<string | null>(STORAGE_KEYS.lastError),
      this.state.storage.get<string | null>(STORAGE_KEYS.lastCheckedAt),
      this.state.storage.get<GiftLogEntry[]>(STORAGE_KEYS.giftLog),
    ]);
    return {
      status,
      monitoring: monitoring ?? false,
      room,
      lastError: lastError ?? null,
      lastCheckedAt: lastCheckedAt ?? null,
      recentGifts: giftLog ?? [],
    };
  }

  private async setRoom(body: { input?: string }): Promise<StatusResponse> {
    const input = (body?.input ?? "").trim();
    if (!input) throw new Error("ルームIDまたはルームURLを入力してください");

    const resolved = await resolveRoomId(input);
    const config: RoomConfig = { input, roomId: resolved.roomId, roomName: resolved.roomName };
    await this.state.storage.put(STORAGE_KEYS.config, config);
    await this.setLastError(null);

    // ルームを切り替えたら、進行中の接続・監視をいったんリセットする
    this.closeWs("room changed");
    const monitoring = (await this.state.storage.get<boolean>(STORAGE_KEYS.monitoring)) ?? false;
    if (monitoring) {
      await this.setStatus("polling");
      await this.scheduleAlarm(0);
    }
    return this.getStatusResponse();
  }

  private async startMonitoring(): Promise<StatusResponse> {
    const config = await this.getConfig();
    if (!config.roomId) throw new Error("先に監視対象のルームを設定してください");

    await this.state.storage.put(STORAGE_KEYS.monitoring, true);
    await this.state.storage.put(STORAGE_KEYS.giftLog, []);
    await this.setStatus("polling");
    await this.setLastError(null);
    await this.scheduleAlarm(0);
    return this.getStatusResponse();
  }

  private async stopMonitoring(): Promise<StatusResponse> {
    await this.state.storage.put(STORAGE_KEYS.monitoring, false);
    this.closeWs("manual stop");
    await this.state.storage.deleteAlarm();
    await this.setStatus("idle");
    return this.getStatusResponse();
  }

  private async scheduleAlarm(delayMs: number): Promise<void> {
    await this.state.storage.setAlarm(Date.now() + delayMs);
  }

  private async pollOnce(): Promise<void> {
    const config = await this.getConfig();
    if (!config.roomId) {
      await this.setStatus("idle");
      return;
    }

    await this.state.storage.put(STORAGE_KEYS.lastCheckedAt, new Date().toISOString());

    try {
      const roomStatus = await checkRoomStatus(config.roomId);

      if (roomStatus.roomName && roomStatus.roomName !== config.roomName) {
        await this.state.storage.put(STORAGE_KEYS.config, { ...config, roomName: roomStatus.roomName });
      }

      if (roomStatus.isLive && roomStatus.bcsvrKey) {
        await this.setLastError(null);
        await this.ensureGiftCatalog(config.roomId);
        await this.connectWs(roomStatus.bcsvrKey);
        return; // ライブ中はalarmではなくWSのcloseイベント起点でポーリングに戻す
      }

      await this.setStatus("polling");
      await this.scheduleAlarm(POLL_INTERVAL_MS);
    } catch (err: any) {
      await this.setStatus("error");
      await this.setLastError(String(err?.message ?? err));
      await this.scheduleAlarm(POLL_INTERVAL_MS);
    }
  }

  /**
   * ギフトID→名前/G のマスタデータをキャッシュする。取得に失敗しても監視自体は続行し、
   * その場合ギフトのG換算値はnullのまま記録される。
   */
  private async ensureGiftCatalog(roomId: string): Promise<void> {
    if (this.giftCatalog && this.giftCatalogRoomId === roomId) return;
    try {
      this.giftCatalog = await fetchGiftCatalog(roomId);
      this.giftCatalogRoomId = roomId;
    } catch (err: any) {
      console.error("gift catalog fetch failed", err);
    }
  }

  private async connectWs(bcsvrKey: string): Promise<void> {
    this.closeWs("reconnect before new connection");

    const generation = ++this.wsGeneration;
    try {
      const resp = await fetch(SHOWROOM_WS_URL, { headers: { Upgrade: "websocket" } });
      const ws = (resp as any).webSocket as WebSocket | undefined;
      if (!ws) throw new Error("SHOWROOMのWebSocketへの接続に失敗しました（webSocketが取得できません）");

      ws.accept();
      this.ws = ws;
      this.reconnectAttempt = 0;

      ws.addEventListener("message", (event: MessageEvent) => {
        this.handleWsMessage(generation, event).catch((err) => {
          console.error("gift handling error", err);
        });
      });
      ws.addEventListener("close", () => {
        if (generation !== this.wsGeneration) return; // 既に張り替え済みの古い接続
        this.ws = null;
        this.onWsClosed().catch((err) => console.error("onWsClosed error", err));
      });
      ws.addEventListener("error", () => {
        if (generation !== this.wsGeneration) return;
        this.ws = null;
        this.onWsClosed().catch((err) => console.error("onWsClosed error", err));
      });

      ws.send(`SUB\t${bcsvrKey}`);
      await this.setStatus("live");
      await this.scheduleAlarm(LIVE_SAFETY_CHECK_MS);
    } catch (err: any) {
      await this.setStatus("error");
      await this.setLastError(String(err?.message ?? err));
      await this.scheduleAlarm(POLL_INTERVAL_MS);
    }
  }

  private closeWs(reason: string): void {
    this.wsGeneration++; // 以降のイベントは古い世代として無視させる
    if (this.ws) {
      try {
        this.ws.close(1000, reason);
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  private async onWsClosed(): Promise<void> {
    const monitoring = (await this.state.storage.get<boolean>(STORAGE_KEYS.monitoring)) ?? false;
    if (!monitoring) {
      await this.setStatus("idle");
      return;
    }

    const config = await this.getConfig();
    if (!config.roomId) {
      await this.setStatus("idle");
      return;
    }

    // 配信が続いているか確認し、続いていれば再接続、終わっていればポーリングに戻す
    try {
      const roomStatus = await checkRoomStatus(config.roomId);
      if (roomStatus.isLive && roomStatus.bcsvrKey) {
        this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, RECONNECT_DELAYS_MS.length - 1);
        const delay = RECONNECT_DELAYS_MS[this.reconnectAttempt];
        await this.setLastError(`WebSocket切断を検知。${delay / 1000}秒後に再接続します`);
        await this.scheduleAlarm(delay);
        return;
      }
    } catch (err: any) {
      await this.setLastError(`切断後の再確認に失敗しました: ${String(err?.message ?? err)}`);
    }

    // 配信終了 or 確認失敗 → ポーリングモードに戻す
    await this.setStatus("polling");
    await this.scheduleAlarm(POLL_INTERVAL_MS);
  }

  private async handleWsMessage(generation: number, event: MessageEvent): Promise<void> {
    if (generation !== this.wsGeneration) return;
    if (typeof event.data !== "string") return;

    const frame = parseWsFrame(event.data);
    if (frame.type !== "MSG" || !frame.payload || typeof frame.payload !== "object") return;

    const gift = parseGiftEvent(frame.payload as Record<string, unknown>);
    if (!gift) return; // コメント等、ギフト以外は無視

    const master = gift.g !== null ? this.giftCatalog?.get(Number(gift.g)) : undefined;
    // 無料ギフトは記録しない（有名配信者だとシートが埋まりすぎるため）。
    // WSイベント側の gt フラグは無料ギフトでも2(有料)になることがあり信用できないため、
    // ギフトマスタの free フラグで判定する。マスタが取得できていない場合は
    // 判定できないので記録しておく（取りこぼしを避ける）。
    if (master?.free === true) return;

    const config = await this.getConfig();
    const point = master?.point ?? null;
    const totalG = point !== null && gift.n !== null ? point * gift.n : null;

    const entry: GiftLogEntry = {
      receivedAt: new Date().toISOString(),
      sentAt: gift.created_at ? new Date(gift.created_at * 1000).toISOString() : null,
      roomId: config.roomId,
      roomName: config.roomName,
      senderName: gift.ac,
      userId: gift.u,
      userAttribute: gift.ua,
      giftId: gift.g,
      giftName: master?.name ?? null,
      giftImage: master?.image || null,
      num: gift.n,
      giftType: gift.gt,
      point,
      totalG,
      sheetSynced: false,
      sheetError: null,
    };

    await this.pushGiftLog(entry);

    try {
      await appendGiftRow(this.env, entry);
      entry.sheetSynced = true;
      await this.updateLastGiftLogEntry(entry);
    } catch (err: any) {
      entry.sheetError = String(err?.message ?? err);
      await this.updateLastGiftLogEntry(entry);
      await this.setLastError(`スプレッドシート書き込み失敗: ${entry.sheetError}`);
    }
  }

  private async pushGiftLog(entry: GiftLogEntry): Promise<void> {
    const log = (await this.state.storage.get<GiftLogEntry[]>(STORAGE_KEYS.giftLog)) ?? [];
    log.unshift(entry);
    if (log.length > MAX_GIFT_LOG) log.length = MAX_GIFT_LOG;
    await this.state.storage.put(STORAGE_KEYS.giftLog, log);
  }

  private async updateLastGiftLogEntry(entry: GiftLogEntry): Promise<void> {
    const log = (await this.state.storage.get<GiftLogEntry[]>(STORAGE_KEYS.giftLog)) ?? [];
    if (log.length > 0 && log[0].receivedAt === entry.receivedAt) {
      log[0] = entry;
      await this.state.storage.put(STORAGE_KEYS.giftLog, log);
    }
  }
}
