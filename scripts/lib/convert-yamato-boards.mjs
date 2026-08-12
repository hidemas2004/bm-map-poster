#!/usr/bin/env node
/**
 * 大和市の「掲示場一覧」CSV（UTF-8）を、掲示板マスタ投入用のSQL（INSERT文）に変換する。
 * 自治体ごとにCSV形式が異なる前提のため、この変換ロジックは大和市専用。
 * 別の自治体を追加する場合は、この関数を参考に regions/<id>/ 用の変換スクリプトを新規に書くこと
 * （README.md「複数地域の並行運用」参照）。
 *
 * 想定入力: 投票所一覧・期日前投票所一覧・掲示場一覧の3つの表がヘッダー行ごと縦に連結されたCSV
 * （大和市選挙管理委員会が配布する形式）。「名称」列が `<投票区番号>-<連番>`（例: "1-1"）の
 * 形式になっている行だけを掲示場一覧として抽出する（投票所一覧・期日前投票所一覧はこの形式に
 * 一致しないため自然に除外される）。「緯度・経度」列は `経度:緯度` の形式で1セルに結合されている。
 *
 * 事前準備: 元CSVがShift-JISの場合は先にUTF-8へ変換しておくこと。
 *   iconv -f SHIFT_JIS -t UTF-8 -o input_utf8.csv input.csv
 *
 * 使い方:
 *   node scripts/lib/convert-yamato-boards.mjs <input_utf8.csv> <output.sql>
 */

import { readFileSync, writeFileSync } from 'node:fs';

const BOARD_ID_PATTERN = /^\d+-\d+$/;

/**
 * ハイフンに似た全角・特殊記号（例: "1ｰ1"の半角カナ長音記号 U+FF70）をASCIIハイフンに正規化する。
 * 大和市CSVの投票区1（1-1〜1-8）だけこの表記揺れがあり、正規化しないとBOARD_ID_PATTERNに
 * マッチせず取りこぼす。
 */
function normalizeBoardId(raw) {
	return raw.trim().replace(/[ーｰ−‐－]/g, '-');
}

function parseCsvLine(line) {
	const fields = [];
	let cur = '';
	let inQuotes = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (inQuotes) {
			if (ch === '"') {
				if (line[i + 1] === '"') {
					cur += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				cur += ch;
			}
		} else if (ch === '"') {
			inQuotes = true;
		} else if (ch === ',') {
			fields.push(cur);
			cur = '';
		} else {
			cur += ch;
		}
	}
	fields.push(cur);
	return fields;
}

/** CSV全文（3表連結）から「掲示場一覧」の行だけを抽出し、正規化した掲示板データの配列を返す。 */
export function convertYamatoBoardsCsv(text) {
	const lines = text.split(/\r\n|\n|\r/).filter((l) => l.length > 0);
	const boards = [];
	for (const line of lines) {
		const fields = parseCsvLine(line);
		const [name, , address, , locationNote, latLng] = fields;
		if (!name) continue;
		const boardId = normalizeBoardId(name);
		if (!BOARD_ID_PATTERN.test(boardId)) continue; // 投票所一覧等のヘッダー行・他表を除外
		if (!latLng || !latLng.includes(':')) continue;
		const [lngStr, latStr] = latLng.split(':');
		const lat = Number(latStr);
		const lng = Number(lngStr);
		if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
		boards.push({
			board_id: boardId,
			address: (address ?? '').trim(),
			location_note: (locationNote ?? '').trim(),
			lat,
			lng,
		});
	}
	return boards;
}

function escapeSql(value) {
	return value.replace(/'/g, "''");
}

export function buildInsertSql(boards) {
	const lines = boards.map(
		(b) =>
			`INSERT INTO poster_boards (board_id, address, location_note, lat, lng) VALUES ('${escapeSql(b.board_id)}', '${escapeSql(b.address)}', '${escapeSql(b.location_note)}', ${b.lat}, ${b.lng});`,
	);
	return lines.join('\n') + '\n';
}

function escapeCsvValue(value) {
	const s = String(value);
	return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * POST /api/boards/import が要求するCSV形式（board_id,address,location_note,lat,lng）で出力する。
 * scripts/new-region.mjsが新規地域立ち上げ時にHTTP経由で投入する際の入力ファイルとして使う
 * （worker側の測地系自動検出・補正ロジックをそのまま適用させるため、D1への直接INSERTは行わない）。
 */
export function buildImportCsv(boards) {
	const header = 'board_id,address,location_note,lat,lng';
	const lines = boards.map((b) =>
		[b.board_id, b.address, b.location_note, b.lat, b.lng].map(escapeCsvValue).join(','),
	);
	return [header, ...lines].join('\r\n') + '\r\n';
}

// CLIとして実行された場合のみファイル入出力を行う（他スクリプトからのimportも想定）。
// 出力先の拡張子が .csv なら POST /api/boards/import 用のCSV、それ以外は従来通りSQLを出力する。
if (import.meta.url === `file://${process.argv[1]}`) {
	const [, , inputPath, outputPath] = process.argv;
	if (!inputPath || !outputPath) {
		console.error('使い方: node scripts/lib/convert-yamato-boards.mjs <input_utf8.csv> <output.sql|output.csv>');
		process.exit(1);
	}
	const text = readFileSync(inputPath, 'utf8');
	const boards = convertYamatoBoardsCsv(text);
	if (boards.length === 0) {
		console.error('掲示場データが1件も抽出できませんでした（CSV形式を確認してください）');
		process.exit(1);
	}
	const isCsv = outputPath.toLowerCase().endsWith('.csv');
	writeFileSync(outputPath, isCsv ? buildImportCsv(boards) : buildInsertSql(boards));
	console.log(`${boards.length}件の掲示板データを ${outputPath} に出力しました。`);
}
