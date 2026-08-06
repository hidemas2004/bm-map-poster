# bm-map-poster

選挙の公営掲示板（ポスター掲示場）の位置を地図上で管理し、選挙告示日以降の貼付進捗を
リアルタイムに把握するためのツール。陣営内部限定。姉妹プロジェクト `bm-map-posting`
（ポスティング管理）と同じ設計思想（Cloudflare Workers単一エントリポイント・ビルドレス・
認証の差し替え可能設計）を踏襲しているが、別リポジトリ・別D1として完全に独立している
（ユーザーマスタも共有しない）。

## 背景・目的

日本の選挙では、選挙期間中は公営の掲示板のみに選挙ポスターの掲示が認められる。選挙区内全域の
掲示板位置を事前に把握し、貼付要員を待機させておき、告示日に掲示板番号（掲示枠の割当）が
判明したら一斉に貼付を開始する必要がある。本ツールは、事前に把握した掲示板位置にピンを立て、
担当者を割り当て、貼付完了ごとにステータスを更新していくための地図ベースの管理画面を提供する。

## 構成

- Cloudflare Workers（`worker/index.ts`）が静的アセット配信とAPIを兼ねる単一エントリポイント。
  ビルドステップは無し（素のHTML/CSS/JS、Leaflet.jsをCDNから読み込み）。
- データはCloudflare D1（`worker/index.ts` の `DB` バインディング）。掲示板マスタ
  （`poster_boards`）1テーブルに位置・住所・ステータス・担当者を持つ、bm-map-postingより
  シンプルな構造（ターム（配布期間）や「エリア/区画」の二重構造は無い。選挙単位の単発イベント
  のため）。
- 認証はユーザーマスタ方式（`users` テーブル）。bm-map-postingと同じ実装（`worker/auth.ts`）を
  踏襲しているが、テーブルもD1も完全に別（担当者名簿を共有したい場合は、両システムに同じCSVを
  それぞれインポートする運用でよい）。

## 用語・データモデル

- **掲示板**（`poster_boards`テーブル、`board_id`で識別）: 選挙公営掲示板1箇所。位置座標
  （`lat`/`lng`）・住所（`address`）・目印（`location_note`）・ステータス・担当者を持つ。
  `board_id`は自治体採番の掲示板番号をそのまま使う（例: 大和市の場合「1-1」のような
  投票区番号-連番形式。自治体により表記は異なる）。
- **ステータス**: `未着手` / `貼付済` / `トラブル` の3値。地図上のピンはステータスに応じて
  色分けされる（`public/config.js`の`STATUS_COLORS`）。`貼付済`に変更すると`posted_at`
  （貼付日時）が自動更新される。
- **担当者**: `users`テーブルの1行。掲示板1件につき1名まで割り当てられる。

## コマンド

```bash
npm install
npx wrangler dev      # ローカル確認。.dev.vars.example を参考に .dev.vars を作成しておく
npx wrangler deploy   # 本番デプロイ（要 Cloudflare 認証・D1本番データベース作成）
```

### ローカルD1の初期化

```bash
npx wrangler d1 execute bm-poster-db --local --file=migrations/0001_init.sql
npx wrangler d1 execute bm-poster-db --local --file=seed/boards_yamato.sql
npx wrangler d1 execute bm-poster-db --local --file=seed/users.sql
```

## シークレット・環境変数

`.dev.vars.example` を `.dev.vars` にコピーして値を設定する（`.dev.vars` はgit管理対象外）。
本番はCloudflareの `wrangler secret put <NAME>` で設定する。

| 変数名 | 用途 |
|---|---|
| `SESSION_SECRET` | ログインセッショントークンの署名鍵 |

## 地図画面

- 掲示板マスタの座標位置にしずく型のピンを表示（中央に白丸）。ピンはステータス
  （`未着手`=濃いめのブルー / `貼付済`=オレンジ / `トラブル`=赤。`public/config.js`の
  `STATUS_COLORS`で定義）によって色分けされる。
- ピンをタップするとポップアップが開き、ステータス・担当者・メモの変更が可能（更新は
  `POST /api/board/update`。ステータス・担当者の変更内容は`poster_activity_log`に自動記録される。
  メモの変更は記録対象外）。
- ヘッダの「ラベル表示」チェックボックス（既定OFF）をONにすると、各ピンに`board_id`が
  ラベル表示される。
- ヘッダの担当者フィルタで、選択した担当者の掲示板のみに絞り込める。
- ヘッダのステータスフィルタ（3つのトグルボタン、ピンと同じ色）で、表示するステータスを選べる
  （複数選択可。既定は全表示）。フィルタで対象外になったピンは地図から消えるのではなく、
  薄い表示（半透明）になる。

## 掲示板マスタのCSVインポート/エクスポート（`public/boards.html`、管理者限定）

- `GET /api/boards/export`: 現在の掲示板マスタをCSVでダウンロード。
- `POST /api/boards/import`: CSV（`Content-Type: text/csv`、生テキストをそのままPOST）を
  読み込み、`board_id`が既存ならUPSERT、なければ新規追加。
  - CSVヘッダ: `board_id, address, location_note, lat, lng, status, assignee_id, memo`
    （`board_id, lat, lng` のみ必須）。
  - `assignee_id`列はセルの内容がそのまま反映される（空欄=担当者なし。担当者の一括割り当ては
    この列をまとめて編集してアップロードすればよい）。
  - `status`列を空欄のままにすると、既存の掲示板は現在のステータスを維持し（選挙当日に
    貼付状況を誤って巻き戻さないため）、新規の掲示板は「未着手」になる。
  - `memo`列はセルの内容がそのまま反映される（空欄=メモなし。`address`/`location_note`と同様の
    扱いで、`status`のような「空欄=変更なし」特別扱いはしない）。
  - 想定運用: CSVダウンロード → 表計算ソフトで担当者列などを編集 → アップロード。

## 掲示板マスタCSVの変換

自治体が配布する掲示場一覧CSVは自治体ごとに形式がまちまちなため、`scripts/lib/convert-<自治体名>-boards.mjs`
のような専用の変換スクリプトを自治体ごとに用意し、`POST /api/boards/import`が読める正規化済み
CSV（または直接投入用のSQL）に変換する。

実例: `scripts/lib/convert-yamato-boards.mjs`（大和市）

```bash
# 元CSVがShift-JISの場合は先にUTF-8へ変換
iconv -f SHIFT_JIS -t UTF-8 -o senkyo_utf8.csv senkyo.csv

node scripts/lib/convert-yamato-boards.mjs senkyo_utf8.csv seed/boards_yamato.sql
```

大和市のCSVは投票所一覧・期日前投票所一覧・掲示場一覧の3つの表がヘッダー行ごと縦に連結された
形式で、`名称`列が`<投票区番号>-<連番>`（例: `1-1`）の行だけを掲示場一覧として抽出している
（一部の投票区で全角風のハイフン類似記号が使われる表記揺れがあるため正規化してから判定する）。
「緯度・経度」列は`経度:緯度`の形式で1セルに結合されている。

他の自治体を追加する場合、同じ変換ロジックが通用するとは限らない（列構成・座標の有無・
座標の結合形式などはCSVごとに異なりうる）。`convert-yamato-boards.mjs`を参考に、対象自治体の
CSVに合わせた変換スクリプトを新規に書くこと。

## 履歴の閲覧とCSVエクスポート（`public/history.html`）

ステータス・担当者の変更履歴（`poster_activity_log`）を一覧表示・CSVダウンロードできる
（`GET /api/activity-log` / `GET /api/activity-log/export`）。全ログイン済みユーザーが閲覧可。

## ユーザーマスタの管理（`public/users.html`、管理者限定）

bm-map-postingの`users.ts`と同一実装。`GET /api/users` / `GET /api/users/export` /
`POST /api/users/import` の3つとも管理者限定。詳細は`worker/users.ts`のコメント参照。

## 複数地域の並行運用

大和市とは別に複数の市区町村を**並行して**稼働させる場合、bm-map-postingと同じ方式
（`wrangler.jsonc`の`env.<地域ID>`）で追加する。

```bash
npx wrangler login   # 初回のみ
npm run new-region
```

対話形式で以下を順に行う（`Ctrl+C`で中断しても、地域IDを指定して再実行すれば完了済みの
ステップはスキップして続きから再開できる）:

1. 地域ID（例: `202704-hiratsuka`）・表示名を入力
2. 掲示板マスタSQL（`regions/<id>/boards.sql`）の準備。自治体向けの変換スクリプトが
   無ければ「掲示板マスタCSVの変換」を参照して新規に用意する
3. 掲示板データのbboxから地図初期座標を自動算出（上書き可）・`regions/<id>/config.js`を生成
4. 初期管理者ユーザーを1名だけ登録（以降の担当者追加はデプロイ後に`/users.html`のCSV
   インポートで行う）
5. D1データベースを新規作成し、`wrangler.jsonc`に`env.<id>`ブロックを追記
6. マイグレーション・掲示板マスタ・管理者ユーザーを新D1へ投入
7. `SESSION_SECRET`を自動生成し`wrangler secret put`で設定（値は画面に表示されない）
8. **ここまでの入力内容を一覧表示し、「この内容でデプロイしてよいか」を確認**
9. 確認後、`public/config.js`を該当地域の内容に切り替えて `wrangler deploy --env <id>`を実行

- 各地域の設定は `regions/<地域ID>/`（`meta.json`・`config.js`・`boards.sql`）にまとめて
  保存される。**合言葉などの秘密情報はここには保存されない**（OS一時ディレクトリ経由で
  D1に投入後、即削除する設計）。
- デプロイ後、ローカルの`public/config.js`には直前にデプロイした地域の内容が残る。別地域を
  扱う際は改めてこのスクリプトを実行すれば自動的に切り替わる。
- スクリプト本体は `scripts/new-region.mjs`（オーケストレーション）、
  `scripts/lib/wrangler-jsonc.mjs`（`wrangler.jsonc`への安全な追記）、
  `scripts/lib/config-template.mjs`（`config.js`生成・bbox中心計算）に分かれている
  （bm-map-postingと同じ分割方針。e-Stat境界データ取得に相当するステップはbm-map-posterには
  無い）。

## 既知の制約・今後の作業

- **対象地域は大和市のみ**（2026-08時点）。他自治体を追加する場合は「掲示板マスタCSVの変換」
  の手順に沿って専用の変換スクリプトを用意し、「複数地域の並行運用」の手順で追加する。
- **座標データの精度**: 大和市の掲示場一覧CSVは緯度経度を含んでいたためそのまま利用できたが、
  住所文字列しか含まないCSVを配布する自治体の場合、別途ジオコーディング（住所→緯度経度変換）
  が必要になる。現状は未対応。
- **オフライン耐性は未対応**: 告示日当日、電波の弱い場所での使用も想定されるが、通信断時に
  ステータス変更をローカルに保持して後で同期する仕組み（Service Worker等）は無い。
- **同時編集の排他制御は無し**: 複数人が同じ掲示板をほぼ同時に更新した場合、後勝ちで上書きされる
  （実運用上、1ピンに複数人が同時に貼付作業をすることは考えにくいため許容している）。
- **`npm run new-region`は未検証**: 2つ目以降の地域を`env.<id>`として並行追加するフローは、
  実機のCloudflare環境でまだ実行したことがない。初めて実行する際は各ステップの出力
  （特に`wrangler d1 create`の`database_id`抽出）を確認しながら進めること
  （大和市（トップレベル設定）は本番デプロイ済み）。
