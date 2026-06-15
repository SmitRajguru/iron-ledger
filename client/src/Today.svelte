<script>
  // Today screen (CONTRACT-phase2b) — THE core logging loop. Optimized for
  // one-tap confirm with prefill, big steppers, per-set save state, and
  // offline-first logging through the existing queue()/sync pipe.
  import { queue, syncState } from "./lib/sync.js";
  import {
    libraryMap,
    activeExercises,
    routinesMap,
    activeRoutines,
    weekdayFromJsDay,
    WEEKDAYS,
  } from "./lib/library.js";
  import { tick, onMount, onDestroy } from "svelte";
  import { displayUnit } from "./lib/units.js";
  import {
    logState,
    latestBodyweight,
    freshestBodyweightFull,
    todayLocalDate,
    buildMeasurementEvent,
    lastSessionFromFold,
    daysSince,
  } from "./lib/logging.js";
  import {
    loadSession,
    saveSession,
    selectionFromRoutine,
    resolveSessionExercises,
    defaultRoutineIdForDate,
  } from "./lib/session.js";
  import ExerciseCard from "./ExerciseCard.svelte";

  const { outbox, rejectedIds } = syncState;

  // F5: the SELECTED session date drives BOTH prefill/nextSetToLog (in the cards)
  // AND the logged event session_date. Defaults to today's LA date; the user can
  // pick a past day (or today). `effectiveDate` is the single source of truth.
  // `onToday` tracks whether the user is following "today" (vs a pinned past
  // date). While on today, `effectiveDate` re-pins to the current LA date on
  // each log change so a session open across local midnight rolls forward; a
  // past selection stays exactly as chosen.
  let onToday = true;
  let pinnedDate = todayLocalDate();
  // `todayStr` = the live LA calendar date. F5: it must advance across local
  // midnight even in a long-idle session, so we refresh it on a modest interval
  // while visible + on focus/visibilitychange (cheap, only matters in 'today'
  // mode — a pinned past date ignores todayStr). $logState also nudges it.
  let todayStr = todayLocalDate();
  function refreshToday() {
    const d = todayLocalDate();
    if (d !== todayStr) todayStr = d;
  }
  $: $logState, refreshToday();
  $: effectiveDate = onToday ? todayStr : pinnedDate;
  $: maxDate = todayStr; // no far-future logging
  $: selectedWeekday = weekdayFromJsDay(
    new Date(effectiveDate + "T00:00:00").getDay(),
  );

  // F3 session persistence is now in the SHARED lib/session.js (W1) so phone +
  // watch resolve identically. Today holds the live in-memory copy + hydrates
  // from / saves to the shared store. The displayed session = persisted
  // selection ∪ any exercise with logged sets for that date.
  let startedFrom = null; // routine_id | "custom" | null (not started yet)
  let selection = []; // explicitly chosen exercise_ids, in display order
  let skipped = new Set(); // session-local skipped exercise_ids
  let picking = false;
  let swapForId = null;
  let hydratedDate = null;

  // Hydrate whenever the selected date changes (mount + date pick + tab return).
  $: hydrate(effectiveDate);
  function hydrate(date) {
    if (hydratedDate === date) return;
    hydratedDate = date;
    const p = loadSession(date); // shared loader (sanitizes/dedups selection)
    if (p) {
      startedFrom = p.started;
      selection = p.selection;
      skipped = new Set(p.skipped);
    } else {
      startedFrom = null;
      selection = [];
      skipped = new Set();
    }
  }

  function persist() {
    if (!hydratedDate) return;
    saveSession(hydratedDate, { started: startedFrom, selection, skipped });
  }

  $: folded = $logState.folded;
  $: syncedIds = $logState.syncedIds;

  // W1: resolve the displayed session through the ONE shared resolver (same path
  // the watch uses). Pass Today's LIVE in-memory session as `current` so the list
  // updates instantly on add/remove/swap. "Committed" = the user has STARTED a
  // session (`startedFrom != null`); until then `current` is null so the resolver
  // surfaces the day's default routine as base (read-only — not auto-persisted).
  $: current =
    startedFrom !== null ? { started: startedFrom, selection } : null;
  $: resolved = resolveSessionExercises(folded, effectiveDate, current);
  $: sessionExerciseIds = resolved.exerciseIds;
  // Start-card shows until a session is actually committed (restores 2b flow);
  // a default-routine fallback day is NOT treated as in-progress.
  $: hasSession = resolved.hasCommittedSession;

  // The SELECTED day's default routine (shared resolver; do not auto-commit).
  $: defaultRoutineId = defaultRoutineIdForDate(effectiveDate);
  $: defaultRoutine = defaultRoutineId ? $routinesMap[defaultRoutineId] : null;

  function startRoutine(routineId) {
    if (!$routinesMap[routineId]) return;
    // Shared resolver: active, non-archived, deduped routine exercises (W1).
    selection = selectionFromRoutine(routineId);
    startedFrom = routineId;
    skipped = new Set();
    picking = false;
    persist();
  }
  function startCustom() {
    selection = [];
    startedFrom = "custom";
    skipped = new Set();
    picking = false;
    persist();
  }

  function addExerciseToSession(id) {
    if (!selection.includes(id)) selection = [...selection, id];
    if (startedFrom === null) startedFrom = "custom";
    swapForId = null;
    picking = false;
    persist();
  }
  function swapExercise(oldId, newId) {
    if (oldId === newId) {
      swapForId = null;
      return;
    }
    // Session-local replace, keeping position; never emits a routine event.
    // Guarantee the list stays UNIQUE: if newId is already present elsewhere
    // (in the selection or logged-only), replacing oldId with it would create a
    // duplicate keyed row. Drop oldId and keep the single existing newId.
    const alreadyHas = sessionExerciseIds.includes(newId);
    if (alreadyHas) {
      selection = selection.filter((x) => x !== oldId);
    } else if (selection.includes(oldId)) {
      selection = selection.map((x) => (x === oldId ? newId : x));
    } else {
      // oldId was logged-only (not in selection) -> add the swap target.
      selection = [...selection, newId];
    }
    skipped.delete(oldId);
    skipped = skipped;
    swapForId = null;
    persist();
  }
  function closePicker() {
    picking = false;
    swapForId = null;
  }
  function toggleSkip(id) {
    if (skipped.has(id)) skipped.delete(id);
    else skipped.add(id);
    skipped = skipped;
    persist();
  }

  function pickDate(e) {
    const v = e.currentTarget.value;
    if (!v) return;
    if (v >= todayStr) {
      onToday = true; // selecting today (or clamped) follows the live date
    } else {
      onToday = false;
      pinnedDate = v;
    }
    // hydrate() runs reactively when effectiveDate changes.
  }

  // Bodyweight capture + staleness (assisted lifts need a snapshot).
  let bwInput = "";
  let showBwCapture = false;
  $: bw = $latestBodyweight; // {value(base), date} | null
  $: bwStaleDays = bw ? daysSince(bw.date) : null;
  async function saveBodyweight() {
    const v = parseFloat(bwInput);
    if (!isFinite(v) || v <= 0) return;
    await queue(buildMeasurementEvent(v));
    bwInput = "";
    showBwCapture = false;
  }

  function exerciseById(id) {
    return $libraryMap[id] || null;
  }

  // "Recently logged" exercise_ids, newest session first (U5). Derived from the
  // log fold: each exercise's most recent working session_date.
  $: recentIds = (() => {
    const sets = $logState.folded.sets || {};
    return Object.keys(sets)
      .map((id) => {
        const dates = Object.keys(sets[id]).sort();
        return { id, last: dates[dates.length - 1] || "" };
      })
      .filter((x) => x.last)
      .sort((a, b) => b.last.localeCompare(a.last))
      .map((x) => x.id);
  })();

  // Swap picker candidates: recents first, then same-muscle, then the rest (U5).
  // Exclude exercises already in THIS session (besides the one being swapped) so
  // a swap can never create a duplicate row.
  function swapCandidates(oldId) {
    const ex = exerciseById(oldId);
    const inSession = new Set(sessionExerciseIds);
    const list = $activeExercises.filter(
      (e) => e.exercise_id !== oldId && !inSession.has(e.exercise_id),
    );
    const seen = new Set();
    const out = [];
    const push = (e) => {
      if (e && !seen.has(e.exercise_id)) {
        seen.add(e.exercise_id);
        out.push(e);
      }
    };
    // recents (most-recent first)
    for (const id of recentIds) push(list.find((e) => e.exercise_id === id));
    // same muscle group
    if (ex) for (const e of list) if (e.muscle_group === ex.muscle_group) push(e);
    // everything else
    for (const e of list) push(e);
    return out;
  }

  // U1: auto-scroll the active card into view (on session load + after a set is
  // logged). A Svelte action records each card's DOM node by exercise_id.
  let cardNodes = {};
  function cardNode(node, id) {
    cardNodes[id] = node;
    return {
      update(newId) {
        cardNodes[newId] = node;
      },
      destroy() {
        if (cardNodes[id] === node) delete cardNodes[id];
      },
    };
  }
  function firstActiveId() {
    return sessionExerciseIds.find((id) => {
      if (skipped.has(id)) return false;
      const ex = exerciseById(id);
      return ex && ex.type !== "cardio";
    });
  }
  async function scrollToActive(preferId) {
    await tick();
    const id = preferId || firstActiveId();
    const node = id && cardNodes[id];
    if (node && node.scrollIntoView) {
      node.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }
  // After logging a set, keep the just-logged exercise in view (the rest-timer
  // slot + next-set draft are there). Real-device scroll behavior needs phone QA.
  function onSetLogged(exId) {
    scrollToActive(exId);
  }
  // On session start, bring the first active card into view (once per start).
  let scrolledForStart = null;
  $: if (
    startedFrom &&
    startedFrom !== scrolledForStart &&
    sessionExerciseIds.length
  ) {
    scrolledForStart = startedFrom;
    scrollToActive();
  }

  // F5 live-today ticker. 60s while visible + on focus/visibilitychange so the
  // date rolls past local midnight without a manual reload. Cleaned up on destroy.
  let todayTimer;
  const onVisible = () => {
    if (typeof document === "undefined" || !document.hidden) refreshToday();
  };
  onMount(() => {
    todayTimer = setInterval(refreshToday, 60_000);
    window.addEventListener("focus", refreshToday);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisible);
    }
  });
  onDestroy(() => {
    clearInterval(todayTimer);
    window.removeEventListener("focus", refreshToday);
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisible);
    }
  });
</script>

<div class="screen">
  <!-- F5: date selector. Drives effectiveDate (prefill + logged session_date). -->
  <div class="date-bar">
    <label class="date-label">
      Date
      <input
        type="date"
        value={effectiveDate}
        max={maxDate}
        on:change={pickDate}
      />
    </label>
    {#if effectiveDate !== todayStr}
      <button class="link" on:click={() => (onToday = true)}>Jump to today</button>
    {/if}
  </div>

  {#if !hasSession}
    <!-- Session start / routine resolution -->
    <section class="start">
      <h2>{effectiveDate === todayStr ? "Today" : effectiveDate}</h2>
      {#if defaultRoutine}
        <div class="default-card">
          <div>
            <span class="r-name">{defaultRoutine.name}</span>
            <span class="muted small">{WEEKDAYS[selectedWeekday]}’s routine</span>
          </div>
          <button class="primary" on:click={() => startRoutine(defaultRoutineId)}>
            Start
          </button>
        </div>
      {:else}
        <p class="muted">No routine assigned to {WEEKDAYS[selectedWeekday]}.</p>
      {/if}
      <div class="start-actions">
        <button class="secondary" on:click={() => (picking = true)}>
          Start a different routine
        </button>
        <button class="secondary" on:click={startCustom}>Custom day</button>
      </div>
    </section>
  {:else}
    <header class="day-head">
      <div>
        <h2>{effectiveDate === todayStr ? "Today" : effectiveDate}</h2>
        <span class="muted small">
          {startedFrom === "custom"
            ? "Custom day"
            : startedFrom
              ? $routinesMap[startedFrom]?.name || "Workout"
              : "Logged"} · {effectiveDate}
        </span>
      </div>
      <button class="link" on:click={() => (picking = true)}>Change</button>
    </header>

    <!-- Bodyweight nudge (soft, never blocks) -->
    {#if !bw}
      <button class="bw-nudge" on:click={() => (showBwCapture = true)}>
        Set your bodyweight (needed for assisted lifts) →
      </button>
    {:else if bwStaleDays > 30}
      <button class="bw-nudge" on:click={() => (showBwCapture = true)}>
        Bodyweight is {bwStaleDays} days old — update?
      </button>
    {/if}

    {#if showBwCapture}
      <div class="bw-capture">
        <label>
          Bodyweight ({$displayUnit})
          <input type="number" inputmode="decimal" step="0.5" bind:value={bwInput} />
        </label>
        <button class="primary" on:click={saveBodyweight}>Save</button>
        <button class="link" on:click={() => (showBwCapture = false)}>Cancel</button>
      </div>
    {/if}

    {#each sessionExerciseIds as exId (exId)}
      {@const ex = exerciseById(exId)}
      {#if ex}
        <div use:cardNode={exId}>
          <ExerciseCard
            {ex}
            {effectiveDate}
            {folded}
            {syncedIds}
            outboxList={$outbox}
            rejectedIds={$rejectedIds}
            bodyweightFull={freshestBodyweightFull()}
            skipped={skipped.has(exId)}
            on:skip={() => toggleSkip(exId)}
            on:swap={() => (swapForId = exId)}
            on:setlogged={() => onSetLogged(exId)}
          />
        </div>
      {/if}
    {/each}

    <button class="secondary add-ex" on:click={() => (picking = "add")}>
      + Add exercise
    </button>
  {/if}

  <!-- Routine / custom / add / swap picker overlay -->
  {#if picking || swapForId}
    <!-- Backdrop: tap outside or press Escape to close. -->
    <div
      class="overlay"
      role="presentation"
      on:click|self={closePicker}
      on:keydown={(e) => e.key === "Escape" && closePicker()}
    >
      <div class="sheet" role="dialog" aria-modal="true" tabindex="-1">
        {#if swapForId}
          <h3>Swap exercise</h3>
          <div class="pick-list">
            {#each swapCandidates(swapForId) as e (e.exercise_id)}
              <button class="pick-row" on:click={() => swapExercise(swapForId, e.exercise_id)}>
                <span>{e.name}</span><span class="muted small">{e.muscle_group}</span>
              </button>
            {/each}
          </div>
        {:else if picking === "add"}
          <h3>Add exercise</h3>
          <div class="pick-list">
            {#each $activeExercises.filter((e) => !sessionExerciseIds.includes(e.exercise_id)) as e (e.exercise_id)}
              <button class="pick-row" on:click={() => addExerciseToSession(e.exercise_id)}>
                <span>{e.name}</span><span class="muted small">{e.muscle_group}</span>
              </button>
            {/each}
          </div>
        {:else}
          <h3>Start a routine</h3>
          <div class="pick-list">
            {#each $activeRoutines as r (r.routine_id)}
              <button class="pick-row" on:click={() => startRoutine(r.routine_id)}>
                <span>{r.name}</span>
                <span class="muted small">{(r.ordered_exercise_ids || []).length} exercises</span>
              </button>
            {/each}
            <button class="pick-row custom" on:click={startCustom}>
              <span>Custom day</span><span class="muted small">pick ad hoc</span>
            </button>
          </div>
        {/if}
        <button class="link close" on:click={closePicker}>
          Close
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  .screen {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .date-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  .date-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8rem;
    color: var(--muted);
  }
  .date-label input {
    min-height: 44px;
    padding: 0 0.6rem;
    border-radius: 10px;
    border: 1px solid var(--surface-2);
    background: var(--bg);
    color: var(--text);
    font-size: 0.95rem;
    font-family: inherit;
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
  .start {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .default-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    background: var(--surface);
    border: 1px solid var(--surface-2);
    border-radius: 12px;
    padding: 0.9rem 1rem;
  }
  .r-name {
    font-weight: 600;
    display: block;
  }
  .start-actions {
    display: flex;
    gap: 0.6rem;
    flex-wrap: wrap;
  }
  .day-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .primary,
  .secondary {
    min-height: 44px;
    padding: 0 1.1rem;
    border-radius: 10px;
    font-weight: 600;
    cursor: pointer;
    border: 0;
    font-family: inherit;
    font-size: 0.95rem;
  }
  .primary {
    background: var(--accent);
    color: #04212e;
  }
  .secondary {
    background: transparent;
    color: var(--accent);
    border: 1px solid var(--surface-2);
  }
  .add-ex {
    align-self: flex-start;
  }
  .link {
    border: 0;
    background: transparent;
    color: var(--accent);
    cursor: pointer;
    font-family: inherit;
    font-size: 0.85rem;
    min-height: 40px;
  }
  .bw-nudge {
    border: 1px solid var(--warn);
    background: color-mix(in srgb, var(--warn) 12%, transparent);
    color: var(--warn);
    border-radius: 10px;
    padding: 0.6rem 0.8rem;
    text-align: left;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.85rem;
  }
  .bw-capture {
    display: flex;
    align-items: flex-end;
    gap: 0.6rem;
    flex-wrap: wrap;
    background: var(--surface);
    border: 1px solid var(--surface-2);
    border-radius: 12px;
    padding: 0.75rem;
  }
  .bw-capture label {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    font-size: 0.8rem;
    color: var(--muted);
  }
  .bw-capture input {
    min-height: 48px;
    min-width: 8rem;
    padding: 0 0.7rem;
    border-radius: 10px;
    border: 1px solid var(--surface-2);
    background: var(--bg);
    color: var(--text);
    font-size: 1rem;
  }
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: flex-end;
    justify-content: center;
    z-index: 50;
  }
  .sheet {
    width: 100%;
    max-width: 640px;
    max-height: 80vh;
    overflow-y: auto;
    background: var(--surface);
    border-radius: 16px 16px 0 0;
    padding: 1rem 1rem 1.5rem;
  }
  @media (min-width: 640px) {
    .overlay {
      align-items: center;
    }
    .sheet {
      border-radius: 16px;
    }
  }
  .sheet h3 {
    margin: 0 0 0.75rem;
  }
  .pick-list {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .pick-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    min-height: 52px;
    padding: 0 0.9rem;
    border: 1px solid var(--surface-2);
    border-radius: 10px;
    background: var(--bg);
    color: var(--text);
    cursor: pointer;
    font-family: inherit;
    font-size: 0.95rem;
    text-align: left;
  }
  .pick-row.custom {
    border-style: dashed;
    border-color: var(--accent);
    color: var(--accent);
  }
  .close {
    margin-top: 0.75rem;
  }
</style>
