<script>
  // Exercise library screen (CONTRACT-phase2a §UI surfaces). List grouped by
  // muscle group (archived hidden), add custom, add from catalog, edit, archive.
  // Every change emits an event through the existing queue()/sync pipe.
  import { queue, makeEvent } from "./lib/sync.js";
  import {
    libraryMap,
    exercisesByGroup,
    MUSCLE_GROUPS,
    GROUP_DEFAULTS,
    buildExercisePayload,
  } from "./lib/library.js";
  import { displayUnit, toBase, toDisplay, lbToBase } from "./lib/units.js";
  import catalog from "./lib/catalog.json";

  const TYPES = ["weighted", "bodyweight", "cardio"];

  // mode: null (list) | "custom" | "catalog" | "edit"
  let mode = null;
  let search = "";

  // Editable form fields. To avoid increment precision drift (review H1/H2) the
  // form keeps the EXACT base-unit increment (`increment_base`) and a display
  // value for the input. `increment_dirty` flips only when the user actually
  // edits the field; on save we keep `increment_base` byte-identical unless
  // dirty, in which case we convert the typed display value to base.
  let form = blankForm();
  let incrementDirty = false;
  function blankForm() {
    return {
      exercise_id: null,
      name: "",
      type: "weighted",
      uses_bodyweight: false,
      muscle_group: "chest",
      rep_range_low: 6,
      rep_range_high: 10,
      increment_base: lbToBase(5), // exact base value
      increment_display: null, // derived; set below
      catalog_id: null,
      rest_seconds: "", // 5a: blank -> global default
    };
  }

  // The input shows the exact base increment converted + display-rounded. When
  // the user types, we mark dirty and stop deriving from base.
  $: if (form && !incrementDirty) {
    form.increment_display =
      form.increment_base == null ? null : toDisplay(form.increment_base, $displayUnit);
  }
  function onIncrementInput() {
    incrementDirty = true;
  }

  // Prefill rep range / increment from the muscle-group defaults (increment is
  // lb -> converted to base at FULL precision, review H2).
  function applyGroupDefaults() {
    const d = GROUP_DEFAULTS[form.muscle_group];
    if (!d) return;
    if (form.type === "cardio") {
      form.rep_range_low = null;
      form.rep_range_high = null;
      form.increment_base = null;
    } else {
      form.rep_range_low = d.rep_low ?? 8;
      form.rep_range_high = d.rep_high ?? 12;
      form.increment_base = d.increment_lb == null ? null : lbToBase(d.increment_lb);
    }
    incrementDirty = false; // re-derive the field from the new base value
  }

  function startCustom() {
    form = blankForm();
    incrementDirty = false;
    applyGroupDefaults();
    mode = "custom";
  }

  function startCatalog() {
    search = "";
    mode = "catalog";
  }

  // Picking a catalog entry COPIES it into a fresh exercise_defined (provenance
  // via catalog_id), never links. The lb default_increment is converted to base
  // at full precision (H2), not via display rounding.
  function pickCatalog(entry) {
    form = {
      exercise_id: null,
      name: entry.name,
      type: entry.type,
      uses_bodyweight: entry.uses_bodyweight,
      muscle_group: entry.muscle_group,
      rep_range_low: entry.default_rep_low,
      rep_range_high: entry.default_rep_high,
      increment_base:
        entry.default_increment == null ? null : lbToBase(entry.default_increment),
      increment_display: null,
      catalog_id: entry.catalog_id,
      rest_seconds: "",
    };
    incrementDirty = false;
    mode = "custom"; // reuse the form to confirm/tweak before saving
  }

  function startEdit(ex) {
    form = {
      exercise_id: ex.exercise_id,
      name: ex.name,
      type: ex.type,
      uses_bodyweight: ex.uses_bodyweight,
      muscle_group: ex.muscle_group,
      rep_range_low: ex.rep_range_low,
      rep_range_high: ex.rep_range_high,
      // keep the EXACT stored increment; the field derives from it (display-only
      // rounding) and only re-converts if the user edits it (H1).
      increment_base: ex.increment == null ? null : ex.increment,
      increment_display: null,
      catalog_id: ex.catalog_id ?? null,
      rest_seconds: ex.rest_seconds == null ? "" : ex.rest_seconds,
    };
    incrementDirty = false;
    mode = "edit";
  }

  // Catalog empty-state action: start a custom define prefilled with the typed
  // name (review: "Add '<query>' as custom" instead of dead-ending).
  function addTypedAsCustom() {
    const typed = search.trim();
    form = blankForm();
    incrementDirty = false;
    applyGroupDefaults();
    form.name = typed;
    mode = "custom";
  }

  function cancel() {
    mode = null;
    form = blankForm();
    incrementDirty = false;
  }

  async function save() {
    if (!form.name.trim()) return;
    const isEdit = mode === "edit" && form.exercise_id;
    const existing = isEdit ? $libraryMap[form.exercise_id] : null;

    // Increment: keep the exact stored base value unless the user changed the
    // field, in which case convert their typed display value to base (H1).
    let increment;
    if (form.type === "cardio") {
      increment = null;
    } else if (incrementDirty) {
      increment =
        form.increment_display == null || form.increment_display === ""
          ? null
          : toBase(Number(form.increment_display));
    } else {
      increment = form.increment_base; // byte-identical to what was stored
    }

    const payload = buildExercisePayload({
      exercise_id: form.exercise_id,
      name: form.name,
      type: form.type,
      uses_bodyweight: form.type === "bodyweight" ? true : form.uses_bodyweight,
      muscle_group: form.muscle_group,
      rep_range_low: form.rep_range_low,
      rep_range_high: form.rep_range_high,
      increment,
      catalog_id: form.catalog_id,
      archived: existing ? existing.archived : false,
      // Preserve the hold-progression flag across edits (set via its own toggle).
      hold_progression: existing ? existing.hold_progression : false,
      // 5a: per-exercise rest override (blank -> global default).
      rest_seconds: form.rest_seconds,
    });

    const ev = makeEvent(isEdit ? "exercise_updated" : "exercise_defined", payload);
    // edit MUST void the prior definition event for this exercise_id.
    if (isEdit && existing && existing.__src_id) ev.voids = existing.__src_id;
    await queue(ev);
    cancel();
  }

  async function archive(ex) {
    const payload = buildExercisePayload({ ...ex, archived: true });
    const ev = makeEvent("exercise_updated", payload);
    if (ex.__src_id) ev.voids = ex.__src_id;
    await queue(ev);
  }

  async function unarchive(ex) {
    const payload = buildExercisePayload({ ...ex, archived: false });
    const ev = makeEvent("exercise_updated", payload);
    if (ex.__src_id) ev.voids = ex.__src_id;
    await queue(ev);
  }

  // Phase 3: toggle the per-exercise "hold progression" flag (silences the Today
  // progression hint for this exercise). Emits a superseding exercise_updated.
  async function toggleHold(ex) {
    const payload = buildExercisePayload({
      ...ex,
      hold_progression: !ex.hold_progression,
    });
    const ev = makeEvent("exercise_updated", payload);
    if (ex.__src_id) ev.voids = ex.__src_id;
    await queue(ev);
  }

  // type is locked once a set is logged (no set events yet in 2a, so this is
  // always false -- wired so 2b can flip it without touching the form).
  function typeLocked(/* exerciseId */) {
    return false;
  }

  // Catalog search: match name + aliases (case-insensitive).
  $: q = search.trim().toLowerCase();
  $: catalogResults = !q
    ? catalog
    : catalog.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          (c.aliases || []).some((a) => a.toLowerCase().includes(q)),
      );

  $: archivedList = Object.values($libraryMap).filter((x) => x.archived);
  let showArchived = false;

  function repText(ex) {
    if (ex.type === "cardio") return "cardio";
    return `${ex.rep_range_low}–${ex.rep_range_high} reps`;
  }
  function incText(ex) {
    if (ex.type === "cardio" || ex.increment == null) return "";
    return `+${toDisplay(ex.increment)} ${$displayUnit}`;
  }
</script>

<div class="screen">
  {#if mode === null}
    <div class="actions">
      <button class="primary" on:click={startCustom}>Add custom</button>
      <button class="secondary" on:click={startCatalog}>Add from catalog</button>
    </div>

    {#each MUSCLE_GROUPS as group}
      {#if $exercisesByGroup[group] && $exercisesByGroup[group].length}
        <section class="group">
          <h3>{group}</h3>
          <div class="cards">
            {#each $exercisesByGroup[group] as ex (ex.exercise_id)}
              <div class="card">
                <div class="card-main">
                  <span class="ex-name">{ex.name}</span>
                  <span class="ex-meta">
                    {ex.type}{#if ex.uses_bodyweight && ex.type !== "bodyweight"}
                      · bodyweight{/if} · {repText(ex)}
                    {#if incText(ex)} · {incText(ex)}{/if}
                    {#if ex.hold_progression} · progression held{/if}
                  </span>
                </div>
                <div class="card-actions">
                  {#if ex.type !== "cardio"}
                    <button
                      class="link"
                      on:click={() => toggleHold(ex)}
                      title="Silence the Today progression hint for this exercise"
                    >
                      {ex.hold_progression ? "Resume progression" : "Hold progression"}
                    </button>
                  {/if}
                  <button class="link" on:click={() => startEdit(ex)}>Edit</button>
                  <button class="link" on:click={() => archive(ex)}>Archive</button>
                </div>
              </div>
            {/each}
          </div>
        </section>
      {/if}
    {/each}

    {#if Object.values($libraryMap).filter((x) => !x.archived).length === 0}
      <p class="empty">No exercises yet. Add one to get started.</p>
    {/if}

    {#if archivedList.length}
      <button class="link archived-toggle" on:click={() => (showArchived = !showArchived)}>
        {showArchived ? "Hide" : "Show"} archived ({archivedList.length})
      </button>
      {#if showArchived}
        <div class="cards">
          {#each archivedList as ex (ex.exercise_id)}
            <div class="card archived">
              <div class="card-main">
                <span class="ex-name">{ex.name}</span>
                <span class="ex-meta">{ex.muscle_group} · archived</span>
              </div>
              <div class="card-actions">
                <button class="link" on:click={() => unarchive(ex)}>Restore</button>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  {:else if mode === "catalog"}
    <div class="form-head">
      <h3>Add from catalog</h3>
      <button class="link" on:click={cancel}>Cancel</button>
    </div>
    <input
      class="search"
      type="search"
      placeholder="Search exercises…"
      bind:value={search}
      autocapitalize="none"
      autocorrect="off"
    />
    <div class="cards">
      {#each catalogResults as entry (entry.catalog_id)}
        <button class="catalog-row" on:click={() => pickCatalog(entry)}>
          <span class="ex-name">{entry.name}</span>
          <span class="ex-meta">{entry.muscle_group} · {entry.type}</span>
        </button>
      {/each}
      {#if catalogResults.length === 0}
        {#if search.trim()}
          <button class="catalog-row add-custom-row" on:click={addTypedAsCustom}>
            <span class="ex-name">Add “{search.trim()}” as custom</span>
            <span class="ex-meta">Create a new exercise with this name</span>
          </button>
        {:else}
          <p class="empty">No matches.</p>
        {/if}
      {/if}
    </div>
  {:else}
    <!-- custom / edit form -->
    <div class="form-head">
      <h3>{mode === "edit" ? "Edit exercise" : "New exercise"}</h3>
      <button class="link" on:click={cancel}>Cancel</button>
    </div>

    <form on:submit|preventDefault={save} class="form">
      <label>
        <span>Name</span>
        <input bind:value={form.name} required autocapitalize="words" />
      </label>

      <label>
        <span>Type {#if mode === "edit" && typeLocked()}<em>(locked — a set is logged)</em>{/if}</span>
        <select bind:value={form.type} disabled={mode === "edit" && typeLocked()}>
          {#each TYPES as t}<option value={t}>{t}</option>{/each}
        </select>
      </label>

      {#if form.type === "bodyweight" || form.type === "weighted"}
        <label class="check">
          <input type="checkbox" bind:checked={form.uses_bodyweight} disabled={form.type === "bodyweight"} />
          <span>Uses bodyweight (assisted / weighted bodyweight)</span>
        </label>
      {/if}

      <label>
        <span>Muscle group</span>
        <select bind:value={form.muscle_group} on:change={() => mode === "custom" && !form.catalog_id && applyGroupDefaults()}>
          {#each MUSCLE_GROUPS as g}<option value={g}>{g}</option>{/each}
        </select>
      </label>

      {#if form.type !== "cardio"}
        <div class="row">
          <label>
            <span>Rep low</span>
            <input type="number" min="1" bind:value={form.rep_range_low} />
          </label>
          <label>
            <span>Rep high</span>
            <input type="number" min="1" bind:value={form.rep_range_high} />
          </label>
          <label>
            <span>Increment ({$displayUnit})</span>
            <input
              type="number"
              min="0"
              step="0.5"
              bind:value={form.increment_display}
              on:input={onIncrementInput}
            />
          </label>
        </div>

        <label>
          <span>Rest timer (seconds, blank = default 120s)</span>
          <input type="number" min="0" step="5" placeholder="120" bind:value={form.rest_seconds} />
        </label>
      {/if}

      <button type="submit" class="primary">
        {mode === "edit" ? "Save changes" : "Add exercise"}
      </button>
    </form>
  {/if}
</div>

<style>
  .screen {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .actions {
    display: flex;
    gap: 0.6rem;
    flex-wrap: wrap;
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

  .group h3 {
    margin: 0 0 0.5rem;
    font-size: 0.85rem;
    text-transform: capitalize;
    color: var(--muted);
    letter-spacing: 0.04em;
  }

  /* Cards grid into columns on wide screens (uses the full-bleed width). */
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
    padding: 0.75rem 0.9rem;
  }
  .card.archived {
    opacity: 0.65;
  }
  .card-main {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
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
  .card-actions {
    display: flex;
    gap: 0.25rem;
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
  .archived-toggle {
    align-self: flex-start;
  }
  .empty {
    color: var(--muted);
    font-size: 0.9rem;
  }

  .form-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .form-head h3 {
    margin: 0;
    text-transform: capitalize;
  }
  .search {
    min-height: 48px;
    padding: 0 0.85rem;
    border-radius: 10px;
    border: 1px solid var(--surface-2);
    background: var(--bg);
    color: var(--text);
    font-size: 1rem;
  }
  .catalog-row {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.15rem;
    text-align: left;
    background: var(--surface);
    border: 1px solid var(--surface-2);
    border-radius: 12px;
    padding: 0.75rem 0.9rem;
    cursor: pointer;
    min-height: 56px;
    font-family: inherit;
    color: var(--text);
  }
  .add-custom-row {
    border-style: dashed;
    border-color: var(--accent);
  }
  .add-custom-row .ex-name {
    color: var(--accent);
  }

  .form {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    max-width: 520px;
  }
  .form label {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    font-size: 0.8rem;
    color: var(--muted);
  }
  .form label.check {
    flex-direction: row;
    align-items: center;
    gap: 0.5rem;
    color: var(--text);
    font-size: 0.85rem;
  }
  .form .row {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.6rem;
  }
  .form input,
  .form select {
    min-height: 48px;
    padding: 0 0.85rem;
    border-radius: 10px;
    border: 1px solid var(--surface-2);
    background: var(--bg);
    color: var(--text);
    font-size: 1rem;
    font-family: inherit;
  }
  .form input[type="checkbox"] {
    min-height: 0;
    width: 1.1rem;
    height: 1.1rem;
  }
  .form em {
    color: var(--warn);
    font-style: normal;
  }
</style>
