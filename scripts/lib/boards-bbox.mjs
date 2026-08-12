/**
 * regions/<id>/boards.csv（POST /api/boards/import と同じ形式: board_id,address,location_note,
 * lat,lng）から座標を抽出し、地図初期表示座標（bboxの中心）を算出する。
 * scripts/new-region.mjs が対話中に地図初期座標を提案するために使う。
 */

function parseCsvLine(line) {
	const fields = [];
	let cur = '';
	let inQuotes = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (inQuotes) {
			if (ch === '"') {
				if (line[i + 1] === '"') {
					cur += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				cur += ch;
			}
		} else if (ch === '"') {
			inQuotes = true;
		} else if (ch === ',') {
			fields.push(cur);
			cur = '';
		} else {
			cur += ch;
		}
	}
	fields.push(cur);
	return fields;
}

/** ヘッダ行を含むCSVテキストから {board_id, address, location_note, lat, lng} の配列を返す。 */
export function parseBoardsCsv(text) {
	const lines = text.split(/\r\n|\n|\r/).filter((l) => l.length > 0);
	if (lines.length === 0) return [];
	const header = parseCsvLine(lines[0]).map((h) => h.trim());
	const idx = {
		board_id: header.indexOf('board_id'),
		address: header.indexOf('address'),
		location_note: header.indexOf('location_note'),
		lat: header.indexOf('lat'),
		lng: header.indexOf('lng'),
	};
	const boards = [];
	for (const line of lines.slice(1)) {
		const fields = parseCsvLine(line);
		const lat = Number(fields[idx.lat]);
		const lng = Number(fields[idx.lng]);
		if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
		boards.push({
			board_id: idx.board_id !== -1 ? (fields[idx.board_id] ?? '').trim() : '',
			address: idx.address !== -1 ? (fields[idx.address] ?? '').trim() : '',
			location_note: idx.location_note !== -1 ? (fields[idx.location_note] ?? '').trim() : '',
			lat,
			lng,
		});
	}
	return boards;
}

/** 掲示板データ（{lat, lng}の配列）全体のbboxの中心を [lat, lng] で返す。 */
export function computeCenterFromBoards(boards) {
	let minLat = Infinity;
	let maxLat = -Infinity;
	let minLng = Infinity;
	let maxLng = -Infinity;

	for (const b of boards) {
		if (b.lat < minLat) minLat = b.lat;
		if (b.lat > maxLat) maxLat = b.lat;
		if (b.lng < minLng) minLng = b.lng;
		if (b.lng > maxLng) maxLng = b.lng;
	}

	if (!Number.isFinite(minLat)) throw new Error('掲示板データから座標を抽出できませんでした');

	const round = (n) => Math.round(n * 10000) / 10000;
	return [round((minLat + maxLat) / 2), round((minLng + maxLng) / 2)];
}
