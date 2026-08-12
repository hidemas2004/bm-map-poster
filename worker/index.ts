import { handleLogin, requireAdmin, requireAuth, type AuthEnv } from './auth';
import { exportUsersCsv, importUsers, listActiveUsers, listUsers, type UsersEnv } from './users';
import { exportBoardsCsv, importBoards, listBoards, updateBoard, type BoardsEnv } from './boards';
import { exportPosterActivityLogCsv, listPosterActivityLog, type PosterActivityLogEnv } from './activity_log';
import { buildConfigResponse, type ConfigEnv } from './config';

export interface Env extends AuthEnv, UsersEnv, BoardsEnv, PosterActivityLogEnv, ConfigEnv {
	ASSETS: { fetch(request: Request): Promise<Response> };
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/config.js') {
			return new Response(buildConfigResponse(env), {
				headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' },
			});
		}

		if (url.pathname === '/api/login' && request.method === 'POST') {
			return handleLogin(request, env);
		}
		if (url.pathname === '/api/users/active' && request.method === 'GET') {
			return listActiveUsers(env);
		}

		// /api/ 配下はここから下すべて認証必須
		if (url.pathname.startsWith('/api/')) {
			const user = await requireAuth(request, env);
			if (!user) {
				return Response.json({ error: '認証が必要です' }, { status: 401 });
			}

			if (url.pathname === '/api/boards' && request.method === 'GET') {
				return listBoards(env);
			}
			if (url.pathname === '/api/boards/export' && request.method === 'GET') {
				return exportBoardsCsv(env);
			}
			if (url.pathname === '/api/boards/import' && request.method === 'POST') {
				const admin = await requireAdmin(request, env);
				if (!admin) {
					return Response.json({ error: '管理者権限が必要です' }, { status: 403 });
				}
				return importBoards(request, env);
			}
			if (url.pathname === '/api/board/update' && request.method === 'POST') {
				return updateBoard(request, env, user);
			}
			if (url.pathname === '/api/activity-log' && request.method === 'GET') {
				return listPosterActivityLog(env);
			}
			if (url.pathname === '/api/activity-log/export' && request.method === 'GET') {
				return exportPosterActivityLogCsv(env);
			}
			if (url.pathname === '/api/users' && request.method === 'GET') {
				const admin = await requireAdmin(request, env);
				if (!admin) {
					return Response.json({ error: '管理者権限が必要です' }, { status: 403 });
				}
				return listUsers(env);
			}
			if (url.pathname === '/api/users/export' && request.method === 'GET') {
				const admin = await requireAdmin(request, env);
				if (!admin) {
					return Response.json({ error: '管理者権限が必要です' }, { status: 403 });
				}
				return exportUsersCsv(env);
			}
			if (url.pathname === '/api/users/import' && request.method === 'POST') {
				const admin = await requireAdmin(request, env);
				if (!admin) {
					return Response.json({ error: '管理者権限が必要です' }, { status: 403 });
				}
				return importUsers(request, env);
			}

			return Response.json({ error: 'Not Found' }, { status: 404 });
		}

		return env.ASSETS.fetch(request);
	},
};
