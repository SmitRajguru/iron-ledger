<script>
  // Lift Graphs screen (CONTRACT-phase3 §3). Pick an exercise -> e1RM hero chart
  // (default) + volume (toggle, NOT dual-axis). Range default 12 weeks. Weights
  // converted lb->display at render. fromSingle points marked hollow. Bodyweight
  // lifts also plot the assist/added line + a "computed off bodyweight" note.
  import { activeExercises, libraryMap } from "./lib/library.js";
  import { exerciseSeries, prsFor, cardioSeries } from "./lib/analytics.js";
  import { logState } from "./lib/logging.js";
  import { daysSince } from "./lib/logging.js";
  import {
    displayUnit,
    toDisplay,
    distanceUnit,
    setDistanceUnit,
    metersToDisplay,
    formatDuration,
  } from "./lib/units.js";
  import LineChart from "./LineChart.svelte";

  let selectedId = null;
  let metric = "e1rm"; // "e1rm" | "volume" (strength) | "duration" | "distance" (cardio)
  const RANGES = [
    { key: "12w", label: "12 wk", days: 84 },
    { key: "6mo", label: "6 mo", days: 182 },
    { key: "1y", label: "1 yr", days: 365 },
    { key: "all", label: "All", days: null },
  ];
  let rangeKey = "12w";

  $: exercise = selectedId ? $libraryMap[selectedId] : null;
  $: isCardio = exercise && exercise.type === "cardio";
  // When switching to/from a cardio exercise, snap the metric to a valid one.
  $: if (isCardio && metric !== "duration" && metric !== "distance") metric = "duration";
  $: if (exercise && !isCardio && metric !== "e1rm" && metric !== "volume") metric = "e1rm";
  // Recompute series off the live fold + selected exercise.
  $: series = exercise && !isCardio ? exerciseSeries($logState.folded, exercise) : null;
  $: cardio = exercise && isCardio ? cardioSeries($logState.folded, exercise.exercise_id) : null;
  // PR session dates (5a) for the strength chart markers.
  $: prSet =
    exercise && !isCardio ? prsFor($logState.folded, exercise) : { e1rm: new Set(), volume: new Set() };

  // Filter to the selected range (by session_date vs today).
  $: rangeDays = RANGES.find((r) => r.key === rangeKey)?.days ?? null;
  const inRange = (p) => rangeDays == null || daysSince(p.session_date) <= rangeDays;
  $: visiblePoints = series ? series.points.filter(inRange) : [];
  $: cardioVisible = cardio ? cardio.points.filter(inRange) : [];

  // x = day index (ms epoch / day) so spacing reflects real time gaps.
  const dayNum = (d) => Math.floor(new Date(d + "T00:00:00").getTime() / 86400000);
  const fmtDate = (x) => {
    const d = new Date(x * 86400000);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  // Chart points for the active metric. Strength: e1RM/volume (lb->display) with
  // a PR flag (5a marker). Cardio: duration (s) / distance (m->display unit).
  $: chartPoints = isCardio
    ? cardioVisible.map((p) => ({
        x: dayNum(p.session_date),
        y:
          metric === "duration"
            ? p.duration_s ?? null
            : p.distance_m == null
              ? null
              : metersToDisplay(p.distance_m, $distanceUnit),
        src: p,
      }))
    : visiblePoints.map((p) => ({
        x: dayNum(p.session_date),
        // Pass $displayUnit explicitly so this reactive block re-runs on an lb/kg
        // toggle — toDisplay() reads the global otherwise, which Svelte can't track
        // as a dependency, leaving the axis numbers stale while the label flipped.
        y:
          metric === "e1rm"
            ? p.e1rm == null
              ? null
              : toDisplay(p.e1rm, $displayUnit)
            : p.volume == null
              ? null
              : toDisplay(p.volume, $displayUnit),
        src: p,
        pr:
          metric === "e1rm"
            ? prSet.e1rm.has(p.session_date)
            : prSet.volume.has(p.session_date),
      }));

  // Bodyweight lifts: secondary line = added/assist load over time (display).
  $: secondaryPoints =
    exercise && exercise.uses_bodyweight && metric === "e1rm"
      ? visiblePoints.map((p) => ({
          x: dayNum(p.session_date),
          y: p.addedWeight == null ? null : toDisplay(p.addedWeight, $displayUnit),
          src: p,
        }))
      : null;

  // Days between two YYYY-MM-DD dates (a − b), or null if either missing.
  function daysBetween(a, b) {
    if (!a || !b) return null;
    const ms = (d) => new Date(d + "T00:00:00").getTime();
    return Math.round((ms(a) - ms(b)) / 86400000);
  }
  // M1: stale note fires ONLY when a visible point's snapshot date is >30 days
  // before its session date. Points lacking a snapshot date show NO note.
  $: staleNote =
    exercise &&
    exercise.uses_bodyweight &&
    visiblePoints.some((p) => {
      const gap = daysBetween(p.session_date, p.bwSnapshotDate);
      return gap != null && gap > 30;
    });

  function readout(point) {
    const p = point.src;
    if (!p) return "";
    const date = fmtDate(point.x);
    if (isCardio) {
      if (metric === "duration") {
        return p.duration_s == null ? `— · ${date}` : `${formatDuration(p.duration_s)} · ${date}`;
      }
      return p.distance_m == null
        ? `— · ${date}`
        : `${metersToDisplay(p.distance_m, $distanceUnit).toFixed(2)} ${$distanceUnit} · ${date}`;
    }
    if (metric === "e1rm") {
      if (p.e1rm == null) return `— · ${date}`;
      const top = p.topSet;
      const setStr = top
        ? `${formatTop(top)}${p.fromSingle ? " (1-rep est.)" : ""}`
        : "";
      const prTag = point.pr ? " ★PR" : "";
      return `e1RM ${toDisplay(p.e1rm)} ${$displayUnit} · ${setStr} · ${date}${prTag}`;
    }
    if (p.volume == null) return `— · ${date}`;
    return `vol ${toDisplay(p.volume)} ${$displayUnit} · ${date}${point.pr ? " ★PR" : ""}`;
  }
  function formatTop(s) {
    // Bodyweight: show assist/added intent; else weight×reps.
    if (exercise.uses_bodyweight) {
      const add = s.added_weight ?? 0;
      const tag = add < 0 ? `assist ${toDisplay(Math.abs(add))}` : add > 0 ? `+${toDisplay(add)}` : "BW";
      return `${tag}×${s.reps}`;
    }
    return `${toDisplay(s.weight)}×${s.reps}`;
  }

  $: empty = isCardio
    ? !cardio || cardio.empty || chartPoints.every((p) => p.y == null)
    : !series || series.empty || visiblePoints.every((p) => p.e1rm == null && p.volume == null);
</script>

<div class="screen">
  <h2>Graphs</h2>

  <label class="pick">
    <span class="muted small">Exercise</span>
    <select bind:value={selectedId}>
      <option value={null}>Choose an exercise…</option>
      {#each $activeExercises as e (e.exercise_id)}
        <option value={e.exercise_id}>{e.name}{e.type === "cardio" ? " (cardio)" : ""}</option>
      {/each}
    </select>
  </label>

  {#if exercise}
    <div class="controls">
      <div class="seg">
        {#if isCardio}
          <button class="seg-btn" class:on={metric === "duration"} on:click={() => (metric = "duration")}>
            Duration
          </button>
          <button class="seg-btn" class:on={metric === "distance"} on:click={() => (metric = "distance")}>
            Distance
          </button>
        {:else}
          <button class="seg-btn" class:on={metric === "e1rm"} on:click={() => (metric = "e1rm")}>
            Est. 1RM
          </button>
          <button class="seg-btn" class:on={metric === "volume"} on:click={() => (metric = "volume")}>
            Volume
          </button>
        {/if}
      </div>
      <div class="seg">
        {#each RANGES as r}
          <button class="seg-btn" class:on={rangeKey === r.key} on:click={() => (rangeKey = r.key)}>
            {r.label}
          </button>
        {/each}
      </div>
    </div>

    {#if isCardio && metric === "distance"}
      <div class="seg dist-toggle">
        <button class="seg-btn" class:on={$distanceUnit === "km"} on:click={() => setDistanceUnit("km")}>km</button>
        <button class="seg-btn" class:on={$distanceUnit === "mi"} on:click={() => setDistanceUnit("mi")}>mi</button>
      </div>
    {/if}

    {#if empty}
      <p class="empty-state">Log a few sessions to see trends.</p>
    {:else if isCardio}
      {#key metric + rangeKey + selectedId + $distanceUnit}
        <LineChart
          points={chartPoints}
          yLabel={metric === "duration" ? "Duration" : `Distance (${$distanceUnit})`}
          formatY={(v) => (metric === "duration" ? formatDuration(v) : toDisplayRound(v))}
          formatX={fmtDate}
          formatMeta={readout}
        />
      {/key}
    {:else}
      {#key metric + rangeKey + selectedId + $displayUnit}
        <LineChart
          points={chartPoints}
          secondary={secondaryPoints}
          yLabel={metric === "e1rm" ? `Est. 1RM (${$displayUnit})` : `Volume (${$displayUnit})`}
          formatY={(v) => `${toDisplayRound(v)}`}
          formatX={fmtDate}
          formatMeta={readout}
          isHollow={(pt) => metric === "e1rm" && pt.src && pt.src.fromSingle}
          isFilled={(pt) => pt.pr}
        />
      {/key}
      {#if exercise.uses_bodyweight && metric === "e1rm"}
        <p class="muted small note">
          Effective load is computed off the bodyweight frozen at each session.
          {#if staleNote}Some points use a bodyweight 30+ days old.{/if}
          The dashed line is added/assist weight.
        </p>
      {/if}
      <p class="muted small note">Hollow points are 1-rep e1RM estimates. ★ marks a PR.</p>
    {/if}
  {:else}
    <p class="muted">Pick an exercise to see its trends.</p>
  {/if}
</div>

<script context="module">
  // value labels: drop trailing .0
  function toDisplayRound(v) {
    return Number.isInteger(v) ? String(v) : v.toFixed(1);
  }
</script>

<style>
  .screen {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  h2 {
    margin: 0;
  }
  .muted {
    color: var(--muted);
  }
  .small {
    font-size: 0.78rem;
  }
  .pick {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .pick select {
    min-height: 48px;
    padding: 0 0.7rem;
    border-radius: 10px;
    border: 1px solid var(--surface-2);
    background: var(--bg);
    color: var(--text);
    font-size: 1rem;
    font-family: inherit;
  }
  .controls {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    justify-content: space-between;
  }
  .seg {
    display: flex;
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
  .empty-state {
    color: var(--muted);
    text-align: center;
    padding: 2rem 0;
  }
  .note {
    margin: 0;
  }
</style>
