<script>
  // Watch-friendly single-set entry (CONTRACT-phase5b). A THIN presentational
  // shell over the shared logging core — no reimplemented set-construction or
  // projection. One exercise on screen, huge targets, big steppers, one Confirm.
  import { onMount, onDestroy } from "svelte";
  import { startSync, stopSync, queue, syncState, syncStatus } from "./lib/sync.js";
  import { startProjections, stopProjections, libraryMap } from "./lib/library.js";
  import {
    startLogging,
    stopLogging,
    logState,
    todayLocalDate,
    nextSetToLog,
    lastSessionFor,
    buildSetEvent,
    freshestBodyweightFull,
  } from "./lib/logging.js";
  import { resolveSessionExercises } from "./lib/session.js";
  import { displayUnit, toDisplay, toBase } from "./lib/units.js";

  // Live LA date for the session. W5: refresh on $logState AND on a focus/
  // visibilitychange/interval ticker, so an idle watch page across local
  // midnight logs to the correct date (mirrors the phone Today).
  let today = todayLocalDate();
  function refreshToday() {
    const d = todayLocalDate();
    if (d !== today) today = d;
  }
  $: $logState, refreshToday();

  let todayTimer;
  const onVisible = () => {
    if (typeof document === "undefined" || !document.hidden) refreshToday();
  };
  onMount(() => {
    startSync();
    startProjections();
    startLogging();
    todayTimer = setInterval(refreshToday, 60_000);
    window.addEventListener("focus", refreshToday);
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", onVisible);
  });
  onDestroy(() => {
    stopSync();
    stopProjections();
    stopLogging();
    clearInterval(todayTimer);
    window.removeEventListener("focus", refreshToday);
    if (typeof document !== "undefined")
      document.removeEventListener("visibilitychange", onVisible);
  });

  $: folded = $logState.folded;
  // Today's session exercise order (shared resolution: persisted selection ∪
  // logged ∪ the day's default routine when nothing started yet).
  $: session = resolveSessionExercises(folded, today);
  $: exerciseIds = session.exerciseIds;

  let idx = 0; // current exercise index within the session
  $: if (idx >= exerciseIds.length) idx = Math.max(0, exerciseIds.length - 1);
  $: currentId = exerciseIds[idx] || null;
  $: ex = currentId ? $libraryMap[currentId] : null;
  $: isCardio = ex && ex.type === "cardio";
  $: usesBw = ex && !!ex.uses_bodyweight;

  // Prefill via the SHARED live-store APIs (W4) — same entrypoints the phone
  // uses. They read the live logState internally; we reference `$logState` +
  // `today` so the reactive statement recomputes when the log or date changes.
  $: prefill = ex && $logState ? nextSetToLog(ex.exercise_id, today) : null;
  $: last = ex && $logState ? lastSessionFor(ex.exercise_id, today) : null;
  $: stepDisplay = ex && ex.increment != null ? Math.max(0.5, toDisplay(ex.increment)) : 5;

  // Draft canonical (base lb) + display, re-seeded when the set_index advances.
  let lastSeededKey = null;
  let weightBase = null; // lb (weighted) — for usesBw this stays null
  let addedBase = null; // assist/added magnitude in lb (sign applied at log)
  let reps = "";
  let assistMode = false;
  $: seedKey = ex ? `${ex.exercise_id}:${prefill ? prefill.set_index : 0}` : null;
  $: if (ex && seedKey !== lastSeededKey) {
    lastSeededKey = seedKey;
    if (usesBw) {
      weightBase = null;
      addedBase = prefill && prefill.added_weight != null ? Math.abs(prefill.added_weight) : null;
      assistMode = (prefill && prefill.added_weight != null && prefill.added_weight < 0) || /assist/i.test(ex.name);
    } else {
      weightBase = prefill ? prefill.weight : null;
      addedBase = null;
    }
    reps = prefill && prefill.reps != null ? prefill.reps : "";
  }

  // Display values derived from base (rounded for readability).
  $: weightDisplay = weightBase == null ? "" : toDisplay(weightBase);
  $: addedDisplay = addedBase == null ? "" : toDisplay(addedBase);

  function stepWeight(d) {
    const cur = weightBase == null ? 0 : toDisplay(weightBase);
    const next = Math.max(0, +(cur + d * stepDisplay).toFixed(2));
    weightBase = toBase(next);
  }
  function stepAdded(d) {
    const cur = addedBase == null ? 0 : toDisplay(addedBase);
    const next = Math.max(0, +(cur + d * stepDisplay).toFixed(2));
    addedBase = toBase(next);
  }
  function stepReps(d) {
    reps = Math.max(0, (parseInt(reps) || 0) + d);
  }

  // W3 + latch-stick fix: index-advance guard tied to (exercise_id + set_index).
  // `confirming` releases when the SAME exercise's prefill.set_index advances; if
  // the user navigates to a different exercise before that, the guard is for a
  // stale exercise and is cleared (a pending latch never blocks logging the new
  // one). prev/next also explicitly reset it.
  let confirming = false;
  let confirmingExId = null;
  let confirmingFromIndex = -1;
  $: if (confirming) {
    if (!ex || ex.exercise_id !== confirmingExId) {
      confirming = false; // navigated away from the confirmed exercise -> clear
    } else if (prefill && prefill.set_index > confirmingFromIndex) {
      confirming = false; // the fold advanced past the confirmed set -> done
    }
  }
  function clearConfirmLatch() {
    confirming = false;
    confirmingExId = null;
    confirmingFromIndex = -1;
  }

  async function confirmSet() {
    if (!ex || confirming || !prefill) return;
    confirming = true;
    confirmingExId = ex.exercise_id;
    confirmingFromIndex = prefill.set_index;
    const bw = usesBw ? freshestBodyweightFull() : null;
    const signedAdded = usesBw
      ? addedBase == null
        ? 0
        : assistMode
          ? -addedBase
          : addedBase
      : undefined;
    const ev = buildSetEvent({
      exercise_id: ex.exercise_id,
      session_date: today, // single source: same date drives prefill + the event
      set_index: prefill.set_index,
      warmup: false,
      weightBase: usesBw ? null : weightBase,
      reps,
      usesBodyweight: usesBw,
      addedWeightBase: signedAdded,
      bodyweightSnapshot: usesBw ? (bw ? bw.value : null) : undefined,
      bodyweightSnapshotDate: usesBw ? (bw ? bw.date : null) : undefined,
    });
    try {
      await queue(ev);
    } catch (e) {
      clearConfirmLatch(); // allow retry on failure
      throw e;
    }
    // confirming releases when the fold advances prefill.set_index (the $: guard).
  }

  // Navigating exercises always clears any pending confirm latch so logging the
  // new exercise is never blocked by an unreleased guard.
  function prev() {
    if (idx > 0) {
      idx -= 1;
      clearConfirmLatch();
    }
  }
  function next() {
    if (idx < exerciseIds.length - 1) {
      idx += 1;
      clearConfirmLatch();
    }
  }

  // "last 100×8" hint from the shared last-session projection.
  function lastHint() {
    if (!last || !last.sets.length) return null;
    const top = last.sets[last.sets.length - 1];
    if (usesBw) {
      const a = top.added_weight ?? 0;
      const tag = a < 0 ? `assist ${toDisplay(Math.abs(a))}` : a > 0 ? `+${toDisplay(a)}` : "BW";
      return `${tag}×${top.reps}`;
    }
    return top.weight == null ? `BW×${top.reps}` : `${toDisplay(top.weight)}×${top.reps}`;
  }
  // count of sets already logged today for the current exercise.
  $: loggedToday = ex && folded.sets[ex.exercise_id] && folded.sets[ex.exercise_id][today]
    ? Object.keys(folded.sets[ex.exercise_id][today]).length
    : 0;
</script>

<div class="watch">
  {#if !exerciseIds.length}
    <div class="empty">
      <p>No session today.</p>
      <p class="hint">Start one on your phone.</p>
    </div>
  {:else if !ex}
    <div class="empty"><p>…</p></div>
  {:else}
    <header class="wh">
      <button class="navbtn" on:click={prev} disabled={idx === 0} aria-label="Previous exercise">‹</button>
      <div class="pos">{idx + 1}/{exerciseIds.length}</div>
      <button class="navbtn" on:click={next} disabled={idx === exerciseIds.length - 1} aria-label="Next exercise">›</button>
    </header>

    <div class="name">{usesBw && assistMode ? `Assisted ${ex.name}` : ex.name}</div>

    {#if isCardio}
      <div class="cardio">Cardio — use phone</div>
    {:else}
      <div class="sub">
        set {prefill.set_index + 1}{#if loggedToday} · {loggedToday} done{/if}
        {#if lastHint()} · last {lastHint()}{/if}
      </div>

      {#if usesBw}
        <div class="modes">
          <button class="mode" class:on={assistMode} on:click={() => (assistMode = true)}>assist</button>
          <button class="mode" class:on={!assistMode} on:click={() => (assistMode = false)}>added</button>
        </div>
        <div class="stepper">
          <button class="step" on:click={() => stepAdded(-1)} aria-label="decrease">−</button>
          <span class="val">{addedDisplay === "" ? "0" : addedDisplay}<small>{$displayUnit}</small></span>
          <button class="step" on:click={() => stepAdded(1)} aria-label="increase">+</button>
        </div>
      {:else}
        <div class="stepper">
          <button class="step" on:click={() => stepWeight(-1)} aria-label="decrease weight">−</button>
          <span class="val">{weightDisplay === "" ? "0" : weightDisplay}<small>{$displayUnit}</small></span>
          <button class="step" on:click={() => stepWeight(1)} aria-label="increase weight">+</button>
        </div>
      {/if}

      <div class="stepper">
        <button class="step" on:click={() => stepReps(-1)} aria-label="decrease reps">−</button>
        <span class="val">{reps === "" ? "0" : reps}<small>reps</small></span>
        <button class="step" on:click={() => stepReps(1)} aria-label="increase reps">+</button>
      </div>

      <button class="confirm" on:click={confirmSet} disabled={confirming}>
        {confirming ? "…" : "LOG"}
      </button>
    {/if}

    <div class="status" data-state={$syncStatus.kind} aria-hidden="true"></div>
  {/if}
</div>

<style>
  /* Watch-first: dark, big, single-column, generous tap targets. Sized off vmin
     so it scales on round/square watch viewports down to ~tiny px. */
  .watch {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    justify-content: center;
    gap: 0.5rem;
    padding: 0.6rem;
    text-align: center;
    background: var(--bg);
    color: var(--text);
    box-sizing: border-box;
  }
  .wh {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .navbtn {
    min-width: 2.4rem;
    min-height: 2.4rem;
    border: 0;
    border-radius: 999px;
    background: var(--surface);
    color: var(--accent);
    font-size: 1.6rem;
    line-height: 1;
    cursor: pointer;
    font-family: inherit;
  }
  .navbtn:disabled {
    opacity: 0.3;
  }
  .pos {
    font-size: 0.85rem;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .name {
    font-size: 1.1rem;
    font-weight: 700;
    line-height: 1.1;
    /* clamp long names to keep the layout single-screen */
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .sub {
    font-size: 0.78rem;
    color: var(--muted);
  }
  .modes {
    display: flex;
    gap: 0.3rem;
    justify-content: center;
  }
  .mode {
    flex: 1;
    min-height: 2rem;
    border: 1px solid var(--surface-2);
    border-radius: 8px;
    background: var(--bg);
    color: var(--muted);
    font-size: 0.8rem;
    cursor: pointer;
    font-family: inherit;
  }
  .mode.on {
    background: var(--accent);
    color: var(--bg);
    border-color: var(--accent);
  }
  .stepper {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.4rem;
  }
  .step {
    width: 3rem;
    height: 3rem;
    flex: 0 0 auto;
    border: 0;
    border-radius: 999px;
    background: var(--surface);
    color: var(--text);
    font-size: 2rem;
    line-height: 1;
    cursor: pointer;
    font-family: inherit;
  }
  .val {
    flex: 1;
    font-size: 1.8rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .val small {
    font-size: 0.7rem;
    color: var(--muted);
    margin-left: 0.2rem;
  }
  .confirm {
    min-height: 3.2rem;
    border: 0;
    border-radius: 12px;
    background: var(--accent);
    color: var(--bg);
    font-size: 1.3rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    cursor: pointer;
    font-family: inherit;
  }
  .confirm:disabled {
    opacity: 0.6;
  }
  .cardio {
    font-size: 1rem;
    color: var(--muted);
    padding: 1.5rem 0;
  }
  .empty {
    text-align: center;
    color: var(--muted);
  }
  .empty .hint {
    font-size: 0.8rem;
  }
  .status {
    height: 4px;
    border-radius: 2px;
    background: var(--ok);
  }
  .status[data-state="offline"],
  .status[data-state="pending"] {
    background: var(--warn);
  }
  .status[data-state="error"] {
    background: var(--danger);
  }
  .status[data-state="syncing"] {
    background: var(--accent);
  }
</style>
