// The biggest 16:9 tiles that fit n cameras into w×h, but never narrower than minTile
// (below that the grid scrolls instead, so videos stay watchable).
export function fitGrid(n: number, w: number, h: number, minTile = 300, gap = 8) {
  let best = { cols: 1, tile: 0 };
  for (let cols = 1; cols <= Math.max(1, n); cols++) {
    const rows = Math.ceil(n / cols);
    const tile = Math.min((w - gap * (cols - 1)) / cols, ((h - gap * (rows - 1)) / rows) * (16 / 9));
    if (tile > best.tile) best = { cols, tile };
  }
  if (best.tile < Math.min(minTile, w)) {
    const cols = Math.max(1, Math.floor((w + gap) / (minTile + gap)));
    best = { cols, tile: (w - gap * (cols - 1)) / cols };
  }
  return { cols: best.cols, tile: Math.floor(best.tile) };
}
