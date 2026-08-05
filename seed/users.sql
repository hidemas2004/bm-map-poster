-- 初期ユーザー（開発・動作確認用）。本番投入前に合言葉を変更すること。
INSERT INTO users (user_id, name, passphrase, role, active) VALUES ('admin', '管理者', 'admin-pass', '管理者', 1);
INSERT INTO users (user_id, name, passphrase, role, active) VALUES ('sato', '佐藤', 'sato-pass', '一般', 1);
INSERT INTO users (user_id, name, passphrase, role, active) VALUES ('suzuki', '鈴木', 'suzuki-pass', '一般', 1);
