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

function buildLogRow(row) {
	const tr = document.createElement('tr');
	addCell(tr, new Date(row.updated_at).toLocaleString('ja-JP'));
	addCell(tr, `${row.board_id}（${row.address}）`);
	addCell(tr, row.user_name);
	addCell(tr, row.old_status === row.new_status ? row.new_status : `${row.old_status} → ${row.new_status}`);
	addCell(
		tr,
		row.old_assignee_name === row.new_assignee_name
			? row.new_assignee_name || '未担当'
			: `${row.old_assignee_name || '未担当'} → ${row.new_assignee_name || '未担当'}`,
	);
	return tr;
}

async function loadLog() {
	const res = await apiFetch('/api/activity-log');
	const rows = await res.json();
	const tbody = document.getElementById('log-tbody');
	tbody.innerHTML = '';

	if (rows.length === 0) {
		tbody.innerHTML = '<tr><td colspan="5" class="empty-row">記録がありません</td></tr>';
	} else {
		for (const row of rows) {
			tbody.appendChild(buildLogRow(row));
		}
	}
	document.getElementById('log-count').textContent = `${rows.length}件`;
}

document.getElementById('csv-download-button').addEventListener('click', async () => {
	const res = await apiFetch('/api/activity-log/export');
	const blob = await res.blob();
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = 'poster_activity_log.csv';
	a.click();
	URL.revokeObjectURL(url);
});

loadLog();
