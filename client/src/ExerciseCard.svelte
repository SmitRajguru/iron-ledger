<script>
  // One exercise's card on the Today screen. Renders logged sets (with per-set
  // save state) + a draft entry row prefilled by nextSetToLog. All logging goes
  // through the shared logging.js builders + the queue()/sync pipe.
  import { createEventDispatcher } from "svelte";
  import { queue, makeEvent } from "./lib/sync.js";
  import { buildExercisePayload } from "./lib/library.js";
  import {
    displayUnit,
    toDisplay,
    toBase,
    distanceUnit,
    setDistanceUnit,
    distanceToMeters,
    formatDistance,
    formatDuration,
  } from "./lib/units.js";
  import {
    nextSetFromFold,
    lastSessionFromFold,
    buildSetEvent,
    buildCardioSetEvent,
    buildWarmupToggleEvent,
    buildSetDeleteEvent,
    buildSetRetryEvent,
    saveStateFor,
    daysSince,
  } from "./lib/logging.js";
  import { progressionSuggestion, prsFor, isSessionPR } from "./lib/analytics.js";
  import {
    restTimer,
    startRest,
    stepUp,
    stepDown,
    skipRest,
    restSecondsFor,
  } from "./lib/restTimer.js";

  const dispatch = createEventDispatcher();

  export let ex; // exercise definition
  export let effectiveDate; // F5/H1: the single session date (from Today)
  export let folded; // logging fold
  export let syncedIds; // Set of synced event ids
  export let outboxList; // reactive outbox array
  export let rejectedIds = new Set(); // dead-lettered event ids (U2)
  export let bodyweightFull = null; // {value(base), date} latest bodyweight, or null
  export let skipped = false;
  // Derived value + date for the assisted snapshot (M1: date enables a real
  // staleness check downstream).
  $: bodyweight = bodyweightFull ? bodyweightFull.value : null;
  $: bodyweightDate = bodyweightFull ? bodyweightFull.date : null;

  // `effectiveDate` (passed from Today) is the ONE session date driving both the
  // prefill/index lookup AND the logged event's session_date — they can never
  // diverge. Today re-pins it to the live LA date while on "today" (H1 midnight)
  // and to the selected date for a past day (F5).

  $: isCardio = ex.type === "cardio";
  $: usesBw = !!ex.uses_bodyweight;
  // F4: stepDisplay reacts to $displayUnit (referencing it makes this reactive).
  $: stepDisplay =
    ($displayUnit, ex.increment == null ? 5 : Math.max(0.5, toDisplay(ex.increment)));

  // Today's logged sets (ordered), from the fold.
  $: byDate = folded.sets[ex.exercise_id] || {};
  $: todaySets = Object.values(byDate[effectiveDate] || {}).sort(
    (a, b) => a.set_index - b.set_index,
  );

  // Last session (working sets only) for the "Last: …" line. F4: depends on
  // $displayUnit so it re-converts immediately on a lb/kg toggle.
  $: last = lastSessionFromFold(folded, ex.exercise_id, effectiveDate);
  $: lastText =
    ($displayUnit,
    last
      ? last.sets.map((s) => `${displayLoad(s)}×${s.reps ?? "—"}`).join(", ")
      : null);
  // U4: human recency ("today" / "yesterday" / "N days ago") instead of ISO.
  $: lastRecency = last ? recencyText(daysSince(last.session_date)) : null;
  function recencyText(d) {
    if (d <= 0) return "today";
    if (d === 1) return "yesterday";
    return `${d} days ago`;
  }

  // Progression hint (Phase 3 §5): muted, advisory, NEVER auto-changes prefill.
  // Goes quiet once the first WORKING set is logged this session. `delta` is in
  // base lb -> shown in the display unit. add_reps has null delta (hold weight).
  $: hasWorkingToday = todaySets.some((s) => !s.warmup);
  $: suggestion =
    hasWorkingToday ? null : progressionSuggestion(folded, ex, effectiveDate);
  $: suggestionText = suggestion ? hintText(suggestion) : null;
  function hintText(sug) {
    if (sug.kind === "add_weight") {
      const incDisp = toDisplay(Math.abs(sug.delta)); // L1: real increment in display unit
      return `hit top reps — try +${incDisp} ${$displayUnit} → ${sug.targetReps} reps`;
    }
    if (sug.kind === "reduce_assist") {
      const incDisp = toDisplay(Math.abs(sug.delta));
      return `hit top reps — try ${incDisp} ${$displayUnit} less assist → ${sug.targetReps} reps`;
    }
    // first_time + add_reps carry their own message from analytics.
    return sug.message;
  }
  // One-tap apply: set the draft row to the suggestion (never auto-applied).
  function applySuggestion() {
    if (!suggestion) return;
    if (suggestion.kind === "add_weight") {
      // base weight = last top working set load + increment.
      const lastTop = last ? last.sets[last.sets.length - 1] : null;
      const baseLoad = lastTop ? lastTop.weight ?? 0 : 0;
      draftWeightBase = baseLoad + suggestion.delta;
      draftReps = suggestion.targetReps;
      weightFocused = false;
      addedFocused = false;
      syncDisplayFromBase();
    } else if (suggestion.kind === "reduce_assist") {
      // less assist => added_weight moves toward 0 by increment (magnitude down).
      const lastTop = last ? last.sets[last.sets.length - 1] : null;
      const prevAdded = lastTop ? lastTop.added_weight ?? 0 : 0; // negative
      const nextAdded = prevAdded - suggestion.delta; // delta is -inc -> +inc toward 0
      assistMode = nextAdded < 0;
      draftAddedBase = Math.abs(nextAdded);
      draftReps = suggestion.targetReps;
      addedFocused = false;
      syncDisplayFromBase();
    } else if (suggestion.kind === "add_reps") {
      const lastTop = last ? last.sets[last.sets.length - 1] : null;
      draftReps = (lastTop && lastTop.reps != null ? lastTop.reps : 0) + 1;
    } else if (suggestion.kind === "first_time") {
      draftReps = suggestion.targetReps;
    }
  }
  // L2: one-tap "mute" — silence the progression hint for this exercise from
  // Today (emits exercise_updated with hold_progression:true).
  async function holdFromCard() {
    const payload = buildExercisePayload({ ...ex, hold_progression: true });
    const ev = makeEvent("exercise_updated", payload);
    if (ex.__src_id) ev.voids = ex.__src_id;
    await queue(ev);
  }

  // Draft entry row prefilled by the pure next-set function. F4: the field's
  // CANONICAL value lives in base_unit (lb) at full precision (`draft*Base`);
  // the shown string (`draft*`) is a 0.5-rounded display derived from it. A unit
  // toggle only re-derives the display (no base change -> no drift); only a real
  // user EDIT recomputes base from the typed display value. Untouched values
  // round-trip exactly.
  let draftWeightBase = null; // lb | null
  let draftAddedBase = null; // lb magnitude | null (sign handled at confirm)
  let draftWeight = ""; // display string
  let draftReps = "";
  let draftAdded = ""; // display string (magnitude)
  let draftWarmup = false;
  let lastPrefillIndex = -1;
  $: prefill = nextSetFromFold(folded, ex.exercise_id, effectiveDate);
  // Re-seed the draft only when the next set_index changes (don't clobber typing).
  $: if (prefill.set_index !== lastPrefillIndex) {
    lastPrefillIndex = prefill.set_index;
    draftWeightBase = prefill.weight == null ? null : prefill.weight;
    draftAddedBase =
      prefill.added_weight == null ? null : Math.abs(prefill.added_weight);
    draftReps = prefill.reps == null ? "" : prefill.reps;
    draftWarmup = false;
    syncDisplayFromBase();
  }

  // Per-field focus, so a unit toggle doesn't clobber a field the user is
  // actively typing in (residual #2). A focused field is owned by the user; its
  // base recomputes from their input on the next keystroke under the current unit.
  let weightFocused = false;
  let addedFocused = false;

  // Derive the display strings from the canonical base values (display-only 0.5
  // rounding). Skips a focused field so it never overwrites in-progress typing.
  // Called on (re)seed and on unit toggle — never mutates base.
  function syncDisplayFromBase() {
    if (!weightFocused) draftWeight = draftWeightBase == null ? "" : toDisplay(draftWeightBase);
    if (!addedFocused) draftAdded = draftAddedBase == null ? "" : toDisplay(draftAddedBase);
  }
  // User edited a field: recompute the canonical base from the typed display
  // value (full precision, no rounding). Empty -> null.
  function onWeightInput() {
    draftWeightBase =
      draftWeight === "" || draftWeight == null ? null : toBase(Number(draftWeight));
  }
  function onAddedInput() {
    draftAddedBase =
      draftAdded === "" || draftAdded == null ? null : toBase(Number(draftAdded));
  }
  // On blur, re-derive the DISPLAY from the canonical base under the CURRENT unit.
  // Fixes the stale-text case: if a unit toggle happened while the field was
  // focused (display skipped to avoid clobbering), an edit-free blur would
  // otherwise leave old-unit text under the new label. Base is unchanged (edits
  // already recomputed it via on:input first), so this is display-only.
  function onWeightBlur() {
    weightFocused = false;
    draftWeight = draftWeightBase == null ? "" : toDisplay(draftWeightBase);
  }
  function onAddedBlur() {
    addedFocused = false;
    draftAdded = draftAddedBase == null ? "" : toDisplay(draftAddedBase);
  }

  // F4: on a display-unit toggle, re-derive the shown strings from the unchanged
  // canonical base — but NOT for a focused field (the user owns it). Stored data
  // (logged on confirm) uses base -> a toggled-but-unedited value logs
  // byte-identical to its original precision.
  let prevUnit = $displayUnit;
  $: if ($displayUnit !== prevUnit) {
    prevUnit = $displayUnit;
    syncDisplayFromBase();
  }

  // --- assisted/weighted-bodyweight sign handling (hide the math) ---
  // For assisted exercises the user thinks in "assist N" (stepper reduces it);
  // we store added_weight negative. We detect "assisted" vs "weighted+" from the
  // exercise name heuristically OR default to weighted-added. To keep it simple
  // and explicit, uses_bodyweight exercises expose a mode toggle defaulting to
  // the prefill sign (negative => assist).
  let assistMode = false; // false = "+ added", true = "assist"
  let assistInit = false;
  $: if (usesBw && !assistInit) {
    assistInit = true;
    assistMode = (prefill.added_weight ?? 0) < 0 || /assist/i.test(ex.name);
  }

  function displayLoad(s) {
    // For uses_bodyweight, show effective intent compactly; else show weight.
    if (usesBw) {
      const add = s.added_weight ?? 0;
      if (add < 0) return `assist ${Math.abs(toDisplay(add))}`;
      if (add > 0) return `+${toDisplay(add)}`;
      return "BW";
    }
    return s.weight == null ? "BW" : toDisplay(s.weight);
  }
  // F4: logged-set display strings recomputed on $displayUnit toggle (and fold).
  $: loggedLoads = ($displayUnit, todaySets.map((s) => displayLoad(s)));

  // Steppers ARE edits: step the display value, then recompute canonical base.
  function stepWeight(delta) {
    const cur = parseFloat(draftWeight) || 0;
    draftWeight = Math.max(0, +(cur + delta * stepDisplay).toFixed(2));
    onWeightInput();
  }
  function stepReps(delta) {
    const cur = parseInt(draftReps) || 0;
    draftReps = Math.max(0, cur + delta);
  }
  function stepAdded(delta) {
    const cur = parseFloat(draftAdded) || 0;
    draftAdded = Math.max(0, +(cur + delta * stepDisplay).toFixed(2));
    onAddedInput();
  }

  // The signed added_weight (base, full precision) to STORE given the UI mode:
  // assist => negative, added => positive. Null base -> 0.
  function signedAddedBase() {
    if (draftAddedBase == null) return 0;
    return assistMode ? -draftAddedBase : draftAddedBase;
  }

  // C4: in-flight guard. `confirming` is set on tap and cleared once the fold
  // reflects a new set (prefill.set_index advanced). A rapid double-tap can't
  // enqueue two events at the same stale set_index.
  let confirming = false;
  let confirmingFromIndex = -1;
  // When the prefill index advances past the index we confirmed, release.
  $: if (confirming && prefill.set_index > confirmingFromIndex) confirming = false;

  async function confirmSet() {
    if (confirming) return; // debounce double-tap
    confirming = true;
    confirmingFromIndex = prefill.set_index;
    const ev = buildSetEvent({
      exercise_id: ex.exercise_id,
      // Same `effectiveDate` that drove the prefill/set_index lookup above, so the
      // logged session_date can never diverge from the index it was computed for.
      session_date: effectiveDate,
      set_index: prefill.set_index,
      warmup: draftWarmup,
      // F4: log the CANONICAL base value (full precision), not the rounded
      // display string -- a toggled-but-unedited value never bakes 0.5 rounding
      // into storage. weighted bodyweight: weight stays null, load is added_weight.
      weightBase: usesBw ? null : draftWeightBase,
      reps: draftReps,
      usesBodyweight: usesBw,
      addedWeightBase: usesBw ? signedAddedBase() : undefined,
      bodyweightSnapshot: usesBw ? bodyweight : undefined,
      bodyweightSnapshotDate: usesBw ? bodyweightDate : undefined,
    });
    // Rest-timer hook: a clean "set logged at T" signal for a future countdown.
    dispatch("setlogged", { exercise_id: ex.exercise_id, at: Date.now() });
    const wasWarmup = draftWarmup; // capture before the draft re-seeds
    try {
      await queue(ev);
    } catch (e) {
      confirming = false; // let the user retry on failure
      throw e;
    }
    // X5: start the rest timer only AFTER a successful enqueue (a failed write
    // must not spawn a timer). X3: never rest after a warmup set.
    if (!wasWarmup) startRest(ex.exercise_id, restSecondsFor(ex));
    // prefill recomputes from the new fold; the $: guard above releases `confirming`.
  }

  // Delete = tombstone (C2 shape, exact identity). Warmup toggle preserves the
  // EXACT stored base numbers (C3) — only the flag changes.
  async function deleteSet(s) {
    await queue(buildSetDeleteEvent(s));
  }
  async function toggleSetWarmup(s) {
    await queue(buildWarmupToggleEvent(s));
  }

  // ---- Phase 5a: cardio entry (duration mm:ss and/or distance) ----
  let cardioMin = "";
  let cardioSec = "";
  let cardioDist = ""; // display distance value (km|mi)
  let cardioError = "";
  let cardioConfirming = false;
  $: cardioDurationS = (() => {
    const m = parseInt(cardioMin) || 0;
    const s = parseInt(cardioSec) || 0;
    const total = m * 60 + s;
    return total > 0 ? total : null;
  })();
  // Cardio last session (from the fold) for the "Last:" line.
  $: cardioLast = (() => {
    const byDate = folded.sets[ex.exercise_id] || {};
    const dates = Object.keys(byDate)
      .filter((d) => d < effectiveDate)
      .sort();
    for (let i = dates.length - 1; i >= 0; i--) {
      const arr = Object.values(byDate[dates[i]]);
      let dur = 0,
        dist = 0,
        hasDur = false,
        hasDist = false;
      for (const s of arr) {
        if (typeof s.duration_s === "number") {
          dur += s.duration_s;
          hasDur = true;
        }
        if (typeof s.distance_m === "number") {
          dist += s.distance_m;
          hasDist = true;
        }
      }
      if (hasDur || hasDist)
        return {
          date: dates[i],
          duration_s: hasDur ? dur : null,
          distance_m: hasDist ? dist : null,
        };
    }
    return null;
  })();

  // X2: index-advance guard (mirror the strength path). cardioConfirming stays
  // latched until the fold advances prefill.set_index past the confirmed index,
  // so a fast second tap can't enqueue another set at the same stale set_index.
  let cardioConfirmingFromIndex = -1;
  $: if (cardioConfirming && prefill && prefill.set_index > cardioConfirmingFromIndex)
    cardioConfirming = false;

  async function confirmCardio() {
    if (cardioConfirming) return;
    cardioError = "";
    const distM = distanceToMeters(cardioDist, $distanceUnit); // null if blank
    // X7: require at least one STRICTLY POSITIVE metric (0 is not a real set).
    const durOk = cardioDurationS != null && cardioDurationS > 0;
    const distOk = distM != null && distM > 0;
    if (!durOk && !distOk) {
      cardioError = "Enter a duration or a distance.";
      return;
    }
    cardioConfirming = true;
    cardioConfirmingFromIndex = prefill.set_index;
    const ev = buildCardioSetEvent({
      exercise_id: ex.exercise_id,
      session_date: effectiveDate,
      set_index: prefill.set_index,
      duration_s: durOk ? cardioDurationS : null,
      distance_m: distOk ? distM : null,
    });
    dispatch("setlogged", { exercise_id: ex.exercise_id, at: Date.now() });
    try {
      await queue(ev);
    } catch (e) {
      cardioConfirming = false; // allow retry on failure
      throw e;
    }
    cardioMin = cardioSec = cardioDist = "";
    // cardioConfirming releases when the fold advances (the $: guard above).
  }

  function cardioSetLabel(s) {
    const parts = [];
    if (typeof s.duration_s === "number") parts.push(formatDuration(s.duration_s));
    if (typeof s.distance_m === "number") parts.push(formatDistance(s.distance_m, $distanceUnit));
    return parts.length ? parts.join(" · ") : "—";
  }

  // Rest timer view for THIS exercise (only when it's the one active timer).
  $: myRest = $restTimer && $restTimer.exercise_id === ex.exercise_id ? $restTimer : null;

  // PR tag (5a): quiet badge when THIS session set an e1RM/volume PR. X6: fold
  // the PR set ONCE per (exercise, fold) here, then a cheap Set lookup for the
  // session — not a full re-fold per render. Cardio has no e1RM/volume PRs.
  $: prSet = isCardio ? { e1rm: new Set(), volume: new Set() } : prsFor(folded, ex);
  $: pr = isCardio ? { any: false } : isSessionPR(prSet, effectiveDate);

  function rowState(s) {
    return saveStateFor(s.__src_id, syncedIds, outboxList, rejectedIds);
  }
  // Retry a rejected set: re-emit its stored values as a FRESH event (new id, no
  // voids) so it can sync. The dead-lettered original stays for the record.
  async function retrySet(s) {
    await queue(buildSetRetryEvent(s));
  }
  const stateLabel = {
    synced: "synced",
    saved: "saved on this device",
    draft: "",
    error: "didn’t save — tap to retry",
  };
</script>

<section class="card" class:skipped class:warmupcard={false}>
  <header class="card-head">
    <div class="title">
      <span class="ex-name">
        {#if usesBw}
          {assistMode ? `Assisted ${ex.name}` : ex.name}
        {:else}
          {ex.name}
        {/if}
        {#if pr.any}
          <span class="pr-tag" title={`${pr.e1rm ? "e1RM PR" : ""}${pr.e1rm && pr.volume ? " · " : ""}${pr.volume ? "volume PR" : ""}`}>★ PR</span>
        {/if}
      </span>
      <span class="muted small">
        {ex.muscle_group}{#if !isCardio} · {ex.rep_range_low}–{ex.rep_range_high}{/if}
      </span>
    </div>
    <div class="head-actions">
      <button class="link" on:click={() => dispatch("swap")}>Swap</button>
      <button class="link" on:click={() => dispatch("skip")}>
        {skipped ? "Unskip" : "Skip"}
      </button>
    </div>
  </header>

  {#if skipped}
    <p class="muted small">Skipped this session.</p>
  {:else if isCardio}
    <!-- Phase 5a: cardio entry — duration mm:ss and/or distance. -->
    {#if cardioLast}
      <p class="last">Last: {cardioSetLabel(cardioLast)}</p>
    {/if}
    {#if todaySets.length}
      <ul class="sets cardio-sets">
        {#each todaySets as s (s.__src_id)}
          {@const state = rowState(s)}
          <li class="set-row cardio-row" class:errored={state === "error"}>
            <span class="set-idx">{s.set_index + 1}</span>
            <span class="cardio-val">{cardioSetLabel(s)}</span>
            {#if state === "error"}
              <button class="set-state error" on:click={() => retrySet(s)}>{stateLabel.error}</button>
            {:else}
              <span class="set-state {state}">{stateLabel[state]}</span>
            {/if}
            <button class="link tiny" on:click={() => deleteSet(s)}>✕</button>
          </li>
        {/each}
      </ul>
    {/if}

    <div class="cardio-entry">
      <div class="cardio-field">
        <span class="field-label">duration</span>
        <div class="dur">
          <input type="number" inputmode="numeric" min="0" placeholder="mm" bind:value={cardioMin} />
          <span class="colon">:</span>
          <input type="number" inputmode="numeric" min="0" max="59" placeholder="ss" bind:value={cardioSec} />
        </div>
      </div>
      <div class="cardio-field">
        <span class="field-label">distance</span>
        <div class="dist">
          <input type="number" inputmode="decimal" min="0" step="0.01" bind:value={cardioDist} />
          <select value={$distanceUnit} on:change={(e) => setDistanceUnit(e.currentTarget.value)}>
            <option value="km">km</option>
            <option value="mi">mi</option>
          </select>
        </div>
      </div>
    </div>
    {#if cardioError}<p class="error small">{cardioError}</p>{/if}
    <button class="confirm" on:click={confirmCardio} disabled={cardioConfirming}>
      {cardioConfirming ? "Logging…" : `Log ${prefill.set_index + 1}`}
    </button>
  {:else}
    {#if lastText}
      <p class="last">
        Last{lastRecency ? ` (${lastRecency})` : ""}: {lastText}
      </p>
    {/if}

    {#if suggestionText}
      <!-- Muted progression hint beside the proven prefill (never auto-applied);
           quiet once the first working set is logged this session. -->
      <p class="hint" role="note">
        <span class="hint-text">{suggestionText}</span>
        <button class="hint-apply" on:click={applySuggestion}>apply</button>
        <button class="hint-mute" on:click={holdFromCard} title="Stop suggesting for this exercise">
          mute
        </button>
      </p>
    {/if}

    <!-- Logged sets -->
    {#if todaySets.length}
      <ul class="sets">
        {#each todaySets as s, i (s.__src_id)}
          {@const state = rowState(s)}
          <li class="set-row" class:warmup={s.warmup} class:errored={state === "error"}>
            <span class="set-idx">{s.warmup ? "W" : s.set_index + 1}</span>
            <span class="set-load">{loggedLoads[i]}</span>
            <span class="set-x">×</span>
            <span class="set-reps">{s.reps ?? "—"}</span>
            {#if state === "error"}
              <button class="set-state error" on:click={() => retrySet(s)}>
                {stateLabel.error}
              </button>
            {:else}
              <span class="set-state {state}">{stateLabel[state]}</span>
            {/if}
            <span class="rest-slot" aria-hidden="true"></span>
            <button class="link tiny" on:click={() => toggleSetWarmup(s)}>
              {s.warmup ? "→work" : "W"}
            </button>
            <button class="link tiny" on:click={() => deleteSet(s)}>✕</button>
          </li>
        {/each}
      </ul>
    {/if}

    {#if myRest}
      <!-- Rest countdown in the row slot (5a). −15s / +15s / skip. -->
      <div class="rest" class:done={myRest.remaining <= 0}>
        <span class="rest-time">{formatDuration(myRest.remaining)}</span>
        <span class="rest-label">{myRest.remaining <= 0 ? "rest done" : "rest"}</span>
        <span class="rest-controls">
          <button class="rest-btn" on:click={stepDown}>−15</button>
          <button class="rest-btn" on:click={stepUp}>+15</button>
          <button class="rest-btn" on:click={skipRest}>skip</button>
        </span>
      </div>
    {/if}

    <!-- Draft entry row -->
    <div class="entry">
      {#if usesBw}
        <div class="bw-mode">
          <button class="chip" class:on={assistMode} on:click={() => (assistMode = true)}>Assist</button>
          <button class="chip" class:on={!assistMode} on:click={() => (assistMode = false)}>Add</button>
          {#if usesBw && bodyweight == null}
            <span class="muted small">no bodyweight set</span>
          {/if}
        </div>
        <div class="stepper-group">
          <span class="field-label">{assistMode ? "assist" : "added"} ({$displayUnit})</span>
          <div class="stepper">
            <button class="step" on:click={() => stepAdded(-1)} aria-label="decrease">−</button>
            <input
              type="number"
              inputmode="decimal"
              step={stepDisplay}
              bind:value={draftAdded}
              on:input={onAddedInput}
              on:focus={() => (addedFocused = true)}
              on:blur={onAddedBlur}
            />
            <button class="step" on:click={() => stepAdded(1)} aria-label="increase">+</button>
          </div>
        </div>
      {:else}
        <div class="stepper-group">
          <span class="field-label">weight ({$displayUnit})</span>
          <div class="stepper">
            <button class="step" on:click={() => stepWeight(-1)} aria-label="decrease weight">−</button>
            <input
              type="number"
              inputmode="decimal"
              step={stepDisplay}
              bind:value={draftWeight}
              on:input={onWeightInput}
              on:focus={() => (weightFocused = true)}
              on:blur={onWeightBlur}
            />
            <button class="step" on:click={() => stepWeight(1)} aria-label="increase weight">+</button>
          </div>
        </div>
      {/if}

      <div class="stepper-group">
        <span class="field-label">reps</span>
        <div class="stepper">
          <button class="step" on:click={() => stepReps(-1)} aria-label="decrease reps">−</button>
          <input type="number" inputmode="numeric" bind:value={draftReps} />
          <button class="step" on:click={() => stepReps(1)} aria-label="increase reps">+</button>
        </div>
      </div>

      <button class="warmup-toggle" class:on={draftWarmup} on:click={() => (draftWarmup = !draftWarmup)}>
        W
      </button>
    </div>

    <button class="confirm" on:click={confirmSet} disabled={confirming}>
      {confirming ? "Logging…" : `Log set ${prefill.set_index + 1}`}
    </button>
  {/if}
</section>

<style>
  .card {
    background: var(--surface);
    border: 1px solid var(--surface-2);
    border-radius: 14px;
    padding: 0.9rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .card.skipped {
    opacity: 0.55;
  }
  .card-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .title {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    min-width: 0;
  }
  .ex-name {
    font-weight: 700;
    font-size: 1.05rem;
  }
  .muted {
    color: var(--muted);
  }
  .small {
    font-size: 0.78rem;
  }
  .head-actions {
    display: flex;
    gap: 0.2rem;
    flex-shrink: 0;
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
  .link.tiny {
    min-height: 32px;
    padding: 0.2rem 0.35rem;
    font-size: 0.8rem;
  }
  .last {
    margin: 0;
    font-size: 0.82rem;
    color: var(--muted);
  }
  .hint {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8rem;
    color: var(--muted);
    font-style: italic;
  }
  .hint-apply,
  .hint-mute {
    border: 1px solid var(--surface-2);
    background: transparent;
    font: inherit;
    font-style: normal;
    font-size: 0.78rem;
    padding: 0.2rem 0.6rem;
    border-radius: 999px;
    cursor: pointer;
    flex-shrink: 0;
  }
  .hint-apply {
    color: var(--accent);
  }
  .hint-mute {
    color: var(--muted);
  }
  .cardio-soon {
    margin: 0;
    color: var(--muted);
    font-style: italic;
  }
  /* Cardio entry */
  .cardio-entry {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  .cardio-field {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .dur,
  .dist {
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }
  .dur input {
    width: 3.2rem;
    min-height: 48px;
    text-align: center;
    border: 1px solid var(--surface-2);
    border-radius: 10px;
    background: var(--bg);
    color: var(--text);
    font-size: 1.1rem;
    font-family: inherit;
  }
  .colon {
    font-weight: 700;
    color: var(--muted);
  }
  .dist input {
    width: 5rem;
    min-height: 48px;
    text-align: center;
    border: 1px solid var(--surface-2);
    border-radius: 10px;
    background: var(--bg);
    color: var(--text);
    font-size: 1.05rem;
    font-family: inherit;
  }
  .dist select {
    min-height: 48px;
    border: 1px solid var(--surface-2);
    border-radius: 10px;
    background: var(--bg);
    color: var(--text);
    font-family: inherit;
  }
  .cardio-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .cardio-val {
    flex: 1;
    font-weight: 600;
    min-width: 0;
  }
  /* Rest countdown */
  .rest {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.6rem;
    border-radius: 10px;
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    font-variant-numeric: tabular-nums;
  }
  .rest.done {
    background: color-mix(in srgb, var(--ok) 18%, transparent);
  }
  .rest-time {
    font-size: 1.1rem;
    font-weight: 700;
    color: var(--text);
  }
  .rest-label {
    color: var(--muted);
    font-size: 0.78rem;
    flex: 1;
  }
  .rest-controls {
    display: flex;
    gap: 0.3rem;
  }
  .rest-btn {
    /* X8: ~44px min tap target (was 36px) to reduce mis-taps next to "skip". */
    min-height: 44px;
    min-width: 44px;
    padding: 0 0.6rem;
    border: 1px solid var(--surface-2);
    border-radius: 8px;
    background: var(--bg);
    color: var(--accent);
    font: inherit;
    font-size: 0.85rem;
    cursor: pointer;
  }
  .error {
    color: var(--danger);
    margin: 0;
  }
  .pr-tag {
    font-size: 0.65rem;
    font-weight: 700;
    color: var(--ok);
    background: color-mix(in srgb, var(--ok) 16%, transparent);
    border-radius: 999px;
    padding: 0.05rem 0.4rem;
    margin-left: 0.4rem;
    vertical-align: middle;
    white-space: nowrap;
  }
  .sets {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .set-row {
    display: grid;
    grid-template-columns: 1.6rem auto 0.6rem 2rem 1fr auto auto auto;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.92rem;
  }
  .set-row.warmup {
    opacity: 0.6;
  }
  .set-idx {
    font-weight: 700;
    color: var(--muted);
    text-align: center;
  }
  .set-load {
    font-weight: 600;
  }
  .set-state {
    font-size: 0.7rem;
    text-align: right;
  }
  .set-state.synced {
    color: var(--ok);
  }
  .set-state.saved {
    color: var(--muted);
  }
  /* U2: loud red, tappable retry. A rejected set must never look "saved". */
  .set-state.error {
    color: var(--danger);
    font-weight: 700;
    border: 0;
    background: transparent;
    cursor: pointer;
    font-family: inherit;
    text-align: right;
  }
  .set-row.errored {
    background: color-mix(in srgb, var(--danger) 12%, transparent);
    border-radius: 8px;
  }
  .rest-slot {
    width: 0;
  }
  .entry {
    display: flex;
    align-items: flex-end;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .stepper-group {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .field-label {
    font-size: 0.72rem;
    color: var(--muted);
  }
  .stepper {
    display: flex;
    align-items: stretch;
  }
  .step {
    width: 48px;
    min-height: 52px;
    border: 1px solid var(--surface-2);
    background: var(--bg);
    color: var(--text);
    font-size: 1.4rem;
    cursor: pointer;
    font-family: inherit;
  }
  .step:first-child {
    border-radius: 10px 0 0 10px;
  }
  .step:last-child {
    border-radius: 0 10px 10px 0;
  }
  .stepper input {
    width: 4.5rem;
    min-height: 52px;
    text-align: center;
    border: 1px solid var(--surface-2);
    border-left: 0;
    border-right: 0;
    background: var(--bg);
    color: var(--text);
    font-size: 1.1rem;
    font-family: inherit;
  }
  .warmup-toggle,
  .chip {
    min-height: 52px;
    min-width: 48px;
    border-radius: 10px;
    border: 1px solid var(--surface-2);
    background: var(--bg);
    color: var(--muted);
    cursor: pointer;
    font-family: inherit;
    font-weight: 600;
  }
  .chip {
    min-height: 40px;
    padding: 0 0.8rem;
  }
  .warmup-toggle.on,
  .chip.on {
    background: var(--accent);
    color: var(--bg);
    border-color: var(--accent);
  }
  .bw-mode {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    width: 100%;
  }
  .confirm {
    min-height: 56px;
    border: 0;
    border-radius: 12px;
    background: var(--accent);
    color: #04212e;
    font-size: 1.05rem;
    font-weight: 700;
    cursor: pointer;
    font-family: inherit;
    /* U3: stay reachable when the numpad is up — stick to the bottom of the
       card's viewport so it isn't covered by the on-screen keyboard. */
    position: sticky;
    bottom: 0.5rem;
    z-index: 1;
  }
  .confirm:disabled {
    opacity: 0.6;
    cursor: default;
  }
</style>
