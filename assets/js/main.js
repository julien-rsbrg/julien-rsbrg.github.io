// Maze navigator: a marker walks a random maze in step with the page scroll.
// Scrolling moves the marker; dragging the marker scrolls the page.

import { buildMaze, pointAt, projectOntoRoute, segmentIndex } from './maze.js';

const DESKTOP_COLS = 9;
const MOBILE_COLS = 7;
const MOBILE_ROWS = 11;
const MOBILE_QUERY = window.matchMedia('(max-width: 820px)'); // keep in sync with style.css
const SECTION_OFFSET = 40;   // px above a section's top where its exit is reached
const GRAB_RADIUS = 1.4;     // cell units around the marker that start a drag
const ARRIVAL_TOLERANCE = 0.05; // route length within which an exit counts as reached
const SEED = Math.floor(Math.random() * 1e9); // new maze on every visit

const $ = name => document.querySelector(`[data-maze-${name}]`);
const el = {
  box: $('box'),
  maze: document.querySelector('[data-maze]'),
  svg: $('svg'),
  walls: $('walls'),
  route: $('route'),
  halo: $('halo'),
  dot: $('dot'),
  status: $('status'),
  mini: $('mini'),
};

const sections = [...document.querySelectorAll('main section')];
const titles = sections.map(s => s.dataset.title ?? s.querySelector('h2')?.textContent.trim() ?? '');

const state = {
  maze: null,
  progress: 0,     // arc length of the marker along the route
  dragging: false,
  labels: [],
};

const pad = k => String(k + 1).padStart(2, '0');
const clamp01 = v => Math.max(0, Math.min(1, v));
const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------------------------------------------------------------------------
   Scroll ⇄ progress mapping
   ------------------------------------------------------------------------- */

/** Scroll position at which each section's exit is reached (strictly increasing). */
function sectionOffsets() {
  const max = Math.max(1, document.documentElement.scrollHeight - innerHeight);
  const ys = sections.map((s, k) =>
    k === 0 ? 0 : Math.min(max, s.getBoundingClientRect().top + scrollY - SECTION_OFFSET));
  for (let k = 1; k < ys.length; k++) ys[k] = Math.max(ys[k], ys[k - 1] + 1);
  return ys;
}

function scrollToProgress(y) {
  const { stops } = state.maze;
  const ys = sectionOffsets();
  if (y >= ys.at(-1)) return stops.at(-1);
  const k = segmentIndex(ys, y);
  const f = clamp01((y - ys[k]) / (ys[k + 1] - ys[k]));
  return stops[k] + f * (stops[k + 1] - stops[k]);
}

function progressToScroll(t) {
  const { stops } = state.maze;
  const ys = sectionOffsets();
  const k = segmentIndex(stops, t);
  const f = clamp01((t - stops[k]) / (stops[k + 1] - stops[k]));
  return ys[k] + f * (ys[k + 1] - ys[k]);
}

/* ---------------------------------------------------------------------------
   Rendering
   ------------------------------------------------------------------------- */

function createLabel(exit, k, viewHeight) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `maze-label maze-label--${exit.side}`;

  const num = document.createElement('span');
  num.className = 'maze-label__num';
  num.textContent = pad(k);
  const title = document.createElement('span');
  title.className = 'maze-label__title';
  title.textContent = titles[k];
  button.append(num, title);

  button.style.left = exit.side === 'l' ? '0%' : '100%';
  button.style.top = `${((exit.r + 1) / viewHeight) * 100}%`;

  button.addEventListener('click', () => {
    scrollTo({ top: sectionOffsets()[k], behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  });
  return button;
}

/** (Re)build the maze when its grid size changes, e.g. on resize. */
function layout() {
  const mobile = MOBILE_QUERY.matches;
  const cols = mobile ? MOBILE_COLS : DESKTOP_COLS;
  let rows = MOBILE_ROWS;
  if (!mobile) {
    const style = getComputedStyle(el.box);
    const height = el.box.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    const cellSize = el.box.clientWidth / (cols + 2);
    rows = Math.max(8, Math.floor(height / cellSize) - 1);
  }

  if (!state.maze || state.maze.cols !== cols || state.maze.rows !== rows) {
    const maze = buildMaze({ cols, rows, exitCount: sections.length, seed: SEED });
    state.maze = maze;

    // One cell of margin left/right, half a cell top/bottom, for the exits.
    const viewWidth = cols + 2;
    const viewHeight = rows + 1;
    el.svg.setAttribute('viewBox', `-1 -.5 ${viewWidth} ${viewHeight}`);
    el.walls.setAttribute('d', maze.walls);
    el.route.setAttribute('d', 'M' + maze.points.map(p => p.join(' ')).join('L'));

    state.labels.forEach(label => label.remove());
    state.labels = maze.exits.map((exit, k) => createLabel(exit, k, viewHeight));
    el.maze.append(...state.labels);
  }
  sync();
}

function render() {
  const { maze, progress: t } = state;
  const [x, y] = pointAt(maze, t);
  for (const circle of [el.dot, el.halo]) {
    circle.setAttribute('cx', x);
    circle.setAttribute('cy', y);
  }
  el.route.setAttribute('stroke-dasharray', `${t} ${maze.total + 10}`);

  // Last exit the marker has reached.
  let current = 0;
  while (current < maze.stops.length - 1 && t >= maze.stops[current + 1] - ARRIVAL_TOLERANCE) current++;
  state.labels.forEach((label, k) => {
    label.classList.toggle('is-active', k === current);
    if (k === current) label.setAttribute('aria-current', 'true');
    else label.removeAttribute('aria-current');
  });

  let status = `At ${titles[current]}`;
  if (t - maze.stops[current] > ARRIVAL_TOLERANCE) {
    const k = current;
    const percent = Math.round((100 * (t - maze.stops[k])) / (maze.stops[k + 1] - maze.stops[k]));
    status = `${titles[k]} → ${titles[k + 1]} · ${percent}%`;
  }
  el.status.textContent = status;
  el.mini.textContent = `${pad(current)} ${titles[current]}`;
}

function sync() {
  if (!state.dragging) state.progress = scrollToProgress(scrollY);
  render();
}

/* ---------------------------------------------------------------------------
   Dragging the marker
   ------------------------------------------------------------------------- */

function toSvgCoords(event) {
  const p = el.svg.createSVGPoint();
  p.x = event.clientX;
  p.y = event.clientY;
  const q = p.matrixTransform(el.svg.getScreenCTM().inverse());
  return [q.x, q.y];
}

function onPointerDown(event) {
  const [px, py] = toSvgCoords(event);
  const [x, y] = pointAt(state.maze, state.progress);
  if (Math.hypot(px - x, py - y) > GRAB_RADIUS) return;
  state.dragging = true;
  el.svg.setPointerCapture(event.pointerId);
}

function onPointerMove(event) {
  if (!state.dragging) return;
  state.progress = projectOntoRoute(state.maze, toSvgCoords(event), state.progress);
  render();
  scrollTo(0, progressToScroll(state.progress));
}

function onPointerEnd() {
  state.dragging = false;
}

/* ---------------------------------------------------------------------------
   Init
   ------------------------------------------------------------------------- */

function init() {
  if (sections.length < 2) return; // a maze needs at least two exits

  el.svg.addEventListener('pointerdown', onPointerDown);
  el.svg.addEventListener('pointermove', onPointerMove);
  el.svg.addEventListener('pointerup', onPointerEnd);
  el.svg.addEventListener('pointercancel', onPointerEnd);

  addEventListener('scroll', sync, { passive: true });
  addEventListener('resize', layout);
  document.fonts?.ready.then(layout); // font metrics change section heights

  layout();
}

init();
