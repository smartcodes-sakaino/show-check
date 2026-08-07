# show-check

SHOWROOM で特定の配信者に投げられたギフトを検知して、Google スプレッドシートに自動で行を追記する個人用ツールです。

- 配信していない間は数十秒〜1分間隔でポーリングし、配信開始を自動検知します
- 配信中は SHOWROOM の WebSocket に接続しっぱなしにしてギフトをリアルタイム検知します（Durable Object の Alarm / outbound WebSocket を利用）
- スマホからも使える簡易管理画面（ルーム設定・監視ON/OFF・状態確認・ギフトログ）付き
- Cloudflare Workers + Durable Objects 上で動作し、追加インフラ不要でデプロイできます

> ⚠️ 使用している SHOWROOM の API / WebSocket はすべて非公式です。仕様変更で突然動かなくなる可能性があります。
> [`src/showroom.ts`](src/showroom.ts) にエンドポイント・フィールド名の想定をまとめてあるので、実際の挙動と違う場合はここを直してください（詳細は本READMEの「非公式APIについて」を参照）。

## 構成

```
src/
  index.ts        Worker のエントリポイント（ルーティング・認証・静的配信）
  roomMonitor.ts   Durable Object 本体（ポーリング・WebSocket・再接続・ギフト検知）
  showroom.ts      SHOWROOM 非公式APIクライアント
  sheets.ts        Google Sheets 書き込み（サービスアカウントJWT認証）
  types.ts         型定義
public/
  index.html/app.js/style.css   管理画面（ビルド不要の素のHTML/JS）
```

単一の Cloudflare Worker が API・管理画面（静的アセット）・Durable Object をすべて配信します。Cloudflare Pages は使いません。

## 事前準備

1. **Cloudflare アカウント** と `wrangler` の認証
   ```bash
   npx wrangler login
   ```
2. **Google サービスアカウント**（Google Cloud Console）
   - プロジェクトを作成し、Google Sheets API を有効化
   - サービスアカウントを作成し、JSONキーをダウンロード
   - 対象のスプレッドシートを、サービスアカウントのメールアドレスに「編集者」として共有
3. **書き込み先スプレッドシート**を用意し、以下の列でヘッダー行を作っておく（任意）
   ```
   受信日時 / ルーム / 送信者 / ユーザー種別 / ギフトID / 個数 / 無料・有料
   ```

## ローカル開発

```bash
npm install
cp .dev.vars.example .dev.vars   # 値を埋める
npm run dev
```

`http://localhost:8787` で管理画面が開きます。`.dev.vars` の `ADMIN_TOKEN` に設定した合言葉でログインします。

## デプロイ

```bash
npm install
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put GOOGLE_CLIENT_EMAIL
npx wrangler secret put GOOGLE_PRIVATE_KEY
npx wrangler secret put GOOGLE_SHEET_ID
npx wrangler secret put GOOGLE_SHEET_NAME   # 省略可（未設定なら "Sheet1"）
npm run deploy
```

`GOOGLE_PRIVATE_KEY` は JSON キーの `private_key` の値をそのまま貼り付けてください（`\n` を含む1行の文字列でOK。`wrangler secret put` はそのまま貼れます）。

デプロイ後、`https://show-check.<あなたのサブドメイン>.workers.dev` にアクセスして、合言葉（`ADMIN_TOKEN`）でログインし、監視対象ルームを設定 → 監視を開始してください。

## 使い方

1. 管理画面にログイン（`ADMIN_TOKEN` を入力、ブラウザに保存されます）
2. 「監視対象ルームの設定」にルームURL（例: `https://www.showroom-live.com/xxxxx`）または `room_id` を入力して保存
3. 「監視を開始」を押す
4. 配信していないときは自動でポーリング、配信が始まると自動でWebSocket接続に切り替わり、ギフトを検知するたびにスプレッドシートへ1行追記されます
5. 配信が終わると自動でポーリングモードに戻ります（手動で「監視を停止」すれば完全に監視をやめられます）

## 非公式APIについて（実装時に要確認）

以下は非公式APIのため未確定です。動作しない場合は [`src/showroom.ts`](src/showroom.ts) を実データに合わせて調整してください。

- ルームIDの解決: `GET /api/room/profile?room_url_key=...`
- 配信中判定 / `bcsvr_key` 取得: `GET /api/live/live_info?room_id=...` の `live_status` フィールド
- ギフトWebSocket: `wss://online.showroom-live.com/` に接続後 `SUB\t{bcsvr_key}` を送信、`MSG\t{bcsvr_key}\t{json}` 形式で受信
- ギフト判定: JSONの `t` フィールドが `"2"`、またはキー数が12個の場合をギフトとみなす（キー数9はコメントとして無視）

これらのエンドポイント・判定ロジックは、実際にブラウザの開発者ツール等で通信を確認しながら調整することを想定しています。

## 運用上の注意

- Durable Object の課金は接続がアクティブな間の Duration ベースです。配信終了を検知したら速やかに WebSocket を切断するようにしています
- ポーリング間隔はデフォルト45秒です（`src/roomMonitor.ts` の `POLL_INTERVAL_MS`）。SHOWROOM側への負荷を考え、極端に短くしないでください
- 管理画面・APIは `ADMIN_TOKEN` による簡易認証のみです。第三者に合言葉を教えないでください
