# Running feature: notes for moving it to another app

Built in Daily Disciplines (commits 35d75bd, 0080afc and later). Written so it can be lifted into a separate running-log app.

## Data flow
Garmin Personal API -> GitHub Action (`scripts/garmin-sync.mjs`, workflow `.github/workflows/garmin-sync.yml`) -> Firestore doc `daily-disciplines/garmin-data` -> app reads it with `onSnapshot` (cached in localStorage key `daily_disciplines_garmin_runs`).

## Run record (one per Garmin activity ID, so re-syncing never double counts)
`runs[activityId] = { date: 'YYYY-MM-DD', distance: metres, duration: seconds, type, avgHr?, elevation?: metres, calories? }`
Several runs on one day are separate records sharing a `date`.

## Sync script
- Calls `GET /activitylist-service/activities/search/activities?start&limit=100&startDate&endDate` on `https://personal.connectapi.garmin.com`, paging until a short page.
- Token: POST `/personalapitoken-service/personal-api/personal-api-key/token` with `Authorization: ApiKey <GARMIN_API_KEY>` -> 24h bearer token.
- Counted types (`RUN_TYPES`): running, treadmill_running, trail_running, track_running, virtual_run, indoor_running, street_running. Walks and hikes excluded.
- Env: `SINCE=YYYY-MM-DD` backfills from a date (workflow input `since`), `RUN_DAYS_BACK` (default 14), `DEBUG_SHAPES=true` prints field names only.
- Writes with Firestore REST PATCH using per-key `updateMask` so only touched runs change.

## App UI (in `index.html`, Health tab -> Running)
Helpers `runsOn(date)`, `kmStr` (metres -> miles, despite the name), `paceStr` (min/mile), `durStr`. Calendar badge = total miles that day; day panel lists each run (distance, time, pace, HR, elevation in ft, treadmill tag); month stats = total distance, runs/days, average pace (distance weighted), longest run, total elevation (ft), average run, plus daily bar chart. Display is miles and feet; stored data stays metric.

## Moving to the 6-year running log
Reuse `scripts/garmin-sync.mjs` as is, point `DOC_URL` at the other app's store, and run once with `SINCE=<first run date>` to backfill (the job pages in 100s and splits nothing for activities, so very long ranges are fine). Merge on activity ID if the old log has Garmin IDs; otherwise match by date plus distance.
