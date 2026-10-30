// Maze generation and route geometry. Pure functions, no DOM access.
//
// Coordinates are in cell units: cell (c, r) spans [c, c+1] × [r, r+1].
// Exits alternate left/right, evenly spaced from the top row to the bottom row.

/** Deterministic PRNG (mulberry32). Returns a function yielding floats in [0, 1). */
export function createRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const grid = (cols, rows, value) =>
  Array.from({ length: rows }, () => Array(cols).fill(value));

const clamp01 = v => Math.max(0, Math.min(1, v));

/** Recursive-backtracker maze. east[r][c] / south[r][c] are true when that wall stands. */
function carve(cols, rows, rng) {
  const east = grid(cols, rows, true);
  const south = grid(cols, rows, true);
  const visited = grid(cols, rows, false);
  const stack = [[0, 0]];
  visited[0][0] = true;

  while (stack.length) {
    const [c, r] = stack[stack.length - 1];
    const options = [[c + 1, r], [c - 1, r], [c, r + 1], [c, r - 1]]
      .filter(([x, y]) => x >= 0 && y >= 0 && x < cols && y < rows && !visited[y][x]);

    if (!options.length) {
      stack.pop();
      continue;
    }

    const [x, y] = options[Math.floor(rng() * options.length)];
    if (x > c) east[r][c] = false;
    else if (x < c) east[r][x] = false;
    else if (y > r) south[r][c] = false;
    else south[y][c] = false;

    visited[y][x] = true;
    stack.push([x, y]);
  }
  return { east, south };
}

function placeExits(cols, rows, count) {
  return Array.from({ length: count }, (_, k) => {
    const side = k % 2 ? 'r' : 'l';
    return {
      side,
      c: side === 'l' ? 0 : cols - 1,
      r: Math.round((k * (rows - 1)) / (count - 1)),
    };
  });
}

/** SVG path data for every standing wall, leaving gaps at the exits. */
function wallsPath(cols, rows, { east, south }, exits) {
  const isExit = (side, c, r) => exits.some(e => e.side === side && e.c === c && e.r === r);

  let d = `M0 0H${cols}`;
  for (let r = 0; r < rows; r++) {
    if (!isExit('l', 0, r)) d += `M0 ${r}V${r + 1}`;
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (east[r][c] && !isExit('r', c, r)) d += `M${c + 1} ${r}V${r + 1}`;
      if (south[r][c]) d +=`M${c} ${r + 1}H${c + 1}`;
    }
  }
  return d;
}

function neighbours(cols, rows, { east, south }, [c, r]) {
  const out = [];
  if (c < cols - 1 && !east[r][c]) out.push([c + 1, r]);
  if (c > 0 && !east[r][c - 1]) out.push([c - 1, r]);
  if (r < rows - 1 && !south[r][c]) out.push([c, r + 1]);
  if (r > 0 && !south[r - 1][c]) out.push([c, r - 1]);
  return out;
}

/** Breadth-first search; returns the list of cells from start to goal (inclusive). */
function shortestPath(cols, rows, walls, start, goal) {
  const key = ([c, r]) => r * cols + c;
  const prev = new Map([[key(start), null]]);
  const queue = [start];

  while (queue.length) {
    const cur = queue.shift();
    if (key(cur) === key(goal)) break;
    for (const n of neighbours(cols, rows, walls, cur)) {
      if (!prev.has(key(n))) {
        prev.set(key(n), cur);
        queue.push(n);
      }
    }
  }

  const path = [];
  for (let cur = goal; cur; cur = prev.get(key(cur))) path.unshift(cur);
  return path;
}

/** Point just outside the maze, beyond an exit. */
function outsidePoint(exit, cols) {
  return [exit.side === 'l' ? -0.75 : cols + 0.75, exit.r + 0.5];
}

/**
 * Build a maze with one exit per section and a route visiting them in order.
 *
 * Returns { cols, rows, exits, walls, points, cumulative, total, stops }:
 *   points      polyline of the route
 *   cumulative  arc length at each point
 *   stops       arc length at each exit
 */
export function buildMaze({ cols, rows, exitCount, seed }) {
  if (exitCount < 2) throw new Error('buildMaze needs at least two exits');

  const wallGrid = carve(cols, rows, createRng(seed));
  const exits = placeExits(cols, rows, exitCount);

  const points = [outsidePoint(exits[0], cols)];
  const stopIndices = [0];
  for (let k = 0; k < exitCount - 1; k++) {
    const from = [exits[k].c, exits[k].r];
    const to = [exits[k + 1].c, exits[k + 1].r];
    for (const [c, r] of shortestPath(cols, rows, wallGrid, from, to)) points.push([c + 0.5, r + 0.5]);
    points.push(outsidePoint(exits[k + 1], cols));
    stopIndices.push(points.length - 1);
  }

  const cumulative = [0];
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1];
    const [bx, by] = points[i];
    cumulative.push(cumulative[i - 1] + Math.hypot(bx - ax, by - ay));
  }

  return {
    cols,
    rows,
    exits,
    walls: wallsPath(cols, rows, wallGrid, exits),
    points,
    cumulative,
    total: cumulative.at(-1),
    stops: stopIndices.map(i => cumulative[i]),
  };
}

/** Position on the route at arc length t. */
export function pointAt({ points, cumulative }, t) {
  let i = 1;
  while (i < cumulative.length - 1 && cumulative[i] < t) i++;
  const f = clamp01((t - cumulative[i - 1]) / (cumulative[i] - cumulative[i - 1] || 1));
  const [ax, ay] = points[i - 1];
  const [bx, by] = points[i];
  return [ax + (bx - ax) * f, ay + (by - ay) * f];
}

/**
 * Arc length of the route point closest to [x, y], searching only within
 * `reach` of the current arc length t so the marker can't jump through walls.
 */
export function projectOntoRoute({ points, cumulative }, [x, y], t, reach = 2.5) {
  let best = t;
  let bestDist = Infinity;

  for (let i = 1; i < points.length; i++) {
    if (cumulative[i] < t - reach || cumulative[i - 1] > t + reach) continue;

    const [ax, ay] = points[i - 1];
    const [bx, by] = points[i];
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy || 1;
    const f = clamp01(((x - ax) * dx + (y - ay) * dy) / lenSq);
    const dist = (ax + dx * f - x) ** 2 + (ay + dy * f - y) ** 2;
    const s = cumulative[i - 1] + Math.sqrt(lenSq) * f;

    if (dist < bestDist && Math.abs(s - t) <= reach) {
      bestDist = dist;
      best = s;
    }
  }
  return best;
}

/** Index of the segment [arr[k], arr[k+1]] containing v (arr sorted ascending). */
export function segmentIndex(arr, v) {
  let k = 0;
  while (k < arr.length - 2 && v >= arr[k + 1]) k++;
  return k;
}
