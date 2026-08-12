import type { LatLng } from './geodetic.ts';

/**
 * ルーティングAPI自体の呼び出し失敗（ネットワークエラー・タイムアウト・非2xx・
 * レスポンス形式異常）を表す。geocode.tsのGeocodeServiceErrorと同じ役割。
 */
export class RoutingServiceError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'RoutingServiceError';
	}
}

const ORS_DIRECTIONS_URL = 'https://api.openrouteservice.org/v2/directions/foot-walking/geojson';
const DEFAULT_TIMEOUT_MS = 8000;

/**
 * OpenRouteService Directions APIのGeoJSONレスポンスから経路座標列を取り出す純粋関数。
 * `features[0].geometry.coordinates`は`[lng, lat]`の配列なので`LatLng[]`に変換する。
 */
export function parseOrsGeoJsonRoute(body: unknown): LatLng[] {
	if (typeof body !== 'object' || body === null || !('features' in body)) {
		throw new RoutingServiceError('ORS APIのレスポンス形式が不正です（featuresがありません）');
	}
	const features = (body as { features?: unknown }).features;
	if (!Array.isArray(features) || features.length === 0) {
		throw new RoutingServiceError('ORS APIのレスポンスに経路が含まれていません');
	}
	const geometry = (features[0] as { geometry?: unknown }).geometry;
	const coordinates = (geometry as { coordinates?: unknown } | undefined)?.coordinates;
	if (!Array.isArray(coordinates) || coordinates.length === 0) {
		throw new RoutingServiceError('ORS APIのレスポンスに座標列が含まれていません');
	}

	return coordinates.map((point) => {
		if (!Array.isArray(point) || point.length < 2 || typeof point[0] !== 'number' || typeof point[1] !== 'number') {
			throw new RoutingServiceError('ORS APIの座標列の形式が不正です');
		}
		const [lng, lat] = point;
		return { lat, lng };
	});
}

/**
 * OpenRouteService Directions API（徒歩プロファイル）で、指定順の経由地を結ぶ道路沿いの
 * 経路座標列を取得する。waypointsの訪問順序はそのまま維持され、最適化（並べ替え）は行わない。
 */
export async function fetchWalkingRoute(
	waypoints: LatLng[],
	apiKey: string,
	opts: { timeoutMs?: number } = {},
): Promise<LatLng[]> {
	if (waypoints.length < 2) {
		throw new RoutingServiceError('経路の計算には2件以上の地点が必要です');
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	try {
		let res: Response;
		try {
			res = await fetch(ORS_DIRECTIONS_URL, {
				method: 'POST',
				signal: controller.signal,
				headers: {
					'Content-Type': 'application/json',
					Authorization: apiKey,
				},
				body: JSON.stringify({ coordinates: waypoints.map((p) => [p.lng, p.lat]) }),
			});
		} catch (cause) {
			throw new RoutingServiceError('ORS APIへの接続に失敗しました', { cause });
		}
		if (!res.ok) {
			throw new RoutingServiceError(`ORS APIがエラーを返しました (status ${res.status})`);
		}

		let body: unknown;
		try {
			body = await res.json();
		} catch (cause) {
			throw new RoutingServiceError('ORS APIのレスポンスがJSONとして解釈できません', { cause });
		}

		return parseOrsGeoJsonRoute(body);
	} finally {
		clearTimeout(timer);
	}
}
