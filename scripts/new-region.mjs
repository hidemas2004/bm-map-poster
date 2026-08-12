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
 * （境界GeoJSONの取得ステップが無い代わりに、掲示板マスタCSVを regions/<id>/boards.csv として
 * 用意してもらうステップに置き換わっている。地域固有の見た目設定は regions/<id>/config.js の
 * ような物理ファイルではなく wrangler.jsonc の env.<id>.vars として持たせ、worker/config.ts が
 * /config.js を動的生成する）。
 */

import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ask, confirm, closePrompt } from './lib/prompt.mjs';
import { appendEnvBlock, envExists } from './lib/wrangler-jsonc.mjs';
import { parseBoardsCsv, computeCenterFromBoards } from './lib/boards-bbox.mjs';
import { execCommand } from './lib/win-exec.mjs';
import { ensureWranglerAuth } from './lib/wrangler-auth.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NPX = 'npx';

function regionDir(id) {
	return path.join(REPO_ROOT, 'regions', id);
}

/** silent: stdout/stderrを表示せず戻り値として返す。input: 子プロセスの標準入力に書き込む文字列
 *  （wrangler secret put のような対話入力を非対話で通すため。stdin.10を明示的にpipeにする）。 */
function run(cmd, args, options = {}) {
	console.log(`\n$ ${cmd} ${args.join(' ')}`);
	const stdio = options.input ? ['pipe', options.silent ? 'pipe' : 'inherit', 'inherit'] : options.silent ? 'pipe' : 'inherit';
	return execCommand(cmd, args, { encoding: 'utf8', cwd: REPO_ROOT, ...options, stdio });
}

function extractDatabaseId(wranglerOutput) {
	const jsonMatch = wranglerOutput.match(/"database_id"\s*:\s*"([0-9a-f-]{36})"/i);
	if (jsonMatch) return jsonMatch[1];
	const genericMatch = wranglerOutput.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
	if (genericMatch) return genericMatch[0];
	return null;
}

function extractDeployedUrl(wranglerOutput) {
	const match = wranglerOutput.match(/https:\/\/\S+\.workers\.dev\S*/);
	return match ? match[0].replace(/\/+$/, '') : null;
}

async function main() {
	console.log('=== bm-map-poster: 新規地域の並行ローンチ ===\n');

	// D1作成・デプロイ等の前に認証状態を確認・リフレッシュしておく（未認証やアクセストークン
	// 期限切れのまま掲示板マスタ準備等の対話を終えた後にwrangler呼び出しで落ちるのを防ぐ）。
	await ensureWranglerAuth();

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
	const boardsCsvPath = path.join(dir, 'boards.csv');
	if (existsSync(boardsCsvPath)) {
		console.log(`\n(regions/${regionId}/boards.csv は既に用意されています。このまま使用します)`);
	} else {
		console.log('\n--- 掲示板マスタの準備 ---');
		console.log(
			'自治体の掲示場一覧CSVを、POST /api/boards/import 用のCSV（board_id,address,location_note,\n' +
				'lat,lng）に変換して用意してください。CSV形式は自治体ごとに異なるため専用の変換スクリプトが\n' +
				'必要です。大和市の場合:\n' +
				'  node scripts/lib/convert-yamato-boards.mjs <入力CSV(UTF-8)> ' +
				`regions/${regionId}/boards.csv\n` +
				'他自治体の場合は、このスクリプトを参考に変換ロジックを新規に書いてください' +
				'（README.md「掲示板マスタCSVの変換」参照）。',
		);
		while (!existsSync(boardsCsvPath)) {
			await ask(`準備ができたらEnterを押してください（regions/${regionId}/boards.csv が必要です）`, {
				defaultValue: ' ',
			});
		}
	}
	const boardsForCenter = parseBoardsCsv(readFileSync(boardsCsvPath, 'utf8'));

	// --- 地図初期表示設定 ---
	// 表示名・地図初期座標・ズームは regions/<id>/config.js のような物理ファイルではなく
	// wrangler.jsonc の env.<id>.vars として持たせる（worker/config.ts が /config.js を動的生成する）。
	// 「切り替えたら上書きする」可変ファイルが存在しないため、誤って別地域の設定が混入する事故が
	// 構造的に起こらない（bm-map-posting issue#21と同じ設計）。
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

	// --- 初期管理者ユーザー ---
	// 合言葉は平文の秘密情報なので meta.json（gitで追跡される）には一切書き込まない。
	// DB投入・ログイン確認が完了するまでの間だけメモリ上に保持する。
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
		const output = run(NPX, ['wrangler', 'd1', 'create', d1DatabaseName], { silent: true });
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
		appendEnvBlock(regionId, {
			workerName,
			d1DatabaseName,
			databaseId,
			vars: {
				REGION_DISPLAY_NAME: meta.displayName,
				MAP_CENTER_LAT: meta.mapCenter[0],
				MAP_CENTER_LNG: meta.mapCenter[1],
				MAP_ZOOM: meta.mapZoom,
			},
		});
		console.log(`\nwrangler.jsonc に env.${regionId} を追記しました。`);
	}

	// --- マイグレーション・初期管理者の投入 ---
	// 掲示板マスタはここではD1に直接INSERTしない。デプロイ後、実際にデプロイされたWorkerの
	// POST /api/boards/import をそのまま叩く（issue#3の測地系自動検出・補正ロジックを
	// Worker内で完結させたまま新規地域の初期投入にも適用させるため）。
	if (!meta.dbSeeded) {
		console.log('\n--- D1へのマイグレーション・初期管理者の投入 ---');
		run(NPX, ['wrangler', 'd1', 'execute', d1DatabaseName, '--env', regionId, '--remote', '--file=migrations/0001_init.sql']);
		run(NPX, ['wrangler', 'd1', 'execute', d1DatabaseName, '--env', regionId, '--remote', '--file=migrations/0002_add_memo.sql']);

		// 合言葉が平文で入るSQLはリポジトリ外（OS一時ディレクトリ）に書き、投入後に必ず削除する。
		const esc = (s) => s.replace(/'/g, "''");
		const adminSql = `INSERT INTO users (user_id, name, passphrase, role, active) VALUES ('${esc(meta.adminUserId)}', '${esc(meta.adminName)}', '${esc(adminPassphrase)}', '管理者', 1);\n`;
		const adminSqlPath = path.join(os.tmpdir(), `bm-map-poster-admin-${regionId}-${crypto.randomUUID()}.sql`);
		writeFileSync(adminSqlPath, adminSql);
		try {
			run(NPX, ['wrangler', 'd1', 'execute', d1DatabaseName, '--env', regionId, '--remote', `--file=${adminSqlPath}`]);
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
		run(NPX, ['wrangler', 'secret', 'put', 'SESSION_SECRET', '--env', regionId], { input: sessionSecret + '\n' });
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

	console.log('\n--- デプロイ ---');
	const deployOutput = run(NPX, ['wrangler', 'deploy', '--env', regionId], { silent: true });
	console.log(deployOutput);
	let deployedUrl = extractDeployedUrl(deployOutput);
	if (deployedUrl && meta.deployedUrl !== deployedUrl) {
		// scripts/upload-boards.mjs 等がアップロード先を自動決定するために使う
		// （手入力によるリージョン取り違え事故を防ぐ。bm-map-posting側で実際に発生した事故を踏まえた対策）。
		meta.deployedUrl = deployedUrl;
		writeFileSync(metaPath, JSON.stringify(meta, null, 2));
	}

	// --- 掲示板マスタの投入（デプロイ後、HTTP経由）---
	if (!meta.boardsSeeded) {
		console.log('\n--- 掲示板マスタの投入 ---');
		if (!deployedUrl) {
			deployedUrl = await ask('デプロイ先URLを自動抽出できませんでした。掲示板マスタ投入のため、URLを貼り付けてください');
		}
		if (!adminPassphrase) {
			adminPassphrase = await ask(`管理者「${meta.adminUserId}」の合言葉を再入力してください（掲示板マスタ投入のログインに使用）`);
		}
		try {
			const loginRes = await fetch(`${deployedUrl}/api/login`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ user_id: meta.adminUserId, passphrase: adminPassphrase }),
			});
			if (!loginRes.ok) {
				console.error(`\n管理者ログインに失敗しました（${loginRes.status}）。掲示板マスタの投入をスキップします。後で /boards.html から手動でアップロードしてください。`);
			} else {
				const { token } = await loginRes.json();
				const csvText = readFileSync(boardsCsvPath, 'utf8');
				const importRes = await fetch(`${deployedUrl}/api/boards/import`, {
					method: 'POST',
					headers: { Authorization: `Bearer ${token}`, 'content-type': 'text/csv' },
					body: csvText,
				});
				if (!importRes.ok) {
					console.error(`\n掲示板マスタの投入に失敗しました（${importRes.status}）: ${await importRes.text()}`);
					console.error('後で /boards.html から手動でアップロードしてください。');
				} else {
					const result = await importRes.json();
					console.log(`\n掲示板マスタを${result.imported}件投入しました。`);
					if (result.datum_corrected) {
						console.log(`（日本測地系の座標を自動補正しました: ${result.corrected_count}件）`);
					}
					if (result.warnings?.length > 0) {
						console.log(`警告${result.warnings.length}件:`);
						for (const w of result.warnings) console.log(`  ${w.message}`);
					}
					meta.boardsSeeded = true;
					writeFileSync(metaPath, JSON.stringify(meta, null, 2));
				}
			}
		} catch (err) {
			console.error(`\n掲示板マスタの投入中にエラーが発生しました: ${err.message}`);
			console.error('後で /boards.html から手動でアップロードしてください。');
		}
	}

	console.log('\n=== 完了 ===');
	console.log(`Worker「${workerName}」をデプロイしました${deployedUrl ? `（${deployedUrl}）` : '（URLはデプロイログを参照）'}。`);
	console.log(`ログイン: ユーザーID「${meta.adminUserId}」・上で入力した合言葉。`);
	console.log('担当者の追加は /users.html のCSVインポート機能から行ってください。');

	closePrompt();
}

main().catch((err) => {
	console.error('\n予期しないエラーが発生しました:', err);
	closePrompt();
	process.exit(1);
});
