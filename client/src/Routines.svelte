<script>
  // Routines screen (CONTRACT-phase2a §UI surfaces, A1). NAMED routines decoupled
  // from the calendar: a list of routines (create / rename / archive); open one
  // to edit its ordered exercise list (add from library, remove, HANDLE-ONLY
  // drag-reorder) and optionally assign it as the default for 0+ weekdays.
  // Every change re-emits the whole routine_defined/routine_updated through the
  // existing queue()/sync pipe (full-replace). Reload rebuilds from the log.
  import { dndzone } from "svelte-dnd-action";
  import { flip } from "svelte/animate";
  import { get } from "svelte/store";
  import { queue, makeEvent } from "./lib/sync.js";
  import {
    routinesMap,
    activeRoutines,
    weekdayDefaults,
    weekdayConflicts,
    libraryMap,
    activeExercises,
    buildRoutinePayload,
    WEEKDAYS,
  } from "./lib/library.js";

  // view: "list" | "edit"
  let view = "list";
  let editingId = null;
  let adding = false;
  let newName = "";

  function nameOf(id) {
    const ex = $libraryMap[id];
    return ex ? ex.name : "(removed exercise)";
  }

  // Lost-update fix (HIGH): every edit is a full-replace that must build on the
  // FRESHEST routine state, not a stale reactive snapshot.
  //
  // Design: an authoritative in-memory `pendingRoutines` map (routine_id ->
  // {payload, __src_id}) is updated SYNCHRONOUSLY at emit time. "Freshest state"
  // is therefore independent of the async projection rebuild: each edit reads
  // `pendingRoutines[id] ?? get(routinesMap)[id]`, applies its transform, emits a
  // routine_updated that voids that state's source event, and immediately writes
  // the new payload back. No timing window exists between queue() and the rebuild.
  // The pending entry is kept until the projection catches up (self-correcting:
  // a later rebuild that matches just confirms it; we drop it once reflected).
  // queue() is awaited via a serialization chain that is failure-isolated -- a
  // rejected queue() never leaves the chain permanently rejected.
  let mutateChain = Promise.resolve();
  /** @type {Record<string, {payload: object, __src_id: string}>} */
  let pendingRoutines = {};

  /** Drop a pending entry once the projection reflects its source event. */
  $: for (const id of Object.keys(pendingRoutines)) {
    const proj = $routinesMap[id];
    if (proj && proj.__src_id === pendingRoutines[id].__src_id) {
      delete pendingRoutines[id];
    }
  }

  /** Synchronously read the freshest routine state (pending overrides projection). */
  function freshest(routineId) {
    const p = pendingRoutines[routineId];
    if (p) return { ...p.payload, __src_id: p.__src_id };
    return get(routinesMap)[routineId] || null;
  }

  // SINGLE effective-state source for the whole open-routine view. The UI (drag
  // list, addable picker, rename value, weekday toggles) MUST render from this --
  // never from the lagging `$routinesMap` projection -- so handler INPUTS reflect
  // edits already emitted but not yet rebuilt. Depends on both stores so it
  // recomputes when either the pending map or the projection changes.
  $: effectiveRoutine = editingId
    ? (pendingRoutines[editingId]
        ? { ...pendingRoutines[editingId].payload, __src_id: pendingRoutines[editingId].__src_id }
        : $routinesMap[editingId] || null)
    : null;
  $: orderedIds = effectiveRoutine ? effectiveRoutine.ordered_exercise_ids || [] : [];
  // dnd items: stable id per row = exercise_id (an exercise appears once/routine).
  $: items = orderedIds
    .map((id) => $libraryMap[id])
    .filter(Boolean)
    .map((ex) => ({ id: ex.exercise_id, ex }));

  /**
   * Emit a routine event built from the freshest state, updating the authoritative
   * pending map synchronously BEFORE the async queue(). Serialized + failure-
   * isolated so a rejected queue() doesn't brick later edits.
   * @param {string} routineId
   * @param {(current: object|null) => (object|null)} transform - returns payload
   *   fields, or null to skip. Receives null for a brand-new routine.
   * @param {boolean} [isCreate]
   */
  function emitRoutine(routineId, transform, isCreate = false) {
    const current = isCreate ? null : freshest(routineId);
    if (!isCreate && !current) return Promise.resolve(); // vanished
    const fields = transform(current);
    if (!fields) return Promise.resolve();
    const payload = buildRoutinePayload({ routine_id: routineId, ...fields });
    const ev = makeEvent(isCreate ? "routine_defined" : "routine_updated", payload);
    if (!isCreate) ev.voids = current.__src_id; // void the current head (contract)
    // Authoritative state advances synchronously -- the next emit sees it now.
    pendingRoutines[routineId] = { payload, __src_id: ev.id };
    pendingRoutines = pendingRoutines; // Svelte reactivity

    mutateChain = mutateChain
      .then(() => queue(ev))
      .catch((e) => {
        // Failure isolation: log + recover so subsequent edits still run. The
        // event stays in the outbox and retries via the normal sync loop.
        console.error("[routines] queue failed (will retry via sync):", e);
      });
    return mutateChain;
  }

  // --- list view actions ---
  async function createRoutine() {
    const name = newName.trim();
    if (!name) return;
    const id = crypto.randomUUID();
    await emitRoutine(
      id,
      () => ({ name, ordered_exercise_ids: [], weekday_assignments: [], archived: false }),
      true,
    );
    newName = "";
    editingId = id;
    view = "edit";
  }

  function openRoutine(r) {
    editingId = r.routine_id;
    adding = false;
    view = "edit";
  }

  async function archiveRoutine(r) {
    await emitRoutine(r.routine_id, (cur) => ({
      name: cur.name,
      ordered_exercise_ids: cur.ordered_exercise_ids,
      weekday_assignments: [], // drop weekday claims when archived
      archived: true,
    }));
  }
  async function restoreRoutine(r) {
    await emitRoutine(r.routine_id, (cur) => ({
      name: cur.name,
      ordered_exercise_ids: cur.ordered_exercise_ids,
      weekday_assignments: cur.weekday_assignments,
      archived: false,
    }));
  }

  // --- edit view actions (all full-replace re-emits, freshest-state-aware) ---
  async function saveOrder(ids) {
    if (!editingId) return;
    // Reconcile the drag-produced order against the FRESHEST list: keep only ids
    // still present, in the dragged order, then append any freshest ids the drag
    // snapshot didn't include (e.g. an exercise added concurrently mid-drag) so a
    // reorder never drops a just-added exercise.
    await emitRoutine(editingId, (cur) => {
      const curIds = cur.ordered_exercise_ids || [];
      const curSet = new Set(curIds);
      const draggedSet = new Set(ids);
      const reordered = ids.filter((id) => curSet.has(id));
      const appended = curIds.filter((id) => !draggedSet.has(id));
      return {
        name: cur.name,
        ordered_exercise_ids: [...reordered, ...appended],
        weekday_assignments: cur.weekday_assignments,
        archived: cur.archived,
      };
    });
  }
  async function addExercise(id) {
    if (!editingId) return;
    // Append to the CURRENT ordered list (freshest, not a stale snapshot), and
    // DEDUP: a rapid double-add sees the freshest list so it never appends a
    // duplicate exercise_id. The transform receives freshest state, so the guard
    // here is decisive even before the projection rebuilds.
    await emitRoutine(editingId, (cur) => {
      const curIds = cur.ordered_exercise_ids || [];
      if (curIds.includes(id)) return null; // already present -> no-op
      return {
        name: cur.name,
        ordered_exercise_ids: [...curIds, id],
        weekday_assignments: cur.weekday_assignments,
        archived: cur.archived,
      };
    });
  }
  async function removeExercise(id) {
    if (!editingId) return;
    await emitRoutine(editingId, (cur) => ({
      name: cur.name,
      ordered_exercise_ids: (cur.ordered_exercise_ids || []).filter((x) => x !== id),
      weekday_assignments: cur.weekday_assignments,
      archived: cur.archived,
    }));
  }
  async function rename() {
    if (!editingId) return;
    const name = (renameValue ?? "").trim();
    renaming = false;
    if (!name) return;
    await emitRoutine(editingId, (cur) =>
      name === cur.name
        ? null
        : {
            name,
            ordered_exercise_ids: cur.ordered_exercise_ids,
            weekday_assignments: cur.weekday_assignments,
            archived: cur.archived,
          },
    );
  }
  async function toggleWeekday(wd) {
    if (!editingId) return;
    await emitRoutine(editingId, (cur) => {
      const curDays = cur.weekday_assignments || [];
      const next = curDays.includes(wd)
        ? curDays.filter((d) => d !== wd)
        : [...curDays, wd];
      return {
        name: cur.name,
        ordered_exercise_ids: cur.ordered_exercise_ids,
        weekday_assignments: next,
        archived: cur.archived,
      };
    });
  }

  let renaming = false;
  let renameValue = "";
  function startRename() {
    renameValue = effectiveRoutine ? effectiveRoutine.name : "";
    renaming = true;
  }

  // dnd-action: only the ⠿ handle starts a drag (dragHandleSelector) so scrolling
  // a long list on a phone never flings exercises (review A1 / advocate).
  let dragItems = null;
  function handleConsider(e) {
    dragItems = e.detail.items;
  }
  async function handleFinalize(e) {
    dragItems = null;
    await saveOrder(e.detail.items.map((i) => i.id));
  }
  $: displayItems = dragItems ?? items;

  // Addable picker derives from the EFFECTIVE ordered list (via orderedIds), so a
  // just-added exercise immediately disappears from the picker -- preventing the
  // stale-list double-add path at the source.
  $: addable = $activeExercises.filter((ex) => !orderedIds.includes(ex.exercise_id));

  function assignedDaysText(r) {
    const days = (r.weekday_assignments || []).slice().sort((a, b) => a - b);
    if (!days.length) return "Unassigned";
    return days.map((d) => WEEKDAYS[d].slice(0, 3)).join(", ");
  }
</script>

<div class="screen">
  {#if view === "list"}
    <div class="create">
      <input
        class="name-input"
        placeholder="New routine name (e.g. Push)"
        bind:value={newName}
        on:keydown={(e) => e.key === "Enter" && createRoutine()}
        autocapitalize="words"
      />
      <button class="primary" on:click={createRoutine} disabled={!newName.trim()}>
        Create
      </button>
    </div>

    {#if $activeRoutines.length === 0}
      <p class="empty">No routines yet. Create one (Push, Pull, Legs, A/B…).</p>
    {:else}
      <div class="cards">
        {#each $activeRoutines as r (r.routine_id)}
          <div class="card">
            <button class="card-main" on:click={() => openRoutine(r)}>
              <span class="r-name">{r.name}</span>
              <span class="r-meta">
                {(r.ordered_exercise_ids || []).length} exercise{(r.ordered_exercise_ids || []).length === 1 ? "" : "s"}
                · {assignedDaysText(r)}
              </span>
            </button>
            <button class="link" on:click={() => archiveRoutine(r)}>Archive</button>
          </div>
        {/each}
      </div>
    {/if}

    {#each Object.entries($weekdayConflicts) as [wd, ids] (wd)}
      <p class="conflict" role="status">
        ⚠ {WEEKDAYS[wd]}: {ids.length} routines assigned — “{$routinesMap[ids[ids.length - 1]]?.name}”
        is the active default.
      </p>
    {/each}

    {#each Object.values($routinesMap).filter((r) => r.archived) as r (r.routine_id)}
      <div class="card archived">
        <div class="card-main static">
          <span class="r-name">{r.name}</span>
          <span class="r-meta">archived</span>
        </div>
        <button class="link" on:click={() => restoreRoutine(r)}>Restore</button>
      </div>
    {/each}
  {:else if effectiveRoutine}
    <div class="edit-head">
      <button class="link" on:click={() => (view = "list")}>‹ Routines</button>
      {#if renaming}
        <input
          class="name-input"
          bind:value={renameValue}
          on:keydown={(e) => e.key === "Enter" && rename()}
          on:blur={rename}
        />
      {:else}
        <button class="title-btn" on:click={startRename}>
          {effectiveRoutine.name} <span class="edit-hint">✎</span>
        </button>
      {/if}
      <button class="link" on:click={() => (adding = !adding)}>
        {adding ? "Done" : "+ Add"}
      </button>
    </div>

    <div class="weekdays">
      <span class="wd-label">Default for:</span>
      {#each WEEKDAYS as label, wd}
        <button
          class="wd"
          class:on={(effectiveRoutine.weekday_assignments || []).includes(wd)}
          on:click={() => toggleWeekday(wd)}
          aria-pressed={(effectiveRoutine.weekday_assignments || []).includes(wd)}
        >
          {label.slice(0, 1)}
        </button>
      {/each}
    </div>

    {#if adding}
      <div class="add-panel">
        {#if addable.length === 0}
          <p class="empty">All your exercises are already in this routine.</p>
        {:else}
          <div class="add-list">
            {#each addable as ex (ex.exercise_id)}
              <button class="add-row" on:click={() => addExercise(ex.exercise_id)}>
                <span class="ex-name">{ex.name}</span>
                <span class="ex-meta">{ex.muscle_group}</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    {#if displayItems.length === 0}
      <p class="rest">Empty routine — add exercises above.</p>
    {:else}
      <ul
        class="dnd"
        use:dndzone={{
          items: displayItems,
          flipDurationMs: 150,
          dragHandleSelector: ".grip",
        }}
        on:consider={handleConsider}
        on:finalize={handleFinalize}
      >
        {#each displayItems as item (item.id)}
          <li class="item" animate:flip={{ duration: 150 }}>
            <span class="grip" aria-label="Drag to reorder" role="button" tabindex="0">⠿</span>
            <span class="item-name">{nameOf(item.id)}</span>
            <button
              class="link remove"
              on:click={() => removeExercise(item.id)}
              aria-label={`Remove ${nameOf(item.id)}`}
            >
              Remove
            </button>
          </li>
        {/each}
      </ul>
      <p class="hint">Drag the ⠿ handle to reorder. Tapping elsewhere won’t move items.</p>
    {/if}
  {/if}
</div>

<style>
  .screen {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .create {
    display: flex;
    gap: 0.5rem;
  }
  .name-input {
    flex: 1;
    min-height: 48px;
    padding: 0 0.85rem;
    border-radius: 10px;
    border: 1px solid var(--surface-2);
    background: var(--bg);
    color: var(--text);
    font-size: 1rem;
    font-family: inherit;
  }
  .primary {
    min-height: 48px;
    padding: 0 1.1rem;
    border: 0;
    border-radius: 10px;
    background: var(--accent);
    color: #04212e;
    font-weight: 600;
    cursor: pointer;
    font-family: inherit;
  }
  .primary:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .cards {
    display: grid;
    grid-template-columns: 1fr;
    gap: 0.6rem;
  }
  @media (min-width: 640px) {
    .cards {
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    }
  }
  .card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    background: var(--surface);
    border: 1px solid var(--surface-2);
    border-radius: 12px;
    padding: 0.5rem 0.9rem;
  }
  .card.archived {
    opacity: 0.65;
  }
  .card-main {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
    flex: 1;
    text-align: left;
    background: transparent;
    border: 0;
    color: inherit;
    cursor: pointer;
    font-family: inherit;
    padding: 0.4rem 0;
  }
  .card-main.static {
    cursor: default;
  }
  .r-name {
    font-weight: 600;
    color: var(--text);
    font-size: 1rem;
  }
  .r-meta {
    font-size: 0.78rem;
    color: var(--muted);
  }

  .conflict {
    margin: 0;
    padding: 0.55rem 0.75rem;
    border-radius: 10px;
    background: color-mix(in srgb, var(--warn) 14%, transparent);
    color: var(--warn);
    font-size: 0.82rem;
  }

  .edit-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .title-btn {
    flex: 1;
    text-align: center;
    background: transparent;
    border: 0;
    color: var(--text);
    font-size: 1.1rem;
    font-weight: 600;
    cursor: pointer;
    font-family: inherit;
  }
  .edit-hint {
    color: var(--muted);
    font-size: 0.85rem;
  }

  .weekdays {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    flex-wrap: wrap;
  }
  .wd-label {
    font-size: 0.78rem;
    color: var(--muted);
    margin-right: 0.25rem;
  }
  .wd {
    width: 2.1rem;
    height: 2.1rem;
    border-radius: 50%;
    border: 1px solid var(--surface-2);
    background: var(--surface);
    color: var(--muted);
    cursor: pointer;
    font-family: inherit;
    font-weight: 600;
  }
  .wd.on {
    background: var(--accent);
    color: var(--bg);
    border-color: var(--accent);
  }

  .add-panel {
    border: 1px solid var(--surface-2);
    border-radius: 12px;
    padding: 0.75rem;
    background: var(--surface);
  }
  .add-list {
    display: grid;
    grid-template-columns: 1fr;
    gap: 0.4rem;
  }
  @media (min-width: 640px) {
    .add-list {
      grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    }
  }
  .add-row {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.1rem;
    text-align: left;
    background: var(--bg);
    border: 1px solid var(--surface-2);
    border-radius: 10px;
    padding: 0.6rem 0.8rem;
    cursor: pointer;
    min-height: 48px;
    font-family: inherit;
    color: var(--text);
  }

  .dnd {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    background: var(--surface);
    border: 1px solid var(--surface-2);
    border-radius: 12px;
    padding: 0.75rem 0.9rem;
    min-height: 56px;
  }
  .grip {
    cursor: grab;
    color: var(--muted);
    font-size: 1.3rem;
    /* Only the handle owns the touch gesture; the rest of the row scrolls. */
    touch-action: none;
    padding: 0.25rem 0.35rem;
    user-select: none;
  }
  .item-name {
    flex: 1;
    font-weight: 600;
    min-width: 0;
  }
  .remove {
    flex-shrink: 0;
  }
  .link {
    border: 0;
    background: transparent;
    color: var(--accent);
    font-size: 0.85rem;
    cursor: pointer;
    padding: 0.5rem 0.4rem;
    min-height: 40px;
    font-family: inherit;
  }
  .ex-name {
    font-weight: 600;
    color: var(--text);
  }
  .ex-meta {
    font-size: 0.78rem;
    color: var(--muted);
    text-transform: capitalize;
  }
  .rest,
  .empty,
  .hint {
    color: var(--muted);
    font-size: 0.9rem;
    margin: 0;
  }
  .hint {
    font-size: 0.78rem;
  }
</style>
