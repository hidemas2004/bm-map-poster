import { csvResponse, toCsv } from './csv';

export interface PosterActivityLogEnv {
	DB: D1Database;
}

interface PosterActivityLogRow {
	log_id: number;
	board_id: string;
	address: string;
	updated_at: string;
	user_id: string;
	user_name: string;
	old_status: string;
	new_status: string;
	old_assignee_name: string;
	new_assignee_name: string;
}

const LIST_QUERY = `
	SELECT poster_activity_log.log_id, poster_activity_log.board_id, poster_boards.address,
		poster_activity_log.updated_at, poster_activity_log.user_id, poster_activity_log.user_name,
		poster_activity_log.old_status, poster_activity_log.new_status,
		poster_activity_log.old_assignee_name, poster_activity_log.new_assignee_name
	FROM poster_activity_log
	JOIN poster_boards ON poster_boards.board_id = poster_activity_log.board_id
	ORDER BY poster_activity_log.updated_at DESC`;

export async function listPosterActivityLog(env: PosterActivityLogEnv): Promise<Response> {
	const { results } = await env.DB.prepare(LIST_QUERY).all<PosterActivityLogRow>();
	return Response.json(results);
}

export async function exportPosterActivityLogCsv(env: PosterActivityLogEnv): Promise<Response> {
	const { results } = await env.DB.prepare(LIST_QUERY).all<PosterActivityLogRow>();
	const csv = toCsv(
		['log_id', '記録日時', 'board_id', '住所', '記録者ID', '記録者名', '変更前ステータス', '変更後ステータス', '変更前担当者', '変更後担当者'],
		results.map((r) => [
			r.log_id,
			r.updated_at,
			r.board_id,
			r.address,
			r.user_id,
			r.user_name,
			r.old_status,
			r.new_status,
			r.old_assignee_name,
			r.new_assignee_name,
		]),
	);
	return csvResponse(csv, 'poster_activity_log.csv');
}
