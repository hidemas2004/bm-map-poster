import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBoardsCsv, computeCenterFromBoards } from './boards-bbox.mjs';

test('parseBoardsCsv: ヘッダに沿って各列を抽出する', () => {
	const csv = 'board_id,address,location_note,lat,lng\n1-1,下鶴間１,高木公園,35.5157428,139.4624807\n';
	const boards = parseBoardsCsv(csv);
	assert.equal(boards.length, 1);
	assert.deepEqual(boards[0], {
		board_id: '1-1',
		address: '下鶴間１',
		location_note: '高木公園',
		lat: 35.5157428,
		lng: 139.4624807,
	});
});

test('parseBoardsCsv: lat/lngが数値でない行は除外する', () => {
	const csv = 'board_id,address,location_note,lat,lng\n1-1,住所,目印,not-a-number,139.46\n';
	assert.deepEqual(parseBoardsCsv(csv), []);
});

test('parseBoardsCsv: ダブルクォート囲み・""エスケープに対応する', () => {
	const csv = 'board_id,address,location_note,lat,lng\n1-1,"深見４８４，１","一ノ関公園東側（""正面""）",35.4857105,139.4689161\n';
	const boards = parseBoardsCsv(csv);
	assert.equal(boards[0].address, '深見４８４，１');
	assert.equal(boards[0].location_note, '一ノ関公園東側（"正面"）');
});

test('computeCenterFromBoards: bboxの中心を返す', () => {
	const center = computeCenterFromBoards([
		{ lat: 35.0, lng: 139.0 },
		{ lat: 35.2, lng: 139.4 },
	]);
	assert.deepEqual(center, [35.1, 139.2]);
});

test('computeCenterFromBoards: 空配列はエラーを投げる', () => {
	assert.throws(() => computeCenterFromBoards([]));
});
