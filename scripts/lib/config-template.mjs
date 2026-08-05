/**
 * public/config.js のうち地域非依存の調整値（ステータス色等）。新しい地域固有の値
 * （表示名・中心座標・ズーム）だけ差し替えて regions/<id>/config.js を生成する。
 */
export function buildConfigJs({ displayName, center, zoom }) {
	return `// 見た目・地域設定の調整値。地域を入れ替える際はこのファイルを書き換えるだけでよい。
// scripts/new-region.mjs により自動生成（地域固有部分のみ）。ステータス色は共通テンプレート。

// 対象地域表示名・地図初期中心座標・初期ズームレベル（汎用化設計）
const REGION_DISPLAY_NAME = '${displayName}';
const MAP_INITIAL_CENTER = [${center[0]}, ${center[1]}]; // ${displayName}の掲示板データ全体のbbox中心
const MAP_INITIAL_ZOOM = ${zoom};

// ステータスごとのピン色（worker/boards.tsのBOARD_STATUSESと対応。値・順序を変える場合は両方直すこと）
const STATUS_COLORS = {
	未着手: '#6b7280',
	貼付済: '#16a34a',
	トラブル: '#dc2626',
};
const STATUS_LABELS = Object.keys(STATUS_COLORS);

// GPS現在地マーカー
const GPS_DOT_COLOR = '#2563eb';
const GPS_DOT_RADIUS_PX = 8;
`;
}

/** 掲示板データ（{lat, lng}の配列）全体のbboxの中心を [lat, lng] で返す。 */
export function computeCenterFromBoards(boards) {
	let minLat = Infinity;
	let maxLat = -Infinity;
	let minLng = Infinity;
	let maxLng = -Infinity;

	for (const b of boards) {
		if (b.lat < minLat) minLat = b.lat;
		if (b.lat > maxLat) maxLat = b.lat;
		if (b.lng < minLng) minLng = b.lng;
		if (b.lng > maxLng) maxLng = b.lng;
	}

	if (!Number.isFinite(minLat)) throw new Error('掲示板データから座標を抽出できませんでした');

	const round = (n) => Math.round(n * 10000) / 10000;
	return [round((minLat + maxLat) / 2), round((minLng + maxLng) / 2)];
}
