const SESSION_KEY = 'bm_poster_session';

const sessionRaw = sessionStorage.getItem(SESSION_KEY);
if (!sessionRaw) {
	location.href = '/login.html';
	throw new Error('not authenticated');
}
const session = JSON.parse(sessionRaw);

async function apiFetch(path, options = {}) {
	const res = await fetch(path, {
		...options,
		headers: {
			...(options.headers || {}),
			Authorization: `Bearer ${session.token}`,
		},
	});
	if (res.status === 401) {
		sessionStorage.removeItem(SESSION_KEY);
		location.href = '/login.html';
		throw new Error('unauthorized');
	}
	return res;
}

function addCell(row, text) {
	const cell = document.createElement('td');
	cell.textContent = text;
	row.appendChild(cell);
}

function buildBoardRow(board) {
	const tr = document.createElement('tr');
	addCell(tr, board.board_id);
	addCell(tr, board.address);
	addCell(tr, board.location_note);
	addCell(tr, board.lat);
	addCell(tr, board.lng);

	const statusCell = document.createElement('td');
	const badge = document.createElement('span');
	badge.className = 'status-badge';
	badge.style.background = STATUS_COLORS[board.status] ?? '#6b7280';
	badge.textContent = board.status;
	statusCell.appendChild(badge);
	tr.appendChild(statusCell);

	addCell(tr, board.assignee_name || '未担当');
	addCell(tr, board.posted_at ? new Date(board.posted_at).toLocaleString('ja-JP') : '');
	addCell(tr, board.memo);

	const uncertainCell = document.createElement('td');
	if (board.location_uncertain) {
		const badge = document.createElement('span');
		badge.className = 'status-badge';
		badge.style.background = '#dc2626';
		badge.textContent = '要確認';
		uncertainCell.appendChild(badge);
	}
	tr.appendChild(uncertainCell);
	return tr;
}

async function loadBoards() {
	const res = await apiFetch('/api/boards');
	const boards = await res.json();
	const tbody = document.getElementById('boards-tbody');
	tbody.innerHTML = '';

	if (boards.length === 0) {
		tbody.innerHTML = '<tr><td colspan="10" class="empty-row">掲示板データがありません</td></tr>';
	} else {
		for (const board of boards) {
			tbody.appendChild(buildBoardRow(board));
		}
	}
	document.getElementById('board-count').textContent = `${boards.length}件`;
}

document.getElementById('csv-download-button').addEventListener('click', async () => {
	const res = await apiFetch('/api/boards/export');
	const blob = await res.blob();
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = 'poster_boards.csv';
	a.click();
	URL.revokeObjectURL(url);
});

async function runImport(text) {
	const fileInput = document.getElementById('import-file');
	const errorEl = document.getElementById('import-error');
	const successEl = document.getElementById('import-success');
	errorEl.textContent = '';
	successEl.textContent = '';

	const res = await apiFetch('/api/boards/import', {
		method: 'POST',
		headers: { 'Content-Type': 'text/csv' },
		body: text,
	});
	const data = await res.json();
	if (!res.ok) {
		errorEl.textContent = data.error ?? 'インポートに失敗しました（管理者権限が必要です）';
		return;
	}
	successEl.textContent = `${data.imported}件の掲示板を反映しました`;
	fileInput.value = '';
	await loadBoards();
}

document.getElementById('import-button').addEventListener('click', async () => {
	const fileInput = document.getElementById('import-file');
	const errorEl = document.getElementById('import-error');
	const file = fileInput.files[0];
	if (!file) {
		errorEl.textContent = 'CSVファイルを選択してください';
		return;
	}
	const text = await file.text();
	await runImport(text);
});

loadBoards();
