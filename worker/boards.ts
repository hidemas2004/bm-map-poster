import { csvResponse, parseCsv, toCsv } from './csv';
import type { SessionUser } from './auth';

export interface BoardsEnv {
	DB: D1Database;
}

export type BoardStatus = '未着手' | '貼付済' | 'トラブル';
export const BOARD_STATUSES: BoardStatus[] = ['未着手', '貼付済', 'トラブル'];

interface BoardRow {
	board_id: string;
	address: string;
	location_note: string;
	lat: number;
	lng: number;
	status: BoardStatus;
	assignee_id: string | null;
	assignee_name: string;
	posted_at: string | null;
	memo: string;
}

export async function listBoards(env: BoardsEnv): Promise<Response> {
	const { results } = await env.DB.prepare('SELECT * FROM poster_boards ORDER BY board_id').all<BoardRow>();
	return Response.json(results);
}

export async function exportBoardsCsv(env: BoardsEnv): Promise<Response> {
	const { results } = await env.DB.prepare('SELECT * FROM poster_boards ORDER BY board_id').all<BoardRow>();
	const csv = toCsv(
		['board_id', 'address', 'location_note', 'lat', 'lng', 'status', 'assignee_id', 'assignee_name', 'posted_at', 'memo'],
		results.map((r) => [
			r.board_id,
			r.address,
			r.location_note,
			r.lat,
			r.lng,
			r.status,
			r.assignee_id ?? '',
			r.assignee_name,
			r.posted_at ?? '',
			r.memo,
		]),
	);
	return csvResponse(csv, 'poster_boards.csv');
}

/**
 * 掲示板マスタ一括投入・更新（管理者限定）。`board_id`が既存ならUPSERT、なければ新規追加。
 * CSVヘッダ: board_id, address, location_note, lat, lng, status, assignee_id, memo
 * （board_id, lat, lng は必須。address, location_note, memo は省略可）。
 * - assignee_id列はセルの内容がそのまま反映される（空欄=担当者なし。「未担当に戻す」もこの列を
 *   空欄にするだけでよい。passphraseのような「空欄=変更なし」特別扱いはしない）。
 * - status列を空欄にすると、既存行は現在のステータスを維持し、新規行は「未着手」になる
 *   （選挙当日、進行中の状態を一括CSVで誤って巻き戻さないための配慮）。
 * - memo列はaddress/location_noteと同様、セルの内容がそのまま反映される（列自体が無い場合は空欄扱い）。
 */
export async function importBoards(request: Request, env: BoardsEnv): Promise<Response> {
	let text = await request.text();
	if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // UTF-8 BOM除去

	const rows = parseCsv(text);
	if (rows.length === 0) {
		return Response.json({ error: 'CSVが空です' }, { status: 400 });
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
		return Response.json({ error: 'CSVヘッダに board_id, lat, lng が必要です' }, { status: 400 });
	}

	const dataRows = rows.slice(1);
	if (dataRows.length === 0) {
		return Response.json({ error: 'データ行がありません' }, { status: 400 });
	}

	const [{ results: activeUsers }, { results: existingBoards }] = await Promise.all([
		env.DB.prepare('SELECT user_id, name FROM users WHERE active = 1').all<{ user_id: string; name: string }>(),
		env.DB.prepare('SELECT board_id, status FROM poster_boards').all<{ board_id: string; status: BoardStatus }>(),
	]);
	const userNameById = new Map(activeUsers.map((u) => [u.user_id, u.name]));
	const existingStatusById = new Map(existingBoards.map((b) => [b.board_id, b.status]));

	const statements = [];
	for (const [i, r] of dataRows.entries()) {
		const lineNo = i + 2; // ヘッダ行ぶん+1、1始まりで+1
		const boardId = (r[colIndex.board_id] ?? '').trim();
		const latRaw = (r[colIndex.lat] ?? '').trim();
		const lngRaw = (r[colIndex.lng] ?? '').trim();
		if (!boardId || !latRaw || !lngRaw) {
			return Response.json({ error: `${lineNo}行目: board_id, lat, lng は必須です` }, { status: 400 });
		}
		const lat = Number(latRaw);
		const lng = Number(lngRaw);
		if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
			return Response.json({ error: `${lineNo}行目: lat, lng は数値で指定してください` }, { status: 400 });
		}

		const address = colIndex.address !== -1 ? (r[colIndex.address] ?? '').trim() : '';
		const locationNote = colIndex.location_note !== -1 ? (r[colIndex.location_note] ?? '').trim() : '';
		const memo = colIndex.memo !== -1 ? (r[colIndex.memo] ?? '').trim() : '';

		const statusRaw = colIndex.status !== -1 ? (r[colIndex.status] ?? '').trim() : '';
		let status: BoardStatus;
		if (statusRaw) {
			if (!BOARD_STATUSES.includes(statusRaw as BoardStatus)) {
				return Response.json(
					{ error: `${lineNo}行目: status は ${BOARD_STATUSES.join('/')} のいずれかを指定してください` },
					{ status: 400 },
				);
			}
			status = statusRaw as BoardStatus;
		} else {
			status = existingStatusById.get(boardId) ?? '未着手';
		}

		const assigneeIdRaw = colIndex.assignee_id !== -1 ? (r[colIndex.assignee_id] ?? '').trim() : '';
		let assigneeId: string | null = null;
		let assigneeName = '';
		if (assigneeIdRaw) {
			const name = userNameById.get(assigneeIdRaw);
			if (!name) {
				return Response.json({ error: `${lineNo}行目: 担当者(${assigneeIdRaw})が見つかりません` }, { status: 400 });
			}
			assigneeId = assigneeIdRaw;
			assigneeName = name;
		}

		statements.push(
			env.DB.prepare(
				`INSERT INTO poster_boards (board_id, address, location_note, lat, lng, status, assignee_id, assignee_name, memo)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(board_id) DO UPDATE SET
				   address = excluded.address, location_note = excluded.location_note,
				   lat = excluded.lat, lng = excluded.lng, status = excluded.status,
				   assignee_id = excluded.assignee_id, assignee_name = excluded.assignee_name, memo = excluded.memo`,
			).bind(boardId, address, locationNote, lat, lng, status, assigneeId, assigneeName, memo),
		);
	}
	await env.DB.batch(statements);

	return Response.json({ imported: statements.length });
}

/**
 * 地図ピンのポップアップから呼ばれる、ステータス・担当者・メモの更新。status/assignee_id/memoは
 * いずれか一部だけの指定でもよい（bodyに含まれていないフィールドは変更しない）。
 * ステータスが'貼付済'になった場合、posted_atを更新時刻で自動更新する
 * （それ以外への変更ではposted_atは変更しない＝直近に貼付済になった日時の記録として残す）。
 * memoの変更はposter_activity_logには記録しない（自由記述の備考欄のため、変更履歴の対象は
 * ステータス・担当者のみとする既存方針を踏襲）。
 */
export async function updateBoard(request: Request, env: BoardsEnv, user: SessionUser): Promise<Response> {
	const body = await request
		.json<{ board_id?: string; status?: string; assignee_id?: string | null; memo?: string }>()
		.catch(() => ({}) as { board_id?: string; status?: string; assignee_id?: string | null; memo?: string });
	const boardId = String(body.board_id ?? '');
	if (!boardId) {
		return Response.json({ error: 'board_id を指定してください' }, { status: 400 });
	}

	const current = await env.DB.prepare('SELECT * FROM poster_boards WHERE board_id = ?')
		.bind(boardId)
		.first<BoardRow>();
	if (!current) {
		return Response.json({ error: '指定された掲示板が見つかりません' }, { status: 404 });
	}

	let newStatus: BoardStatus = current.status;
	if (body.status !== undefined) {
		if (!BOARD_STATUSES.includes(body.status as BoardStatus)) {
			return Response.json(
				{ error: `status は ${BOARD_STATUSES.join('/')} のいずれかを指定してください` },
				{ status: 400 },
			);
		}
		newStatus = body.status as BoardStatus;
	}

	let newAssigneeId = current.assignee_id;
	let newAssigneeName = current.assignee_name;
	if (body.assignee_id !== undefined) {
		if (body.assignee_id) {
			const assignee = await env.DB.prepare('SELECT name FROM users WHERE user_id = ? AND active = 1')
				.bind(body.assignee_id)
				.first<{ name: string }>();
			if (!assignee) {
				return Response.json({ error: '指定された担当者が見つかりません' }, { status: 400 });
			}
			newAssigneeId = body.assignee_id;
			newAssigneeName = assignee.name;
		} else {
			newAssigneeId = null;
			newAssigneeName = '';
		}
	}

	const newMemo = body.memo !== undefined ? body.memo : current.memo;

	const now = new Date().toISOString();
	const postedAt = newStatus === '貼付済' ? now : current.posted_at;

	await env.DB.prepare(
		'UPDATE poster_boards SET status = ?, assignee_id = ?, assignee_name = ?, posted_at = ?, memo = ? WHERE board_id = ?',
	)
		.bind(newStatus, newAssigneeId, newAssigneeName, postedAt, newMemo, boardId)
		.run();

	if (newStatus !== current.status || newAssigneeId !== current.assignee_id) {
		await env.DB.prepare(
			`INSERT INTO poster_activity_log (board_id, updated_at, user_id, user_name, old_status, new_status, old_assignee_name, new_assignee_name)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(boardId, now, user.user_id, user.name, current.status, newStatus, current.assignee_name, newAssigneeName)
			.run();
	}

	const updated = await env.DB.prepare('SELECT * FROM poster_boards WHERE board_id = ?').bind(boardId).first<BoardRow>();
	return Response.json(updated);
}
