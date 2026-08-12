/**
 * /config.js を地域ごとの env（wrangler.jsonc の vars）から動的生成する。
 * 地域固有の値（表示名・地図初期座標・ズーム）のみ env から埋め込み、
 * 色等の見た目パラメータは全地域共通としてここに一本化する
 * （旧 scripts/lib/config-template.mjs は public/config.js との内容ドリフトが生じていたため廃止）。
 */

export interface ConfigEnv {
	REGION_DISPLAY_NAME: string;
	MAP_CENTER_LAT: number;
	MAP_CENTER_LNG: number;
	MAP_ZOOM: number;
}

export function buildConfigResponse(env: ConfigEnv): string {
	return `// 見た目・地域設定の調整値。worker/config.ts が env（wrangler.jsonc の vars）から動的生成する。

// 対象地域表示名・地図初期中心座標・初期ズームレベル（地域ごとに異なる）
const REGION_DISPLAY_NAME = ${JSON.stringify(env.REGION_DISPLAY_NAME)};
const MAP_INITIAL_CENTER = [${env.MAP_CENTER_LAT}, ${env.MAP_CENTER_LNG}];
const MAP_INITIAL_ZOOM = ${env.MAP_ZOOM};

// ステータスごとのピン色（worker/boards.tsのBOARD_STATUSESと対応。値・順序を変える場合は両方直すこと）
const STATUS_COLORS = {
	未着手: '#1d4ed8',
	貼付済: '#f97316',
	トラブル: '#dc2626',
};
const STATUS_LABELS = Object.keys(STATUS_COLORS);

// GPS現在地マーカー
const GPS_DOT_COLOR = '#2563eb';
const GPS_DOT_RADIUS_PX = 8;

// フィルタ対象外のピンの不透明度（0〜1）。地図から消さず薄く表示し、全体の中での位置関係が
// 分かるようにする（issue#4）。
const FILTERED_OUT_OPACITY = 0.15;
`;
}
