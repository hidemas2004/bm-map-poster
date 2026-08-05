// 見た目・地域設定の調整値。地域を入れ替える際はこのファイルを書き換えるだけでよい。
// scripts/new-region.mjs により地域固有部分（表示名・中心座標・ズーム）が自動生成される。

// 対象地域表示名・地図初期中心座標・初期ズームレベル（汎用化設計）
const REGION_DISPLAY_NAME = '大和市';
const MAP_INITIAL_CENTER = [35.4717, 139.4549]; // 掲示板データ全体のbbox中心
const MAP_INITIAL_ZOOM = 13;

// ステータスごとのピン色（worker/boards.tsのBOARD_STATUSESと対応。値・順序を変える場合は両方直すこと）
const STATUS_COLORS = {
	未着手: '#6b7280', // グレー
	貼付済: '#16a34a', // 緑
	トラブル: '#dc2626', // 赤
};
const STATUS_LABELS = Object.keys(STATUS_COLORS);

// GPS現在地マーカー
const GPS_DOT_COLOR = '#2563eb';
const GPS_DOT_RADIUS_PX = 8;
