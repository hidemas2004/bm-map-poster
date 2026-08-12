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
	return tr;
}

async function loadBoards() {
	const res = await apiFetch('/api/boards');
	const boards = await res.json();
	const tbody = document.getElementById('boards-tbody');
	tbody.innerHTML = '';

	if (boards.length === 0) {
		tbody.innerHTML = '<tr><td colspan="9" class="empty-row">掲示板データがありません</td></tr>';
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

const DATUM_BUCKET_LABELS = {
	candidate: '日本測地系の可能性（変換候補）',
	unresolved: '住所と座標が一致しません',
	no_address: '住所未入力のため判定対象外',
	geocode_failed: 'ジオコーディングに失敗',
};

function addWarningItem(listEl, text) {
	const li = document.createElement('li');
	li.textContent = text;
	listEl.appendChild(li);
}

let lastImportText = null;

async function runImport(text, { force } = {}) {
	const fileInput = document.getElementById('import-file');
	const errorEl = document.getElementById('import-error');
	const successEl = document.getElementById('import-success');
	const noteEl = document.getElementById('import-note');
	const warningsEl = document.getElementById('import-warnings');
	const forceButton = document.getElementById('force-import-button');
	errorEl.textContent = '';
	successEl.textContent = '';
	noteEl.textContent = '';
	warningsEl.innerHTML = '';
	forceButton.hidden = true;

	const res = await apiFetch(`/api/boards/import${force ? '?force=true' : ''}`, {
		method: 'POST',
		headers: { 'Content-Type': 'text/csv' },
		body: text,
	});
	const data = await res.json();
	if (!res.ok) {
		errorEl.textContent = data.error ?? 'インポートに失敗しました（管理者権限が必要です）';
		for (const r of data.datum_check?.rows ?? []) {
			if (r.bucket === 'ok') continue;
			const label = DATUM_BUCKET_LABELS[r.bucket] ?? r.bucket;
			addWarningItem(warningsEl, `${r.line}行目: ${label}`);
		}
		if (data.datum_check) {
			lastImportText = text;
			forceButton.hidden = false;
		}
		return;
	}
	successEl.textContent = `${data.imported}件の掲示板を反映しました`;
	if (data.datum_corrected) {
		successEl.textContent += ` / 日本測地系の座標を自動補正しました（${data.corrected_count}件）`;
	}
	if (data.datum_check_forced) {
		successEl.textContent += ' / 測地系チェックの警告を確認の上、強制インポートしました';
	}
	if (data.datum_check_note) {
		noteEl.textContent = data.datum_check_note;
	}
	for (const w of data.warnings ?? []) {
		addWarningItem(warningsEl, w.message);
	}
	for (const r of data.datum_check?.rows ?? []) {
		if (r.bucket === 'ok') continue;
		const label = DATUM_BUCKET_LABELS[r.bucket] ?? r.bucket;
		addWarningItem(warningsEl, `${r.line}行目: ${label}`);
	}
	fileInput.value = '';
	lastImportText = null;
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

document.getElementById('force-import-button').addEventListener('click', async () => {
	if (!lastImportText) return;
	const ok = confirm(
		'住所と座標の整合性が確認できない行があります。内容を確認した上で、CSVの座標をそのままインポートしますか？',
	);
	if (!ok) return;
	await runImport(lastImportText, { force: true });
});

loadBoards();
