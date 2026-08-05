#!/usr/bin/env node
/**
 * 新しい市区町村を並行稼働で追加するための対話スクリプト。
 *   npm run new-region
 *
 * wrangler.jsonc のトップレベル（最初にデプロイした自治体の本番設定）は一切変更しない。新しい市は
 * env.<region-id> の名前付き環境として追加し、独立したWorker・D1データベースでデプロイする。
 *
 * 前提: `npx wrangler login` 済みであること（D1作成・デプロイでCloudflare認証が必要）。
 * bm-map-postingのscripts/new-region.mjsと同じ構成・同じ操作感を踏襲している
 * （境界GeoJSONの取得ステップが無い代わりに、掲示板マスタSQLを regions/<id>/boards.sql として
 * 用意してもらうステップに置き換わっている）。
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ask, confirm, closePrompt } from './lib/prompt.mjs';
import { appendEnvBlock, envExists } from './lib/wrangler-jsonc.mjs';
import { buildConfigJs, computeCenterFromBoards } from './lib/config-template.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');

function regionDir(id) {
	return path.join(REPO_ROOT, 'regions', id);
}

/** silent: stdout/stderrを表示せず戻り値として返す。input: 子プロセスの標準入力に書き込む文字列
 *  （wrangler secret put のような対話入力を非対話で通すため。stdin.10を明示的にpipeにする）。 */
function run(cmd, args, options = {}) {
	console.log(`\n$ ${cmd} ${args.join(' ')}`);
	const stdio = options.input ? ['pipe', options.silent ? 'pipe' : 'inherit', 'inherit'] : options.silent ? 'pipe' : 'inherit';
	return execFileSync(cmd, args, { encoding: 'utf8', cwd: REPO_ROOT, ...options, stdio });
}

function extractDatabaseId(wranglerOutput) {
	const jsonMatch = wranglerOutput.match(/"database_id"\s*:\s*"([0-9a-f-]{36})"/i);
	if (jsonMatch) return jsonMatch[1];
	const genericMatch = wranglerOutput.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
	if (genericMatch) return genericMatch[0];
	return null;
}

/** regions/<id>/boards.sql（本スクリプトが要求する固定フォーマットのINSERT文）からlat/lngを抽出する。 */
function extractBoardsForCenter(boardsSqlPath) {
	const text = readFileSync(boardsSqlPath, 'utf8');
	const boards = [];
	const re = /,\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)\s*;/g;
	let m;
	while ((m = re.exec(text))) {
		boards.push({ lat: Number(m[1]), lng: Number(m[2]) });
	}
	return boards;
}

async function main() {
	console.log('=== bm-map-poster: 新規地域の並行ローンチ ===\n');

	let regionId = await ask('地域ID（例: 202704-hiratsuka。英数字とハイフンのみ）');
	regionId = regionId.trim().toLowerCase();
	if (!/^[a-z0-9-]+$/.test(regionId)) {
		console.error('エラー: 地域IDは英小文字・数字・ハイフンのみ使用できます。');
		process.exit(1);
	}

	const dir = regionDir(regionId);
	const resuming = existsSync(dir);
	if (resuming) {
		console.log(`\n(regions/${regionId}/ は既に存在します。用意済みのファイルは再利用し、続きから進めます)`);
	}
	mkdirSync(dir, { recursive: true });

	const metaPath = path.join(dir, 'meta.json');
	const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {};

	meta.displayName = meta.displayName ?? (await ask('表示名（例: 平塚市）'));
	writeFileSync(metaPath, JSON.stringify(meta, null, 2));

	// --- 掲示板マスタの準備 ---
	const boardsSqlPath = path.join(dir, 'boards.sql');
	if (existsSync(boardsSqlPath)) {
		console.log(`\n(regions/${regionId}/boards.sql は既に用意されています。このまま使用します)`);
	} else {
		console.log('\n--- 掲示板マスタの準備 ---');
		console.log(
			'自治体の掲示場一覧CSVを、掲示板マスタ投入用のSQL（INSERT文）に変換して用意してください。\n' +
				'CSV形式は自治体ごとに異なるため専用の変換スクリプトが必要です。大和市の場合:\n' +
				'  node scripts/lib/convert-yamato-boards.mjs <入力CSV(UTF-8)> ' +
				`regions/${regionId}/boards.sql\n` +
				'他自治体の場合は、このスクリプトを参考に変換ロジックを新規に書いてください' +
				'（README.md「掲示板マスタCSVの変換」参照）。',
		);
		while (!existsSync(boardsSqlPath)) {
			await ask(`準備ができたらEnterを押してください（regions/${regionId}/boards.sql が必要です）`, {
				defaultValue: ' ',
			});
		}
	}

	// --- 地図初期表示設定 ---
	const boardsForCenter = extractBoardsForCenter(boardsSqlPath);
	const suggestedCenter = computeCenterFromBoards(boardsForCenter);
	if (!meta.mapCenter) {
		console.log(`\n掲示板データのbbox中心から地図初期座標を算出しました: [${suggestedCenter.join(', ')}]`);
		const useDefault = await confirm('この座標を使用しますか？', { defaultValue: true });
		if (useDefault) {
			meta.mapCenter = suggestedCenter;
		} else {
			const lat = Number(await ask('緯度'));
			const lng = Number(await ask('経度'));
			meta.mapCenter = [lat, lng];
		}
	}
	meta.mapZoom = meta.mapZoom ?? Number(await ask('地図初期ズームレベル', { defaultValue: '13' }));
	writeFileSync(metaPath, JSON.stringify(meta, null, 2));
	writeFileSync(
		path.join(dir, 'config.js'),
		buildConfigJs({ displayName: meta.displayName, center: meta.mapCenter, zoom: meta.mapZoom }),
	);

	// --- 初期管理者ユーザー ---
	// 合言葉は平文の秘密情報なので meta.json（gitで追跡される）には一切書き込まない。
	// DB投入が完了するまでの間だけメモリ上に保持する。
	let adminPassphrase;
	if (!meta.dbSeeded) {
		console.log('\n--- 初期管理者ユーザーの登録 ---');
		console.log('（担当者の追加はデプロイ後に /users.html のCSVインポートで行えます。ここでは管理者1名のみ）');
		meta.adminUserId = meta.adminUserId ?? (await ask('管理者のユーザーID（例: admin）', { defaultValue: 'admin' }));
		meta.adminName = meta.adminName ?? (await ask('管理者の表示名（例: 管理者）', { defaultValue: '管理者' }));
		adminPassphrase = await ask('管理者の初期合言葉（後で /users.html から変更可能）');
		writeFileSync(metaPath, JSON.stringify(meta, null, 2));
	}

	const workerName = `bm-map-poster-${regionId}`;
	const d1DatabaseName = `bm-poster-db-${regionId}`;

	// --- D1データベース作成 ---
	let databaseId = meta.databaseId;
	if (!databaseId) {
		console.log('\n--- D1データベース作成 ---');
		const proceed = await confirm(`本番Cloudflare上に新しいD1データベース「${d1DatabaseName}」を作成します。よろしいですか？`, {
			defaultValue: true,
		});
		if (!proceed) {
			console.log('中断しました。');
			closePrompt();
			return;
		}
		const output = run('npx', ['wrangler', 'd1', 'create', d1DatabaseName], { silent: true });
		console.log(output);
		databaseId = extractDatabaseId(output);
		if (!databaseId) {
			databaseId = await ask('database_id を自動抽出できませんでした。上記の出力から database_id を貼り付けてください');
		}
		meta.databaseId = databaseId;
		writeFileSync(metaPath, JSON.stringify(meta, null, 2));
	}

	// --- wrangler.jsonc へのenv追記 ---
	if (!envExists(regionId)) {
		appendEnvBlock(regionId, { workerName, d1DatabaseName, databaseId });
		console.log(`\nwrangler.jsonc に env.${regionId} を追記しました。`);
	}

	// --- マイグレーション・掲示板マスタ・初期管理者の投入 ---
	if (!meta.dbSeeded) {
		console.log('\n--- D1へのマイグレーション・データ投入 ---');
		run('npx', ['wrangler', 'd1', 'execute', d1DatabaseName, '--env', regionId, '--remote', '--file=migrations/0001_init.sql']);
		run('npx', [
			'wrangler',
			'd1',
			'execute',
			d1DatabaseName,
			'--env',
			regionId,
			'--remote',
			`--file=${path.relative(REPO_ROOT, boardsSqlPath)}`,
		]);

		// 合言葉が平文で入るSQLはリポジトリ外（OS一時ディレクトリ）に書き、投入後に必ず削除する。
		const esc = (s) => s.replace(/'/g, "''");
		const adminSql = `INSERT INTO users (user_id, name, passphrase, role, active) VALUES ('${esc(meta.adminUserId)}', '${esc(meta.adminName)}', '${esc(adminPassphrase)}', '管理者', 1);\n`;
		const adminSqlPath = path.join(os.tmpdir(), `bm-map-poster-admin-${regionId}-${crypto.randomUUID()}.sql`);
		writeFileSync(adminSqlPath, adminSql);
		try {
			run('npx', ['wrangler', 'd1', 'execute', d1DatabaseName, '--env', regionId, '--remote', `--file=${adminSqlPath}`]);
		} finally {
			rmSync(adminSqlPath, { force: true });
		}

		meta.dbSeeded = true;
		writeFileSync(metaPath, JSON.stringify(meta, null, 2));
	}

	// --- Secrets自動生成・設定 ---
	if (!meta.secretsSet) {
		console.log('\n--- Secretsの自動生成・設定 ---');
		const sessionSecret = crypto.randomBytes(32).toString('hex');
		run('npx', ['wrangler', 'secret', 'put', 'SESSION_SECRET', '--env', regionId], { input: sessionSecret + '\n' });
		meta.secretsSet = true;
		writeFileSync(metaPath, JSON.stringify(meta, null, 2));
		console.log('(値はCloudflare側にのみ保存され、このスクリプトの出力には表示されません)');
	}

	// --- デプロイ前の最終確認 ---
	console.log('\n=== デプロイ内容の確認 ===');
	console.log(`  地域ID:          ${regionId}`);
	console.log(`  表示名:           ${meta.displayName}`);
	console.log(`  Worker名:         ${workerName}`);
	console.log(`  D1データベース:   ${d1DatabaseName} (${databaseId})`);
	console.log(`  地図初期座標:     [${meta.mapCenter.join(', ')}]  ズーム: ${meta.mapZoom}`);
	console.log(`  管理者ユーザーID: ${meta.adminUserId}`);
	console.log('');

	const okToDeploy = await confirm('この内容で本番デプロイ（wrangler deploy）してよいですか？', { defaultValue: false });
	if (!okToDeploy) {
		console.log('\nデプロイを見送りました。再度 `npm run new-region` を実行すれば、この続きから再開できます。');
		closePrompt();
		return;
	}

	copyFileSync(path.join(dir, 'config.js'), path.join(PUBLIC_DIR, 'config.js'));
	console.log(`\n(public/config.js を ${regionId} の内容に切り替えました)`);

	run('npx', ['wrangler', 'deploy', '--env', regionId]);

	console.log('\n=== 完了 ===');
	console.log(`Worker「${workerName}」をデプロイしました（URLはデプロイログを参照）。`);
	console.log(`ログイン: ユーザーID「${meta.adminUserId}」・上で入力した合言葉。`);
	console.log('担当者の追加は /users.html のCSVインポート機能から行ってください。');
	console.log(`現在 public/ は「${regionId}」の内容です。別地域を扱う場合は改めてこのスクリプトを実行してください。`);

	closePrompt();
}

main().catch((err) => {
	console.error('\n予期しないエラーが発生しました:', err);
	closePrompt();
	process.exit(1);
});
