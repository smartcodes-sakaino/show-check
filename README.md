# show-check

SHOWROOM で特定の配信者に投げられたギフトを検知して、Google スプレッドシートに自動で行を追記する個人用ツールです。

- 配信していない間は数十秒〜1分間隔でポーリングし、配信開始を自動検知します
- 配信中は SHOWROOM の WebSocket に接続しっぱなしにしてギフトをリアルタイム検知します（Durable Object の Alarm / outbound WebSocket を利用）
- ギフトのG換算値（個数 × ギフト単価）を自動計算してシートに記録します
- スマホからも使える簡易管理画面（ルーム設定・監視ON/OFF・状態確認・ギフトログ・日別集計）付き
- Cloudflare Workers + Durable Objects 上で動作し、追加インフラ不要でデプロイできます

> ⚠️ 使用している SHOWROOM の API / WebSocket はすべて非公式です。仕様変更で突然動かなくなる可能性があります。
> [`src/showroom.ts`](src/showroom.ts) にエンドポイント・フィールド名の想定をまとめてあります。2026-08-07 時点で実際に本番へリクエストを送り、配信中ルームで実データ（配信中判定・ギフトWebSocket・ギフトマスタ）を確認した内容がベースになっています。

## 構成

```
src/
  index.ts        Worker のエントリポイント（ルーティング・認証・静的配信・履歴集計API）
  roomMonitor.ts   Durable Object 本体（ポーリング・WebSocket・再接続・ギフト検知）
  showroom.ts      SHOWROOM 非公式APIクライアント（ルーム解決・配信判定・ギフトマスタ）
  sheets.ts        Google Sheets 読み書き（サービスアカウントJWT認証・日別集計）
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
3. **書き込み先スプレッドシート**を用意する。ヘッダー行は必須ではない（1列目がISO8601日時で始まらない行は集計時に自動的に無視されるので、あっても無くても動く）

## ローカル開発

```bash
npm install
cp .dev.vars.example .dev.vars   # 値を埋める
npm run dev
```

`http://localhost:8787` で管理画面が開きます。`.dev.vars` の `ADMIN_TOKEN` に設定した合言葉でログインします。

> 注意: SHOWROOMへの outbound WebSocket 接続は、ローカルの `wrangler dev`（Miniflare）では動作確認できません（`Fetch API cannot load` エラーになる既知の制約）。これは実際にデプロイした本番環境（Cloudflareのエッジ）でのみ動く、正式にサポートされた実装方式です。ルーム解決・配信中判定・履歴集計など、それ以外の機能はローカルでも動作確認できます。

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
2. 「監視対象ルームの設定」にルームURL（例: `https://www.showroom-live.com/r/xxxxx`）または `room_id` を入力して保存
   - URLを入力した場合はページを取得して自動的に `room_id` を解決します（`room_id` そのものが分かっていれば数値のみの入力でもOK）
3. 「監視を開始」を押す
4. 配信していないときは自動でポーリング、配信が始まると自動でWebSocket接続に切り替わり、ギフトを検知するたびにスプレッドシートへ1行追記されます
5. 配信が終わると自動でポーリングモードに戻ります（手動で「監視を停止」すれば完全に監視をやめられます）
6. 「履歴・集計」から日付を選ぶと、その日に投げられたギフトを送信者ごとに集計してG合計順に表示します。行をタップすると内訳（ギフト名×個数）が開きます。「コピー用テキストをコピー」でランキングをそのままコピーできます

## スプレッドシートの列

シートには以下の列で1行ずつ追記されます。

| 列 | 内容 |
|---|---|
| A | 受信日時（ISO8601、UTC） |
| B | ルーム名 / ID |
| C | 送信者名 |
| D | ユーザー種別（ビギナー/初見/リピーター） |
| E | ギフト名（英語表記。SHOWROOM側APIが英語名しか返さないため） |
| F | ギフトID |
| G | 個数 |
| H | G（個数 × 送信時点でのギフト単価） |
| I | 無料 / 有料 |

H列（G）は送信時点のギフト単価で計算して確定値として保存しているため、後でSHOWROOM側の単価が変わっても過去の記録は変わりません。日別集計（管理画面の「履歴・集計」）はこのシートを読み直して都度計算しています。

## 非公式APIについて

[`src/showroom.ts`](src/showroom.ts) にまとめている非公式APIは、2026-08-07 時点で実際に配信中のルームに対して検証済みです。

- ルームIDの解決: `room_id=` クエリなしのURL・スラッグは `https://www.showroom-live.com/r/<key>` 等のページHTMLを取得し、`room/profile?room_id=(\d+)` のパターンから抽出（`/api/room/profile?room_url_key=` のようなAPIは存在しなかったため使用していない）
- 配信中判定 / `bcsvr_key` 取得: `GET /api/live/live_info?room_id=...` の `live_status`（`2`=配信中で確認済み）。`HTTP 403`（`in private mode`）は配信していない時によく返る通常のレスポンスなので「未配信」として扱い、`HTTP 404` はroom_id自体が不正な場合として扱う
- ギフトマスタ: `GET /api/live/gift_list?room_id=...`（`normal`/`enquete` の2配列、`gift_id`/`gift_name`/`point` を含む。名前は英語表記のみ確認できた）
- ギフトWebSocket: `wss://online.showroom-live.com/` に接続後 `SUB\t{bcsvr_key}` を送信、`MSG\t{bcsvr_key}\t{json}` 形式で受信
- ギフト判定: JSONの `t` フィールドが `"2"` の場合のみギフト（`"1"`=コメント、`"8"`=テロップ更新、`"18"`=ファンレベルアップ通知等。キー数はイベント種別によって変動するため使用していない）

非公式APIである以上、SHOWROOM側の仕様変更で動かなくなるリスクは残ります。挙動が変わった場合は上記のエンドポイントを実データで確認し直してください。

## 運用上の注意

- Durable Object の課金は接続がアクティブな間の Duration ベースです。配信終了を検知したら速やかに WebSocket を切断するようにしています
- ポーリング間隔はデフォルト45秒です（`src/roomMonitor.ts` の `POLL_INTERVAL_MS`）。SHOWROOM側への負荷を考え、極端に短くしないでください
- 管理画面・APIは `ADMIN_TOKEN` による簡易認証のみです。第三者に合言葉を教えないでください
