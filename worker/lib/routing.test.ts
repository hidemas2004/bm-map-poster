import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOrsGeoJsonRoute, RoutingServiceError } from './routing.ts';

test('parseOrsGeoJsonRoute: 正常なGeoJSONから座標列(LatLng[])を取り出す', () => {
	const body = {
		features: [
			{
				geometry: {
					coordinates: [
						[139.4549, 35.4717],
						[139.456, 35.472],
					],
				},
			},
		],
	};
	assert.deepEqual(parseOrsGeoJsonRoute(body), [
		{ lat: 35.4717, lng: 139.4549 },
		{ lat: 35.472, lng: 139.456 },
	]);
});

test('parseOrsGeoJsonRoute: featuresが空配列ならRoutingServiceError', () => {
	assert.throws(() => parseOrsGeoJsonRoute({ features: [] }), RoutingServiceError);
});

test('parseOrsGeoJsonRoute: featuresが無ければRoutingServiceError', () => {
	assert.throws(() => parseOrsGeoJsonRoute({}), RoutingServiceError);
});

test('parseOrsGeoJsonRoute: geometry.coordinatesが無ければRoutingServiceError', () => {
	assert.throws(() => parseOrsGeoJsonRoute({ features: [{ geometry: {} }] }), RoutingServiceError);
});

test('parseOrsGeoJsonRoute: 座標が数値ペアでなければRoutingServiceError', () => {
	assert.throws(
		() => parseOrsGeoJsonRoute({ features: [{ geometry: { coordinates: [['a', 'b']] } }] }),
		RoutingServiceError,
	);
});

test('parseOrsGeoJsonRoute: bodyがオブジェクトでなければRoutingServiceError', () => {
	assert.throws(() => parseOrsGeoJsonRoute(null), RoutingServiceError);
	assert.throws(() => parseOrsGeoJsonRoute('not an object'), RoutingServiceError);
});
