# Unit Model (corrected) — fixed hidden canonical + display toggle

Supersedes the per-user `base_unit` approach 2a built. To be applied in the 2b fix round.

## Model
- **Canonical storage unit = `lb`, FIXED app-wide, hidden from the user.** All weights (`weight`, `added_weight`,
  `increment`, `bodyweight`, `bodyweight_snapshot`) are stored as numbers in lb. Chosen because the seed catalog
  increments are already lb (zero conversion for catalog defaults). It's just a number — the user never sees "lb in DB".
- **Display unit toggle (lb/kg)** is pure presentation + entry: persisted client-side (localStorage). The user flips it
  freely anytime; everything shown converts, and entry in the displayed unit converts to lb before building events.
- `1 kg = 2.2046226218 lb`. Store full precision; round only for display (nearest 0.5).
- There is NO per-user base_unit, NO signup unit selector, NO immutability, and `/me`/login do NOT return a unit.

## What changes from the 2a build (do in the 2b fix round)
- **Backend:** remove `base_unit` from `SignupBody`, `storage.create_user`, the users.json record, and the
  `/api/auth/login` + `/api/auth/me` responses. (Back-compat: ignore any stored `base_unit` on old records.)
- **`client/src/lib/units.js`:** `getBaseUnit()` → returns the constant `"lb"` (canonical), not a per-user value.
  Keep `toBase`/`toDisplay`/`lbToBase`/`formatWeight`/`displayUnit` toggle. Since canonical == lb, `lbToBase` is identity.
- **`client/src/Login.svelte`:** remove the base-unit selector from signup.
- **`auth.js`:** stop caching/consuming `base_unit`.
- Net: events still store lb; the display toggle is the only user-facing unit control.

## Why
The earlier per-user-immutable design only existed to avoid a "user changed their stored unit" problem. A fixed
hidden canonical removes that problem outright and matches the intent: user toggles units without knowing or caring
what the backend stores.
