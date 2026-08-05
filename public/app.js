const SESSION_KEY = 'bm_poster_session';

const sessionRaw = sessionStorage.getItem(SESSION_KEY);
if (!sessionRaw) {
	location.href = '/login.html';
	throw new Error('not authenticated');
}
const session = JSON.parse(sessionRaw);

const state = {
	boards: new Map(), // board_id -> row
	markers: new Map(), // board_id -> Leafletマーカー
	activeUsers: [],
	assigneeFilter: '', // ''=全体表示、それ以外はuser_id
	statusFilter: new Set(STATUS_LABELS), // 表示中のステータス集合。デフォルト全表示
	watchId: null,
	gpsMarker: null,
};

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

// ---- 地図初期化 ----

const map = L.map('map').setView(MAP_INITIAL_CENTER, MAP_INITIAL_ZOOM);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
	attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);

function markerVisible(row) {
	if (!state.statusFilter.has(row.status)) return false;
	if (state.assigneeFilter && row.assignee_id !== state.assigneeFilter) return false;
	return true;
}

function styleForStatus(status) {
	return {
		radius: 9,
		color: '#ffffff',
		weight: 2,
		fillColor: STATUS_COLORS[status] ?? '#6b7280',
		fillOpacity: 0.9,
	};
}

function addOrUpdateMarker(row) {
	let marker = state.markers.get(row.board_id);
	if (!marker) {
		marker = L.circleMarker([row.lat, row.lng], styleForStatus(row.status));
		marker.on('click', () => openPopup(row.board_id));
		state.markers.set(row.board_id, marker);
	} else {
		marker.setStyle(styleForStatus(row.status));
	}
	if (markerVisible(row)) {
		if (!map.hasLayer(marker)) marker.addTo(map);
	} else if (map.hasLayer(marker)) {
		map.removeLayer(marker);
	}
}

function redrawMarkers() {
	for (const row of state.boards.values()) addOrUpdateMarker(row);
}

/** ヘッダの掲示板数・貼付済件数・トラブル件数を集計・表示する（担当者フィルタに連動、ステータスフィルタには非連動）。 */
function updateHeaderStats() {
	let total = 0;
	let posted = 0;
	let trouble = 0;
	for (const row of state.boards.values()) {
		if (state.assigneeFilter && row.assignee_id !== state.assigneeFilter) continue;
		total++;
		if (row.status === '貼付済') posted++;
		if (row.status === 'トラブル') trouble++;
	}
	const rate = total > 0 ? ((posted / total) * 100).toFixed(1) : '0.0';
	document.getElementById('stat-total').textContent = total.toLocaleString('ja-JP');
	document.getElementById('stat-posted').textContent = posted.toLocaleString('ja-JP');
	document.getElementById('stat-posted-rate').textContent = `${rate}%`;
	document.getElementById('stat-trouble').textContent = trouble.toLocaleString('ja-JP');
}

// ---- フィルタUI ----

function populateAssigneeFilterSelect() {
	const select = document.getElementById('assignee-filter');
	select.innerHTML = '';

	const optAll = document.createElement('option');
	optAll.value = '';
	optAll.textContent = '(全体表示)';
	select.appendChild(optAll);

	for (const user of state.activeUsers) {
		const option = document.createElement('option');
		option.value = user.user_id;
		option.textContent = user.name;
		select.appendChild(option);
	}
	select.value = state.assigneeFilter;
}

document.getElementById('assignee-filter').addEventListener('change', (e) => {
	state.assigneeFilter = e.target.value;
	redrawMarkers();
	updateHeaderStats();
});

function buildStatusFilterButtons() {
	const container = document.getElementById('status-filter');
	container.innerHTML = '';
	for (const status of STATUS_LABELS) {
		const button = document.createElement('button');
		button.type = 'button';
		button.textContent = status;
		button.className = state.statusFilter.has(status) ? 'active' : '';
		button.addEventListener('click', () => {
			if (state.statusFilter.has(status)) {
				state.statusFilter.delete(status);
			} else {
				state.statusFilter.add(status);
			}
			button.classList.toggle('active');
			redrawMarkers();
		});
		container.appendChild(button);
	}
}

// ---- ポップアップ ----
// ポップアップ内のボタン/セレクト操作がクリックとして地図側に伝播すると、Leafletの
// 「ポップアップ外クリックで自動クローズ」機構が反応して閉じてしまうため、
// 生成した要素は必ず disableClickPropagation で地図への伝播を止める。

function openPopup(boardId) {
	const row = state.boards.get(boardId);
	const marker = state.markers.get(boardId);
	marker.bindPopup(buildPopupContent(row)).openPopup();
}

function buildPopupContent(row) {
	const container = document.createElement('div');
	container.className = 'popup-content';
	L.DomEvent.disableClickPropagation(container);

	container.innerHTML = `
		<div class="title">${row.board_id}</div>
		<div class="row"><span>住所:</span><span>${row.address || '-'}</span></div>
		${row.location_note ? `<div class="row"><span>目印:</span><span>${row.location_note}</span></div>` : ''}
		<div class="row"><span>ステータス:</span><span class="status-badge" style="background:${STATUS_COLORS[row.status]}">${row.status}</span></div>
		<div class="row"><span>担当者:</span><span>${row.assignee_name || '未担当'}</span></div>
		${row.posted_at ? `<div class="row"><span>貼付日時:</span><span>${new Date(row.posted_at).toLocaleString('ja-JP')}</span></div>` : ''}
		<div class="edit-form">
			<label>ステータス
				<select data-role="status-select">
					${STATUS_LABELS.map((s) => `<option value="${s}" ${s === row.status ? 'selected' : ''}>${s}</option>`).join('')}
				</select>
			</label>
			<label>担当者
				<select data-role="assignee-select">
					<option value="">未担当</option>
					${state.activeUsers.map((u) => `<option value="${u.user_id}" ${u.user_id === row.assignee_id ? 'selected' : ''}>${u.name}</option>`).join('')}
				</select>
			</label>
			<p class="error" data-role="update-error"></p>
			<button type="button" data-action="save">更新する</button>
		</div>
	`;

	container.querySelector('[data-action="save"]').addEventListener('click', async () => {
		const statusSelect = container.querySelector('[data-role="status-select"]');
		const assigneeSelect = container.querySelector('[data-role="assignee-select"]');
		const errorEl = container.querySelector('[data-role="update-error"]');
		const res = await apiFetch('/api/board/update', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				board_id: row.board_id,
				status: statusSelect.value,
				assignee_id: assigneeSelect.value || null,
			}),
		});
		const data = await res.json();
		if (!res.ok) {
			errorEl.textContent = data.error ?? '更新に失敗しました';
			return;
		}
		state.boards.set(row.board_id, data);
		addOrUpdateMarker(data);
		updateHeaderStats();
		const marker = state.markers.get(row.board_id);
		marker.setPopupContent(buildPopupContent(data));
		marker.getPopup().update();
	});

	return container;
}

// ---- 初期ロード ----

async function loadBoards() {
	const res = await apiFetch('/api/boards');
	const rows = await res.json();
	state.boards = new Map(rows.map((r) => [r.board_id, r]));
	redrawMarkers();
	updateHeaderStats();
}

// ---- GPS ----

const gpsButton = document.getElementById('gps-button');
gpsButton.addEventListener('click', () => {
	if (state.watchId !== null) {
		navigator.geolocation.clearWatch(state.watchId);
		state.watchId = null;
		gpsButton.classList.remove('active');
		if (state.gpsMarker) {
			map.removeLayer(state.gpsMarker);
			state.gpsMarker = null;
		}
		return;
	}
	if (!navigator.geolocation) {
		alert('この端末は位置情報に対応していません');
		return;
	}
	gpsButton.classList.add('active');
	let firstFix = true;
	state.watchId = navigator.geolocation.watchPosition(
		(pos) => {
			const latlng = [pos.coords.latitude, pos.coords.longitude];
			if (!state.gpsMarker) {
				state.gpsMarker = L.marker(latlng, {
					icon: L.divIcon({ className: '', html: '<div class="gps-dot"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }),
				}).addTo(map);
			} else {
				state.gpsMarker.setLatLng(latlng);
			}
			if (firstFix) {
				map.setView(latlng, Math.max(map.getZoom(), 15));
				firstFix = false;
			}
		},
		() => {
			alert('現在地を取得できませんでした');
			gpsButton.classList.remove('active');
			state.watchId = null;
		},
		{ enableHighAccuracy: true },
	);
});

// ---- メニュー ----

const menuButton = document.getElementById('menu-button');
const menuPanel = document.getElementById('menu-panel');
menuButton.addEventListener('click', () => menuPanel.classList.toggle('show'));
document.addEventListener('click', (e) => {
	if (!menuPanel.contains(e.target) && e.target !== menuButton) menuPanel.classList.remove('show');
});

document.getElementById('logout-button').addEventListener('click', () => {
	sessionStorage.removeItem(SESSION_KEY);
	location.href = '/login.html';
});

if (session.user.role === '管理者') {
	document.getElementById('users-link').style.display = 'block';
}

// ---- ヘッダの開閉 ----
// 三角マーク（.header-toggle-hint）のクリックのみで開閉する。Leafletは自分では
// コンテナサイズの変化を検知しないため、開閉後は必ずinvalidateSize()でタイル表示を再計算させる。

const header = document.getElementById('header');
document.querySelector('.header-toggle-hint').addEventListener('click', () => {
	header.classList.toggle('collapsed');
	requestAnimationFrame(() => map.invalidateSize());
});

// ---- 初期化 ----

async function init() {
	const usersRes = await fetch('/api/users/active');
	state.activeUsers = await usersRes.json();
	populateAssigneeFilterSelect();
	buildStatusFilterButtons();
	await loadBoards();
}

init();
