#!/usr/bin/env node
/**
 * 既存地域への掲示板マスタCSV再投入スクリプト。
 *   node scripts/upload-boards.mjs <region-id> [CSVパス（省略時 regions/<region-id>/boards.csv）]
 *
 * Cloudflare Workers Freeプランのsubrequest数上限（1 invocationあたり50件）により、
 * CSVの行数が多いと `worker/boards.ts` の importBoards 内でジオコーディングが完走できない
 * （GSI地名検索APIへの fetch() が1件ずつ積み上がるため）。そのため測地系チェック・
 * ジオコーディングはこのスクリプト（サブリクエスト上限のないローカルNode実行）で行い、
 * 判定済み・補正済みのCSVを `scripts/new-region.mjs` と同じ「ログイン→Bearerトークン→
 * POST /api/boards/import」パターンでアップロードする。
 *
 * Web画面から直接CSVをアップロードする経路（/boards.html）は測地系チェックを一切行わず
 * 入力データをそのまま採用するので、掲示板マスタの新規投入・座標更新は必ずこのスクリプト
 * 経由で行うこと。
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCsv, toCsv } from '../worker/csv.ts';
import { checkAndCorrectDatum } from './lib/datum_check.ts';
import { tokyoDatumToWgs84 } from '../worker/lib/geodetic.ts';
import { ask, closePrompt } from './lib/prompt.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function regionDir(id) {
	return path.join(REPO_ROOT, 'regions', id);
}

const OUTPUT_HEADER = ['board_id', 'address', 'location_note', 'lat', 'lng', 'status', 'assignee_id', 'memo', 'location_uncertain'];

async function main() {
	const regionId = process.argv[2];
	if (!regionId) {
		console.error('使い方: node scripts/upload-boards.mjs <region-id> [CSVパス]');
		process.exit(1);
	}
	const csvPath = process.argv[3] ?? path.join(regionDir(regionId), 'boards.csv');
	if (!existsSync(csvPath)) {
		console.error(`CSVファイルが見つかりません: ${csvPath}`);
		process.exit(1);
	}

	const metaPath = path.join(regionDir(regionId), 'meta.json');
	const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {};

	let text = readFileSync(csvPath, 'utf8');
	if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // UTF-8 BOM除去

	const rows = parseCsv(text);
	if (rows.length < 2) {
		console.error('CSVにデータ行がありません。');
		process.exit(1);
	}
	const header = rows[0].map((h) => h.trim());
	const colIndex = {
		board_id: header.indexOf('board_id'),
		address: header.indexOf('address'),
		location_note: header.indexOf('location_note'),
		lat: header.indexOf('lat'),
		lng: header.indexOf('lng'),
		status: header.indexOf('status'),
		assignee_id: header.indexOf('assignee_id'),
		memo: header.indexOf('memo'),
	};
	if (colIndex.board_id === -1 || colIndex.lat === -1 || colIndex.lng === -1) {
		console.error('CSVヘッダに board_id, lat, lng が必要です。');
		process.exit(1);
	}

	const dataRows = rows.slice(1);
	const parsed = dataRows.map((r, i) => ({
		lineNo: i + 2,
		address: colIndex.address !== -1 ? (r[colIndex.address] ?? '').trim() : '',
		lat: Number((r[colIndex.lat] ?? '').trim()),
		lng: Number((r[colIndex.lng] ?? '').trim()),
	}));

	console.log(`\n=== ${meta.displayName ?? regionId}: 掲示板マスタ測地系チェック ===`);
	console.log(`${parsed.length}行を判定します（GSI地名検索APIへ全件ジオコーディングするため少し時間がかかります）...`);

	const datumCheck = await checkAndCorrectDatum(parsed.map((r) => ({ line: r.lineNo, address: r.address, lat: r.lat, lng: r.lng })));

	console.log(`\n判定結果: verdict=${datumCheck.verdict}`);
	console.log(
		`  ok=${datumCheck.okCount} candidate=${datumCheck.candidateCount} unresolved=${datumCheck.unresolvedCount} ` +
			`no_address=${datumCheck.noAddressCount} geocode_failed=${datumCheck.geocodeFailedCount}`,
	);
	if (datumCheck.note) console.log(`  note: ${datumCheck.note}`);
	for (const w of datumCheck.warnings) console.log(`  警告 ${w.line}行目: ${w.message}`);

	// verdict==='correct_all'の場合に加え、verdict==='abort'でも candidate が ok を
	// 明確に上回っている（＝日本測地系である証拠の方が優勢）場合は変換する。この用途では
	// 日本測地系/世界測地系が1つのCSV内に混在することは想定していない（前提: 選挙公営掲示場は
	// 自治体が単一の測量・エクスポート設定で作った1つのマスタであるため）。checkAndCorrectDatum
	// 本体の90%閾値（batchRatioThreshold）は変更せず、このスクリプト側だけで上書き判断を追加する。
	// uncertainフラグ（?バッジ）は「最終的にアップロードする座標が、ジオコーディングで
	// 実際に一致確認できているか」だけを見る（プラン文書「用語集」参照）。
	const abortButCandidateWins = datumCheck.verdict === 'abort' && datumCheck.candidateCount > datumCheck.okCount;
	const willConvert = datumCheck.verdict === 'correct_all' || abortButCandidateWins;
	const bucketByLine = new Map(datumCheck.rows.map((r) => [r.line, r.bucket]));
	let uncertainCount = 0;
	const finalRows = parsed.map((r) => {
		const bucket = bucketByLine.get(r.lineNo);
		const { lat, lng } = willConvert ? tokyoDatumToWgs84({ lat: r.lat, lng: r.lng }) : r;
		const uncertain = willConvert ? bucket !== 'candidate' : bucket !== 'ok';
		if (uncertain) uncertainCount++;
		return { lat, lng, uncertain };
	});

	if (datumCheck.verdict === 'correct_all') {
		console.log('\n→ 全行を日本測地系→世界測地系へ変換します（correct_all判定）。');
	} else if (abortButCandidateWins) {
		console.log(
			`\n→ verdict=abortですが、candidate(${datumCheck.candidateCount})がok(${datumCheck.okCount})を上回っているため、` +
				'全行を日本測地系→世界測地系へ変換します。',
		);
	} else {
		console.log(`\n→ 座標はCSVのまま変換しません（verdict=${datumCheck.verdict}）。`);
	}
	console.log(`→ 要確認フラグ(?)を${uncertainCount}/${parsed.length}件に設定します。`);

	const outRows = dataRows.map((r, i) => {
		const fr = finalRows[i];
		return [
			r[colIndex.board_id] ?? '',
			r[colIndex.address] ?? '',
			colIndex.location_note !== -1 ? (r[colIndex.location_note] ?? '') : '',
			fr.lat,
			fr.lng,
			colIndex.status !== -1 ? (r[colIndex.status] ?? '') : '',
			colIndex.assignee_id !== -1 ? (r[colIndex.assignee_id] ?? '') : '',
			colIndex.memo !== -1 ? (r[colIndex.memo] ?? '') : '',
			fr.uncertain ? '1' : '0',
		];
	});
	const uploadCsv = toCsv(OUTPUT_HEADER, outRows);

	console.log('\n--- アップロード先の指定 ---');
	const deployedUrl = (await ask('デプロイ先URL（例: https://bm-map-poster-xxxx.xxxx.workers.dev）')).replace(/\/+$/, '');
	const adminUserId = await ask('管理者ユーザーID', { defaultValue: meta.adminUserId });
	const adminPassphrase = await ask(`管理者「${adminUserId}」の合言葉`);

	const loginRes = await fetch(`${deployedUrl}/api/login`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ user_id: adminUserId, passphrase: adminPassphrase }),
	});
	if (!loginRes.ok) {
		console.error(`\n管理者ログインに失敗しました（${loginRes.status}）。`);
		closePrompt();
		process.exit(1);
	}
	const { token } = await loginRes.json();

	const importRes = await fetch(`${deployedUrl}/api/boards/import`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}`, 'content-type': 'text/csv' },
		body: uploadCsv,
	});
	if (!importRes.ok) {
		console.error(`\n掲示板マスタの投入に失敗しました（${importRes.status}）: ${await importRes.text()}`);
		closePrompt();
		process.exit(1);
	}
	const result = await importRes.json();
	console.log(`\n${result.imported}件の掲示板を反映しました。`);

	closePrompt();
}

main().catch((err) => {
	console.error('\n予期しないエラーが発生しました:', err);
	closePrompt();
	process.exit(1);
});
