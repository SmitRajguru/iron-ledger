<script>
  // Body composition screen (CONTRACT-phase3 §4). Log form (4 optional metrics,
  // date default today, display-unit aware, fat_mass derived placeholder, ≥1
  // required) -> measurement event. Bodyweight headline = 7-day moving average
  // with faint raw dots behind. Other metrics as trend lines. Edit/delete via
  // voids. Absorbs the 2b minimal bodyweight capture (same event type).
  import { queue } from "./lib/sync.js";
  import {
    logState,
    buildMeasurementEventFull,
    buildMeasurementDeleteEvent,
    daysSince,
  } from "./lib/logging.js";
  import {
    measurementSeries,
    movingAverage,
    deriveBodyComp,
  } from "./lib/analytics.js";
  import {
    displayUnit,
    toDisplay,
    toBase,
    lengthToDisplay,
    lengthToBase,
    lengthUnitFor,
  } from "./lib/units.js";
  import { todayLocalDate } from "./lib/logging.js";
  import LineChart from "./LineChart.svelte";

  // Length unit (waist) pairs with the weight toggle: lb -> in, kg -> cm.
  $: lenUnit = lengthUnitFor($displayUnit);

  // --- log form ---
  // Weight inputs hold DISPLAY strings (current unit), but the canonical base
  // (lb, full precision) is kept alongside so a unit toggle re-derives the shown
  // value without round-tripping through display rounding into storage (F4,
  // mirrors ExerciseCard). bf is unitless and needs no base.
  let date = todayLocalDate();
  let bw = "";
  let mm = "";
  let bf = ""; // body_fat_pct (unitless)
  let fm = ""; // fat_mass (overridable derived)
  let waist = ""; // waist circumference (display length unit in/cm)
  let bwBase = null; // lb | null
  let mmBase = null;
  let fmBase = null;
  let waistBase = null; // cm | null (canonical length)
  let bwFocused = false;
  let mmFocused = false;
  let fmFocused = false;
  let waistFocused = false;
  let editingSrcId = null;
  let error = "";

  // Display strings <- canonical base (skip a focused field: the user owns it).
  function syncDisplayFromBase() {
    if (!bwFocused) bw = bwBase == null ? "" : toDisplay(bwBase, $displayUnit);
    if (!mmFocused) mm = mmBase == null ? "" : toDisplay(mmBase, $displayUnit);
    if (!fmFocused) fm = fmBase == null ? "" : toDisplay(fmBase, $displayUnit);
    if (!waistFocused) waist = waistBase == null ? "" : lengthToDisplay(waistBase, $displayUnit);
  }
  // User edited a field -> recompute the canonical base (full precision, no round).
  const inputBase = (s) => (s === "" || s == null ? null : toBase(Number(s)));
  // On a display-unit toggle, re-derive the shown strings from the unchanged base.
  let prevUnit = $displayUnit;
  $: if ($displayUnit !== prevUnit) {
    prevUnit = $displayUnit;
    syncDisplayFromBase();
  }

  // Derived fat_mass placeholder from current bw + bf (display units for bw).
  $: fmPlaceholder =
    bw !== "" && bf !== "" && Number(bw) > 0
      ? ((Number(bw) * Number(bf)) / 100).toFixed(1)
      : "";

  $: anyMetric = [bw, mm, bf, fm, waist].some((v) => v !== "" && v != null);

  async function save() {
    error = "";
    if (!anyMetric) {
      error = "Enter at least one measurement.";
      return;
    }
    const ev = buildMeasurementEventFull({
      date,
      // Save from the canonical base (full precision) so a toggled-but-unedited
      // value never bakes display rounding into storage (F4).
      bodyweightBase: bwBase,
      muscleMassBase: mmBase,
      bodyFatPct: bf === "" ? null : bf,
      fatMassBase: fmBase,
      waistBase: waistBase,
      voids: editingSrcId || undefined,
    });
    await queue(ev);
    resetForm();
  }
  function resetForm() {
    bw = mm = bf = fm = waist = "";
    bwBase = mmBase = fmBase = waistBase = null;
    date = todayLocalDate();
    editingSrcId = null;
  }
  function editEntry(m) {
    // Seed the form from a logged measurement. Stored values are canonical (lb /
    // cm); keep them as the base and derive the display strings from the current
    // unit, so a later unit toggle reconverts correctly (no mis-saved unit).
    editingSrcId = m.__src_id;
    date = m.date;
    bwBase = m.bodyweight == null ? null : m.bodyweight;
    mmBase = m.muscle_mass == null ? null : m.muscle_mass;
    fmBase = m.fat_mass == null ? null : m.fat_mass;
    waistBase = m.waist == null ? null : m.waist;
    bf = m.body_fat_pct == null ? "" : m.body_fat_pct;
    syncDisplayFromBase();
  }
  async function deleteEntry(m) {
    // H1: measurement TOMBSTONE — {deleted:true}+voids. The void removes the
    // prior measurement from the fold, and the server accepts the deleted shape
    // (unlike the old metric-less {date,unit} which the ≥1-metric rule rejected).
    await queue(buildMeasurementDeleteEvent(m.__src_id));
    if (editingSrcId === m.__src_id) resetForm();
  }

  // --- series + charts ---
  $: measurements = $logState.folded.measurements || [];
  const dayNum = (d) => Math.floor(new Date(d + "T00:00:00").getTime() / 86400000);
  const fmtDate = (x) =>
    new Date(x * 86400000).toLocaleDateString("en-US", { month: "short", day: "numeric" });

  const RANGES = [
    { key: "12w", label: "12 wk", days: 84 },
    { key: "6mo", label: "6 mo", days: 182 },
    { key: "1y", label: "1 yr", days: 365 },
    { key: "all", label: "All", days: null },
  ];
  let rangeKey = "12w";
  $: rangeDays = RANGES.find((r) => r.key === rangeKey)?.days ?? null;
  const inRange = (pts) =>
    pts.filter((p) => rangeDays == null || daysSince(p.date) <= rangeDays);

  // Bodyweight: raw dots (faint) + 7-day moving-average line (headline).
  $: bwRaw = inRange(measurementSeries(measurements, "bodyweight"));
  $: bwMA = movingAverage(bwRaw, 7);
  // Pass $displayUnit explicitly so these reactive points re-run on an lb/kg
  // toggle (toDisplay reads the global otherwise, which Svelte can't track —
  // the {#key} remount alone would just re-render stale numbers).
  $: bwMAPoints = bwMA.map((p) => ({ x: dayNum(p.date), y: toDisplay(p.value, $displayUnit) }));
  $: bwRawPoints = bwRaw.map((p) => ({ x: dayNum(p.date), y: toDisplay(p.value, $displayUnit) }));

  // Other metrics: plain trend lines.
  $: mmPoints = inRange(measurementSeries(measurements, "muscle_mass")).map((p) => ({
    x: dayNum(p.date),
    y: toDisplay(p.value, $displayUnit),
  }));
  $: bfPoints = inRange(measurementSeries(measurements, "body_fat_pct")).map((p) => ({
    x: dayNum(p.date),
    y: p.value, // unitless %
  }));
  $: fmPoints = inRange(measurementSeries(measurements, "fat_mass")).map((p) => ({
    x: dayNum(p.date),
    y: toDisplay(p.value, $displayUnit),
  }));
  // Waist: canonical cm -> display length unit (in/cm) per the weight toggle.
  $: waistPoints = inRange(measurementSeries(measurements, "waist")).map((p) => ({
    x: dayNum(p.date),
    y: lengthToDisplay(p.value, $displayUnit),
  }));

  // Recent entries (derived fat%/fat_mass shown), newest first, for edit/delete.
  $: recentEntries = measurements
    .map((m) => deriveBodyComp(m))
    .slice()
    .reverse()
    .slice(0, 12);

  function fmtNum(v) {
    if (v == null) return "—";
    return Number.isInteger(v) ? String(v) : v.toFixed(1);
  }
</script>

<div class="screen">
  <h2>Body</h2>

  <form class="log" on:submit|preventDefault={save}>
    <div class="row">
      <label>
        <span class="muted small">Date</span>
        <input type="date" bind:value={date} max={todayLocalDate()} />
      </label>
    </div>
    <div class="grid">
      <label>
        <span class="muted small">Bodyweight ({$displayUnit})</span>
        <input
          type="number"
          inputmode="decimal"
          step="0.1"
          bind:value={bw}
          on:input={() => (bwBase = inputBase(bw))}
          on:focus={() => (bwFocused = true)}
          on:blur={() => {
            bwFocused = false;
            bw = bwBase == null ? "" : toDisplay(bwBase, $displayUnit);
          }}
        />
      </label>
      <label>
        <span class="muted small">Muscle mass ({$displayUnit})</span>
        <input
          type="number"
          inputmode="decimal"
          step="0.1"
          bind:value={mm}
          on:input={() => (mmBase = inputBase(mm))}
          on:focus={() => (mmFocused = true)}
          on:blur={() => {
            mmFocused = false;
            mm = mmBase == null ? "" : toDisplay(mmBase, $displayUnit);
          }}
        />
      </label>
      <label>
        <span class="muted small">Body fat %</span>
        <input type="number" inputmode="decimal" step="0.1" bind:value={bf} />
      </label>
      <label>
        <span class="muted small">Fat mass ({$displayUnit})</span>
        <input
          type="number"
          inputmode="decimal"
          step="0.1"
          bind:value={fm}
          on:input={() => (fmBase = inputBase(fm))}
          on:focus={() => (fmFocused = true)}
          on:blur={() => {
            fmFocused = false;
            fm = fmBase == null ? "" : toDisplay(fmBase, $displayUnit);
          }}
          placeholder={fmPlaceholder}
        />
      </label>
      <label>
        <span class="muted small">Waist ({lenUnit})</span>
        <input
          type="number"
          inputmode="decimal"
          step="0.1"
          bind:value={waist}
          on:input={() => (waistBase = lengthToBase(waist, $displayUnit))}
          on:focus={() => (waistFocused = true)}
          on:blur={() => {
            waistFocused = false;
            waist = waistBase == null ? "" : lengthToDisplay(waistBase, $displayUnit);
          }}
        />
      </label>
    </div>
    {#if error}<p class="error">{error}</p>{/if}
    <div class="form-actions">
      <button type="submit" class="primary">
        {editingSrcId ? "Save changes" : "Log measurement"}
      </button>
      {#if editingSrcId}
        <button type="button" class="link" on:click={resetForm}>Cancel edit</button>
      {/if}
    </div>
  </form>

  <div class="seg ranges">
    {#each RANGES as r}
      <button class="seg-btn" class:on={rangeKey === r.key} on:click={() => (rangeKey = r.key)}>
        {r.label}
      </button>
    {/each}
  </div>

  <section class="chart-card">
    <h3>Bodyweight ({$displayUnit})</h3>
    <p class="muted small">7-day average; faint dots are raw entries.</p>
    {#key rangeKey + $displayUnit + measurements.length}
      <LineChart
        points={bwMAPoints}
        secondary={bwRawPoints}
        yLabel="7-day avg"
        formatY={fmtNum}
        formatX={fmtDate}
      />
    {/key}
  </section>

  {#if mmPoints.length}
    <section class="chart-card">
      <h3>Muscle mass ({$displayUnit})</h3>
      {#key rangeKey + $displayUnit + measurements.length}
        <LineChart points={mmPoints} yLabel="trend" formatY={fmtNum} formatX={fmtDate} />
      {/key}
    </section>
  {/if}
  {#if bfPoints.length}
    <section class="chart-card">
      <h3>Body fat %</h3>
      {#key rangeKey + measurements.length}
        <LineChart points={bfPoints} yLabel="trend" formatY={fmtNum} formatX={fmtDate} />
      {/key}
    </section>
  {/if}
  {#if fmPoints.length}
    <section class="chart-card">
      <h3>Fat mass ({$displayUnit})</h3>
      {#key rangeKey + $displayUnit + measurements.length}
        <LineChart points={fmPoints} yLabel="trend" formatY={fmtNum} formatX={fmtDate} />
      {/key}
    </section>
  {/if}
  {#if waistPoints.length}
    <section class="chart-card">
      <h3>Waist ({lenUnit})</h3>
      {#key rangeKey + $displayUnit + measurements.length}
        <LineChart points={waistPoints} yLabel="trend" formatY={fmtNum} formatX={fmtDate} />
      {/key}
    </section>
  {/if}

  {#if recentEntries.length}
    <section class="entries">
      <h3>Recent entries</h3>
      <ul>
        {#each recentEntries as m (m.__src_id)}
          <li>
            <div class="e-main">
              <span class="e-date">{m.date}</span>
              <span class="muted small">
                {#if m.bodyweight != null}{fmtNum(toDisplay(m.bodyweight, $displayUnit))} {$displayUnit}{/if}
                {#if m.body_fat_pct != null} · {fmtNum(m.body_fat_pct)}%{/if}
                {#if m.fat_mass != null} · fat {fmtNum(toDisplay(m.fat_mass, $displayUnit))} {$displayUnit}{/if}
                {#if m.muscle_mass != null} · musc {fmtNum(toDisplay(m.muscle_mass, $displayUnit))} {$displayUnit}{/if}
                {#if m.waist != null} · waist {fmtNum(lengthToDisplay(m.waist, $displayUnit))} {lenUnit}{/if}
              </span>
            </div>
            <div class="e-actions">
              <button class="link" on:click={() => editEntry(m)}>Edit</button>
              <button class="link" on:click={() => deleteEntry(m)}>Delete</button>
            </div>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</div>

<style>
  .screen {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  h2 {
    margin: 0;
  }
  h3 {
    margin: 0 0 0.25rem;
    font-size: 1rem;
  }
  .muted {
    color: var(--muted);
  }
  .small {
    font-size: 0.78rem;
  }
  .log {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    background: var(--surface);
    border: 1px solid var(--surface-2);
    border-radius: 12px;
    padding: 0.9rem 1rem;
  }
  .grid {
    display: grid;
    /* 2 columns; minmax(0, 1fr) lets cells shrink BELOW their content so the
       inputs never force horizontal overflow (the default `1fr` = minmax(auto,1fr)
       does). Stacks to 1 column on very narrow phones. */
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.6rem;
  }
  @media (max-width: 360px) {
    .grid {
      grid-template-columns: 1fr;
    }
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    min-width: 0; /* let the cell shrink below the input's intrinsic width */
  }
  input {
    min-height: 48px;
    width: 100%;
    box-sizing: border-box; /* padding stays inside the cell -> no overflow */
    padding: 0 0.7rem;
    border-radius: 10px;
    border: 1px solid var(--surface-2);
    background: var(--bg);
    color: var(--text);
    font-size: 1rem;
    font-family: inherit;
  }
  .form-actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .primary {
    min-height: 48px;
    padding: 0 1.1rem;
    border: 0;
    border-radius: 10px;
    background: var(--accent);
    color: var(--bg);
    font-weight: 600;
    cursor: pointer;
    font-family: inherit;
  }
  .link {
    border: 0;
    background: transparent;
    color: var(--accent);
    cursor: pointer;
    font-family: inherit;
    font-size: 0.85rem;
    min-height: 40px;
    padding: 0.4rem;
  }
  .error {
    color: var(--danger);
    font-size: 0.85rem;
    margin: 0;
  }
  .seg {
    display: inline-flex;
    border: 1px solid var(--surface-2);
    border-radius: 10px;
    overflow: hidden;
  }
  .seg-btn {
    min-height: 40px;
    padding: 0 0.7rem;
    border: 0;
    background: var(--bg);
    color: var(--muted);
    cursor: pointer;
    font-family: inherit;
    font-size: 0.85rem;
  }
  .seg-btn.on {
    background: var(--accent);
    color: var(--bg);
    font-weight: 600;
  }
  .chart-card {
    background: var(--surface);
    border: 1px solid var(--surface-2);
    border-radius: 12px;
    padding: 0.9rem 1rem;
  }
  .entries ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .entries li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    background: var(--surface);
    border: 1px solid var(--surface-2);
    border-radius: 10px;
    padding: 0.5rem 0.75rem;
  }
  .e-main {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    min-width: 0;
  }
  .e-date {
    font-weight: 600;
  }
  .e-actions {
    display: flex;
    gap: 0.25rem;
    flex-shrink: 0;
  }
</style>
