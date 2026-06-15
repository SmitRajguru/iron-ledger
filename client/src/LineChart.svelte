<script>
  // Hand-rolled inline-SVG line chart (no chart library) — CONTRACT-phase3 §2.
  // One line + dots, ~4-5 nice ticks, null y -> GAP (never 0/interpolated),
  // single point -> dot + label, tap/hover crosshair + value readout, optional
  // secondary series. Mobile-first, CSS-themeable, retina-crisp (viewBox + vector).
  export let points = []; // [{x:number, y:number|null, meta?}] x sorted asc
  export let secondary = null; // optional [{x, y:number|null, meta?}]
  export let yLabel = "";
  export let formatY = (v) => `${Math.round(v)}`;
  export let formatX = (x) => `${x}`;
  export let formatMeta = null; // (point) => string for the readout (optional)
  export let height = 220;
  /** Marker test: point => boolean (e.g. fromSingle) renders a hollow/dashed dot. */
  export let isHollow = null;
  /** Marker test: point => boolean (e.g. PR) renders a larger filled star dot. */
  export let isFilled = null;

  const PAD = { top: 14, right: 14, bottom: 26, left: 44 };
  // viewBox width tracks the container's RENDERED pixel width (bind:clientWidth)
  // so the SVG maps ~1:1 to screen pixels. A fixed viewBox + width:100% +
  // preserveAspectRatio="none" stretched <text> horizontally on wide (laptop)
  // screens ("smeared" glyphs); a width-matched viewBox keeps text undistorted.
  let cw = 0;
  $: W = cw || 320; // fallback before first measure
  $: H = height;

  // --- domains over BOTH series (so secondary shares the axes sensibly) ---
  $: allPts = secondary ? [...points, ...secondary] : points;
  $: ys = allPts.filter((p) => p.y != null).map((p) => p.y);
  $: xs = points.map((p) => p.x);
  $: hasData = ys.length > 0;
  $: xMin = xs.length ? Math.min(...xs) : 0;
  $: xMax = xs.length ? Math.max(...xs) : 1;
  $: yRaw0 = hasData ? Math.min(...ys) : 0;
  $: yRaw1 = hasData ? Math.max(...ys) : 1;
  // Nice rounded y-domain with ~4 ticks.
  $: yTicks = niceTicks(yRaw0, yRaw1, 4);
  $: yMin = yTicks.length ? yTicks[0] : yRaw0;
  $: yMax = yTicks.length ? yTicks[yTicks.length - 1] : yRaw1;

  function niceTicks(min, max, count) {
    if (!(max > min)) {
      // flat/single value: pad around it
      const v = max;
      const pad = Math.abs(v) > 0 ? Math.abs(v) * 0.1 : 1;
      min = v - pad;
      max = v + pad;
    }
    const span = max - min;
    const rawStep = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const norm = rawStep / mag;
    const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
    const start = Math.floor(min / step) * step;
    const end = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = start; v <= end + step * 1e-9; v += step) {
      ticks.push(+v.toFixed(10));
    }
    return ticks;
  }

  // --- scales (reactive: recompute when the measured width W or domains change) ---
  $: innerW = W - PAD.left - PAD.right;
  $: sx = (x) =>
    PAD.left + (xMax === xMin ? innerW / 2 : ((x - xMin) / (xMax - xMin)) * innerW);
  $: sy = (y) =>
    H - PAD.bottom - (yMax === yMin ? 0 : ((y - yMin) / (yMax - yMin)) * (H - PAD.top - PAD.bottom));

  // Build SVG path with GAPS at null y (start a new subpath after a null). Takes
  // the scales as args so the reactive paths below re-derive when W changes.
  function pathFor(pts, sx, sy) {
    let d = "";
    let pen = false; // pen down?
    for (const p of pts) {
      if (p.y == null) {
        pen = false;
        continue;
      }
      const cmd = pen ? "L" : "M";
      d += `${cmd}${sx(p.x).toFixed(2)},${sy(p.y).toFixed(2)} `;
      pen = true;
    }
    return d.trim();
  }
  $: mainPath = pathFor(points, sx, sy);
  $: secPath = secondary ? pathFor(secondary, sx, sy) : "";
  $: drawnMain = points.filter((p) => p.y != null);
  $: singlePoint = drawnMain.length === 1 ? drawnMain[0] : null;

  // --- x ticks: first / mid / last drawn point ---
  $: xTickPts = (() => {
    const d = points.filter((p) => p.y != null);
    if (!d.length) return [];
    if (d.length === 1) return [d[0]];
    if (d.length === 2) return [d[0], d[d.length - 1]];
    return [d[0], d[Math.floor((d.length - 1) / 2)], d[d.length - 1]];
  })();

  // --- crosshair / readout (tap or hover) ---
  let active = null; // nearest drawn point
  let svgEl;
  function locate(clientX) {
    if (!svgEl || !drawnMain.length) return;
    const rect = svgEl.getBoundingClientRect();
    if (rect.width <= 0) return; // unmeasured/hidden -> avoid divide-by-zero mapping
    const vx = ((clientX - rect.left) / rect.width) * W; // client -> viewBox x
    let best = null;
    for (const p of drawnMain) {
      const dx = Math.abs(sx(p.x) - vx);
      if (!best || dx < best.dx) best = { p, dx };
    }
    active = best ? best.p : null;
  }
  function onMove(e) {
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    locate(cx);
  }
  function onLeave() {
    active = null;
  }
  $: readout = active
    ? (formatMeta ? formatMeta(active) : `${formatY(active.y)} · ${formatX(active.x)}`)
    : "";
</script>

<div class="chart" style="--h:{H}px" bind:clientWidth={cw}>
  {#if !hasData}
    <p class="empty">No data yet.</p>
  {:else}
    <div class="readout" aria-live="polite">
      <span class="ylabel">{yLabel}</span>
      <span class="value">{readout || " "}</span>
    </div>
    <svg
      bind:this={svgEl}
      viewBox="0 0 {W} {H}"
      preserveAspectRatio="none"
      role="img"
      aria-label={yLabel + " chart"}
      on:mousemove={onMove}
      on:mouseleave={onLeave}
      on:touchstart|passive={onMove}
      on:touchmove|passive={onMove}
    >
      <!-- y gridlines + ticks -->
      {#each yTicks as t}
        <line class="grid" x1={PAD.left} y1={sy(t)} x2={W - PAD.right} y2={sy(t)} />
        <text class="tick y" x={PAD.left - 6} y={sy(t)} text-anchor="end" dominant-baseline="middle">
          {formatY(t)}
        </text>
      {/each}

      <!-- x ticks -->
      {#each xTickPts as p}
        <text class="tick x" x={sx(p.x)} y={H - PAD.bottom + 16} text-anchor="middle">
          {formatX(p.x)}
        </text>
      {/each}

      {#if secondary}
        <path class="line secondary" d={secPath} />
        {#each secondary.filter((p) => p.y != null) as p}
          <circle class="dot secondary" cx={sx(p.x)} cy={sy(p.y)} r="2.5" />
        {/each}
      {/if}

      <!-- main line + dots -->
      <path class="line" d={mainPath} />
      {#each drawnMain as p}
        {#if isFilled && isFilled(p)}
          <circle class="dot pr" cx={sx(p.x)} cy={sy(p.y)} r="5" />
        {:else if isHollow && isHollow(p)}
          <circle class="dot hollow" cx={sx(p.x)} cy={sy(p.y)} r="3.5" />
        {:else}
          <circle class="dot" cx={sx(p.x)} cy={sy(p.y)} r="3" />
        {/if}
      {/each}

      {#if singlePoint}
        <text class="single" x={sx(singlePoint.x)} y={sy(singlePoint.y) - 8} text-anchor="middle">
          {formatY(singlePoint.y)}
        </text>
      {/if}

      <!-- crosshair -->
      {#if active}
        <line class="crosshair" x1={sx(active.x)} y1={PAD.top} x2={sx(active.x)} y2={H - PAD.bottom} />
        <circle class="dot active" cx={sx(active.x)} cy={sy(active.y)} r="4.5" />
      {/if}
    </svg>
  {/if}
</div>

<style>
  .chart {
    --line: var(--accent);
    --grid: var(--surface-2);
    width: 100%;
  }
  svg {
    width: 100%;
    height: var(--h);
    display: block;
    touch-action: pan-y; /* allow vertical page scroll; we read horizontal taps */
  }
  .readout {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.75rem;
    font-size: 0.8rem;
    margin-bottom: 0.25rem;
  }
  .ylabel {
    color: var(--muted);
  }
  .value {
    color: var(--text);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .empty {
    color: var(--muted);
    font-size: 0.9rem;
    text-align: center;
    padding: 2rem 0;
  }
  .grid {
    stroke: var(--grid);
    stroke-width: 1;
    opacity: 0.4;
    vector-effect: non-scaling-stroke;
  }
  .tick {
    fill: var(--muted);
    font-size: 9px;
  }
  .line {
    fill: none;
    stroke: var(--line);
    stroke-width: 2;
    stroke-linejoin: round;
    stroke-linecap: round;
    vector-effect: non-scaling-stroke;
  }
  .line.secondary {
    stroke: var(--muted);
    stroke-dasharray: 4 3;
    stroke-width: 1.5;
  }
  .dot {
    fill: var(--line);
  }
  .dot.secondary {
    fill: var(--muted);
  }
  .dot.hollow {
    fill: var(--bg);
    stroke: var(--line);
    stroke-width: 2;
    vector-effect: non-scaling-stroke;
  }
  /* PR marker: larger filled dot in the "ok"/green accent. */
  .dot.pr {
    fill: var(--ok);
    stroke: var(--bg);
    stroke-width: 1.5;
    vector-effect: non-scaling-stroke;
  }
  .dot.active {
    fill: var(--line);
    stroke: var(--bg);
    stroke-width: 2;
    vector-effect: non-scaling-stroke;
  }
  .crosshair {
    stroke: var(--muted);
    stroke-width: 1;
    stroke-dasharray: 3 3;
    vector-effect: non-scaling-stroke;
  }
  .single {
    fill: var(--text);
    font-size: 11px;
    font-weight: 600;
  }
</style>
