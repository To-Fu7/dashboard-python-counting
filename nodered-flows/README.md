# Node-RED flows — hourly-aggregate sync

Importable Node-RED flow JSON for syncing completed hours from this site's
local `apd_hourly` / `firesmoke_hourly` / `face_hourly` / `intrusion_hourly`
tables up to the central "server utama" database, the same way the existing
`inout_resample` sync already does. **Not related to** `dashboard/nodered/`
(the disabled in-dashboard Node-RED editor) — this is meant for whatever
Node-RED instance already runs the production `inout_resample` sync flow.

## Files

- `hourly-sync-apd-firesmoke-face.json` — one flow tab, 4 parallel pipelines
  (APD, Fire/Smoke, Face, Intrusion), each mirroring the existing
  `inout_resample` sync pattern: inject (every 6 min) → build SELECT → fetch
  local rows → build INSERT for the central DB → run it → mark local rows
  synced.

## Design decisions (read before importing)

- **Target table is `traffic_countings`** (same table `inout_resample`
  already syncs into), per the existing shared schema — there's no separate
  table per detection type. Since `(iddevice, starthour)` is also the
  conflict key `inout_resample`'s sync uses, a naive `SET data = EXCLUDED.data`
  would **replace** whatever the person-counting sync already wrote for that
  row. These flows instead do `SET data = traffic_countings.data ||
  EXCLUDED.data` (JSONB merge), so writes only ever add/overwrite their own
  keys in the shared row.
- **Output shape is FLAT**, matching the existing `cctv_people_*` convention
  — `cctv_apd`, `cctv_apd_total`, `cctv_fire`, `cctv_fire_total`,
  `cctv_smoke`, `cctv_smoke_total`, `cctv_face_insider`, `cctv_face_intruder`,
  `cctv_face_total_insider`, `cctv_face_total_intruder`, `cctv_intrusion`,
  `cctv_intrusion_total` — **not** nested under a sub-object.
  `cctv_intrusion`/`cctv_intrusion_total` used to be intentionally skipped by
  this flow (no source table existed yet) — now that `intrusion_hourly`
  exists (`python-counting/detection/intrusion.py`), the 4th pipeline sources
  them for real, same as every other field.
- **Aggregation, not pass-through.** The local tables store dynamic
  per-label/per-person JSONB (`apd_hourly.data = {"no_helmet": 3, "no_vest": 2,
  "unique_persons": 4}`, `face_hourly.data = {"Budi": 5, "intruder": 2,
  "unique_persons": 7}`) — each pipeline's `query` function reduces that down
  to the flat shape via SQL before `build INSERT` ever sees it:
  - `cctv_apd` = SUM of every `apd_hourly.data` key **except** `unique_persons`
    — total violation *events* that hour (can exceed the number of people if
    one person triggers multiple labels; confirmed against a live test: two
    synthetic hours with `{no_helmet:3, no_vest:2, unique_persons:4}` and
    `{no_helmet:1, no_gloves:5, unique_persons:2}` correctly summed to 5 and 6
    respectively, excluding `unique_persons` both times).
  - `cctv_face_insider` = SUM of every `face_hourly.data` key **except**
    `intruder` and `unique_persons` (sum of all named-person counts).
  - `cctv_face_intruder` = `face_hourly.data->>'intruder'` directly.
  - `cctv_fire` / `cctv_smoke` = `firesmoke_hourly.data->>'fire'` /
    `->>'smoke'` directly — these keys are fixed, no aggregation needed.
  - `cctv_intrusion` = `intrusion_hourly.data->>'intrusion'` directly (fixed
    key, same as fire/smoke — `intrusion_hourly` has no dynamic per-label
    keys, just `intrusion` and `unique_persons`, and both are always equal
    since `detection/intrusion.py` fires at most once per track).
  - Every `_total` field is a running SUM across the local calendar day
    (`Asia/Jakarta`), via the same daily-JOIN CTE pattern the existing
    `inout_resample` sync uses for `cctv_people_total_in`/`_out` — recomputed
    fresh each sync cycle from whatever hours exist for that day (not-yet-
    elapsed hours are zero-valued placeholders from `pregenerate_day`, so
    this naturally reads as "cumulative so far" without needing a stored
    running-total column).
- **No surrogate `id` column.** Unlike `inout_resample` (`id SERIAL PRIMARY
  KEY`), `apd_hourly`/`firesmoke_hourly`/`face_hourly`/`intrusion_hourly` only
  have `UNIQUE (device_id, hour_start)` as their natural key (see
  `python-counting/init_db.py`).
  The "mark as synced" step here matches on `(device_id, hour_start)` tuples
  instead of a single id list.
- **`is_synced` column**: added via `python-counting/init_db.py` (migration:
  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS is_synced BOOLEAN NOT NULL
  DEFAULT false`, plus a partial index on `WHERE is_synced = false` so this
  query stays fast regardless of table size) — run `python init_db.py`
  against the local DB before these flows will find the column.
  `outputs/hourly_aggregate_db.py`'s `increment_hourly()` resets
  `is_synced = false` on every update as a defensive measure against a rare
  late-arriving event after a sync already ran (see its docstring).
- **Reuses existing DB config nodes** by id (`f973403dd55782d0` for the LOCAL
  `env-admin` connection, `4399a9fce6b51683` for the `env-iot` SERVER UTAMA
  connection) — these must already exist in whatever Node-RED instance you
  import into (they do, in the instance running the existing
  `inout_resample` sync). Importing into a different/fresh instance will
  leave the `postgresql` nodes pointing at nothing until you re-point them at
  your own config nodes.
- **SQL is built via raw string interpolation**, not parameterized queries —
  matching the existing `inout_resample` flow's own style (a Node-RED
  `function` node building a query string, not the `postgresql` node's own
  parameter binding). String values are escaped (`'` → `''`) before
  interpolation to avoid literal breakage from e.g. an apostrophe in a
  device name or an enrolled person's name — this is a reliability fix, not
  a claim that this style is injection-hardened to the same standard as the
  parameterized queries used in `python-counting`'s own Python code.
- Same `_EPW_` → `_ALL_` device-code duplication as the existing flow (writes
  both the per-camera row and an aggregated "ALL cameras at this site" row).
  If that convention doesn't apply to these detection types, remove the
  `codeALL` line and its corresponding `seen.set(...)` call in each "build
  INSERT" function.

## Import steps

1. In Node-RED: menu → Import → paste/select `hourly-sync-apd-firesmoke-face.json`.
2. Confirm it lands on its own new tab ("Hourly Sync (APD/FireSmoke/Face/Intrusion)").
3. Open each `postgresql` node once to confirm it resolved to the expected
   existing DB config (LOCAL vs SERVER UTAMA) — Node-RED matches by id, but
   worth a visual check before deploying.
4. Deploy. Each pipeline's inject node fires once 5s after deploy, then every
   6 minutes.
5. Watch the debug panel for the first cycle on each pipeline to confirm rows
   are actually found/synced (or "No X rows to sync" if there's nothing
   pending yet — expected right after running `init_db.py`'s migration,
   since older rows retroactively default to `is_synced = false` and will
   all get picked up on the first run).
