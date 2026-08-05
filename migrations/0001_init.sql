-- ポスター掲示板管理システム 初期スキーマ

CREATE TABLE users (
  user_id      TEXT PRIMARY KEY,     -- 例: yamada
  name         TEXT NOT NULL,        -- 表示名。例: 山田太郎
  passphrase   TEXT NOT NULL,        -- 合言葉（平文）
  role         TEXT NOT NULL DEFAULT '一般',  -- '管理者' | '一般'
  active       INTEGER NOT NULL DEFAULT 1     -- 0=ログイン不可
);

-- 掲示板マスタ。1行=1掲示場所（選挙単位の単発イベントのためbm-map-postingの
-- ターム（配布期間）概念は持たない。board_idは自治体採番の掲示板番号をそのまま使う
-- （例: 大和市の場合「1-1」のような投票区番号-連番形式。自治体により表記は異なる）。
CREATE TABLE poster_boards (
  board_id       TEXT PRIMARY KEY,
  address        TEXT NOT NULL DEFAULT '',   -- 住所（自治体CSVの表記そのまま。町丁目等への構造化はしない）
  location_note  TEXT NOT NULL DEFAULT '',   -- 目印情報（例: 北大和小学校西門横）
  lat            REAL NOT NULL,
  lng            REAL NOT NULL,
  status         TEXT NOT NULL DEFAULT '未着手',  -- '未着手' | '貼付済' | 'トラブル'
  assignee_id    TEXT REFERENCES users(user_id),
  assignee_name  TEXT NOT NULL DEFAULT '',   -- users から複製（表示高速化用）
  posted_at      TEXT                        -- ステータスが'貼付済'になった直近日時。それ以外では変更しない
);

-- ステータス・担当者の変更履歴（bm-map-postingのactivity_logに相当）。
CREATE TABLE poster_activity_log (
  log_id             INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id           TEXT NOT NULL REFERENCES poster_boards(board_id),
  updated_at         TEXT NOT NULL,   -- ISO日時。自動記録
  user_id            TEXT NOT NULL REFERENCES users(user_id),
  user_name          TEXT NOT NULL,   -- users から複製（スナップショット）
  old_status         TEXT NOT NULL,
  new_status         TEXT NOT NULL,
  old_assignee_name  TEXT NOT NULL DEFAULT '',
  new_assignee_name  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_poster_activity_log_board ON poster_activity_log(board_id);
