-- 掲示板マスタにメモ欄を追加（地図ポップアップから自由記述で編集できる備考欄）。
ALTER TABLE poster_boards ADD COLUMN memo TEXT NOT NULL DEFAULT '';
