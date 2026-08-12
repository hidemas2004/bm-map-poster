/**
 * 「経路表示」機能向けの道路ルート取得エンドポイント。掲示板データや担当者情報は一切扱わず、
 * 認証済みユーザーから受け取った経由地の座標列をOpenRouteServiceに中継するだけのプロキシ。
 * APIキー(env.ORS_API_KEY)をクライアントに渡さずWorker側に留めるためにこの層を挟んでいる。
 */
import type { LatLng } from './lib/geodetic.ts';
import { fetchWalkingRoute, RoutingServiceError } from './lib/routing.ts';

export interface RouteEnv {
	ORS_API_KEY: string;
}

function isFiniteLatLng(value: unknown): value is LatLng {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as LatLng).lat === 'number' &&
		typeof (value as LatLng).lng === 'number' &&
		Number.isFinite((value as LatLng).lat) &&
		Number.isFinite((value as LatLng).lng)
	);
}

export async function fetchRoadRoute(request: Request, env: RouteEnv): Promise<Response> {
	const body = await request.json<{ waypoints?: unknown }>().catch(() => ({}) as { waypoints?: unknown });
	const waypoints = body.waypoints;

	if (!Array.isArray(waypoints) || waypoints.length < 2 || !waypoints.every(isFiniteLatLng)) {
		return Response.json({ error: 'waypoints には2件以上の座標（lat/lng）を指定してください' }, { status: 400 });
	}

	try {
		const coordinates = await fetchWalkingRoute(waypoints, env.ORS_API_KEY);
		return Response.json({ coordinates });
	} catch (err) {
		if (err instanceof RoutingServiceError) {
			return Response.json({ error: '道路ルートの取得に失敗しました' }, { status: 502 });
		}
		throw err;
	}
}
