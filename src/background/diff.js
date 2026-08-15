export function splitLines(text) {
	return String(text).split(/\r?\n/);
}

/**
* Myers line-diff. Returns [{ op: '=' | '+' | '-', line }].
**/
export function myersDiff(oldLines, newLines) {
	const n = oldLines.length;
	const m = newLines.length;
	if (n === 0 && m === 0) return [];
	if (n === 0) return newLines.map((line) => ({ op: '+', line }));
	if (m === 0) return oldLines.map((line) => ({ op: '-', line }));

	const max = n + m;
	const offset = max;
	const trace = [];
	const v = new Array(2 * max + 1).fill(0);

	outer: for (let d = 0; d <= max; d++) {
		trace.push(v.slice());
		for (let k = -d; k <= d; k += 2) {
			let x;
			if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) {
				x = v[k + 1 + offset];
			} else {
				x = v[k - 1 + offset] + 1;
			}
			let y = x - k;
			while (x < n && y < m && oldLines[x] === newLines[y]) {
				x++;
				y++;
			}
			v[k + offset] = x;
			if (x >= n && y >= m) break outer;
		}
	}

	// backtrack
	const ops = [];
	let x = n;
	let y = m;
	for (let d = trace.length - 1; d >= 0; d--) {
		const vPrev = trace[d];
		const k = x - y;
		let prevK;
		if (k === -d || (k !== d && vPrev[k - 1 + offset] < vPrev[k + 1 + offset])) {
			prevK = k + 1;
		} else {
			prevK = k - 1;
		}
		const prevX = vPrev[prevK + offset];
		const prevY = prevX - prevK;

		while (x > prevX && y > prevY) {
			ops.push({ op: '=', line: oldLines[x - 1] });
			x--;
			y--;
		}
		if (d > 0) {
			if (x > prevX) {
				ops.push({ op: '-', line: oldLines[x - 1] });
				x = prevX;
			} else if (y > prevY) {
				ops.push({ op: '+', line: newLines[y - 1] });
				y = prevY;
			}
		}
	}
	return ops.reverse();
}
