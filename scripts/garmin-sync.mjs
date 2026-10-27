// Pulls your steps, body battery and runs from Garmin's Personal API and stores them in
// Firestore (doc daily-disciplines/garmin-data) for the Health tab to display.
// Runs in GitHub Actions; the key comes from the GARMIN_API_KEY repository secret.
//
// Optional environment:
//   SINCE=YYYY-MM-DD   back-fill everything from that date (manual runs only)
//   DAYS_BACK=3        how many days of steps/body battery to refresh normally
//   RUN_DAYS_BACK=14   how many days of runs to refresh normally
//   DEBUG_SHAPES=true  print response field names (never values)

const API_KEY = process.env.GARMIN_API_KEY;
const HOST = process.env.GARMIN_HOST || 'https://personal.connectapi.garmin.com';
const PROJECT = 'daily-disciplines-b7819';
const DOC_URL = process.env.FIRESTORE_DOC_URL || `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/daily-disciplines/garmin-data`;
const DAYS_BACK = Math.max(1, Number(process.env.DAYS_BACK || 3));
const RUN_DAYS_BACK = Math.max(1, Number(process.env.RUN_DAYS_BACK || 14));
const SINCE = /^\d{4}-\d{2}-\d{2}$/.test(process.env.SINCE || '') ? process.env.SINCE : '';
const DEBUG = process.env.DEBUG_SHAPES === 'true';
const CHUNK_DAYS = 14;

// Activity types that count as a run (walks and hikes are deliberately not included).
const RUN_TYPES = new Set(['running', 'treadmill_running', 'trail_running', 'track_running', 'virtual_run', 'indoor_running', 'street_running']);

if (!API_KEY) {
  console.error('GARMIN_API_KEY is not set. Add it under Settings > Secrets and variables > Actions.');
  process.exit(1);
}

// ---- dates (UK local days) ----
function ukDate(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
const addDays = (iso, n) => {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
function rangeFor(daysBack) {
  const end = ukDate(new Date());
  return { start: SINCE || addDays(end, -(daysBack - 1)), end };
}
// Split a range into windows so one request never covers too many days.
function chunks(start, end) {
  const out = [];
  for (let s = start; s <= end; s = addDays(s, CHUNK_DAYS)) {
    const e = addDays(s, CHUNK_DAYS - 1);
    out.push([s, e > end ? end : e]);
  }
  return out;
}

// ---- Garmin ----
async function getToken() {
  const res = await fetch(`${HOST}/personalapitoken-service/personal-api/personal-api-key/token`, {
    method: 'POST',
    headers: { Authorization: `ApiKey ${API_KEY}` },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Garmin rejected the API key (HTTP ${res.status}). It may have expired: create a new one and update the GARMIN_API_KEY secret.`);
  }
  if (!res.ok) throw new Error(`Token request failed (HTTP ${res.status}).`);
  const text = (await res.text()).trim();
  try {
    const j = JSON.parse(text);
    return j.access_token || j.accessToken || j.token || text;
  } catch (e) {
    return text.replace(/^"|"$/g, '');
  }
}

async function garminGet(token, path) {
  const res = await fetch(`${HOST}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 160).replace(/\s+/g, ' ');
    throw new Error(`GET ${path.split('?')[0]} failed (HTTP ${res.status}) ${body}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Field names + types only, never values (Actions logs on a public repo are public).
function shape(v, depth = 0) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return depth > 3 ? 'array' : { array_length: v.length, first_item: v.length ? shape(v[0], depth + 1) : null };
  if (typeof v === 'object') {
    if (depth > 3) return 'object';
    const out = {};
    for (const k of Object.keys(v).slice(0, 80)) out[k] = shape(v[k], depth + 1);
    return out;
  }
  return typeof v;
}

function asList(res) {
  if (Array.isArray(res)) return res;
  if (res && typeof res === 'object') {
    for (const k of Object.keys(res)) if (Array.isArray(res[k])) return res[k];
  }
  return [];
}

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const dayOf = (item) => {
  const d = item.calendarDate || item.date || item.summaryDate || item.calendar_date;
  return typeof d === 'string' ? d.slice(0, 10) : null;
};

// ---- extraction (defensive: Garmin's exact field names are checked in debug runs) ----
function fromDailySummaries(res, out) {
  for (const item of asList(res)) {
    const d = dayOf(item);
    if (!d) continue;
    const rec = (out[d] = out[d] || {});
    const steps = num(item.totalSteps) ?? num(item.steps);
    if (steps !== null) rec.steps = Math.round(steps);
    const bat = num(item.bodyBatteryHighestValue) ?? num(item.bodyBatteryHighest) ?? num(item.bodyBatteryMostRecentValue);
    if (bat !== null) rec.battery = Math.round(bat);
  }
}

function fromSteps(res, out) {
  for (const item of asList(res)) {
    const d = dayOf(item);
    if (!d) continue;
    const steps = num(item.values && item.values.totalSteps) ?? num(item.totalSteps) ?? num(item.steps);
    if (steps === null) continue;
    const rec = (out[d] = out[d] || {});
    if (rec.steps === undefined) rec.steps = Math.round(steps);
  }
}

function fromBodyBattery(res, out) {
  for (const item of asList(res)) {
    const d = dayOf(item);
    if (!d) continue;
    let hi = num(item.bodyBatteryHighestValue);
    if (hi === null && Array.isArray(item.bodyBatteryValuesArray)) {
      const vals = item.bodyBatteryValuesArray
        .map((p) => (Array.isArray(p) ? num(p[1]) : null))
        .filter((x) => x !== null);
      if (vals.length) hi = Math.max(...vals);
    }
    if (hi === null) continue;
    const rec = (out[d] = out[d] || {});
    if (rec.battery === undefined) rec.battery = Math.round(hi);
  }
}

function typeKeyOf(item) {
  const t = item.activityType;
  if (t && typeof t === 'object') return String(t.typeKey || t.key || '').toLowerCase();
  return String(t || item.activityTypeKey || '').toLowerCase();
}

// One record per activity id, so re-reading the same days never double counts a run.
function fromActivities(list, runs, typesSeen) {
  for (const item of list) {
    const type = typeKeyOf(item);
    typesSeen[type || 'unknown'] = (typesSeen[type || 'unknown'] || 0) + 1;
    if (!RUN_TYPES.has(type)) continue;
    const id = item.activityId ?? item.id;
    const start = item.startTimeLocal || item.startTimeGMT || item.startTime;
    if (id === undefined || id === null || typeof start !== 'string') continue;
    const distance = num(item.distance);       // metres
    const duration = num(item.duration) ?? num(item.elapsedDuration);   // seconds
    if (distance === null || duration === null) continue;
    const rec = { date: start.slice(0, 10), distance: Math.round(distance), duration: Math.round(duration), type };
    const hr = num(item.averageHR) ?? num(item.averageHeartRate);
    if (hr !== null) rec.avgHr = Math.round(hr);
    const elev = num(item.elevationGain);
    if (elev !== null) rec.elevation = Math.round(elev);
    const cal = num(item.calories);
    if (cal !== null) rec.calories = Math.round(cal);
    runs[String(id)] = rec;
  }
}

// ---- Firestore (REST; the project's rules allow this collection) ----
function fsValue(v) {
  if (typeof v === 'string') return { stringValue: v };
  return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
}
const fsMap = (obj) => ({ mapValue: { fields: Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fsValue(v)])) } });
const maskPath = (root, key) => `updateMask.fieldPaths=${encodeURIComponent(root + '.`' + key + '`')}`;

async function writeFirestore(days, runs) {
  const dates = Object.keys(days).filter((d) => Object.keys(days[d]).length);
  const runIds = Object.keys(runs);
  if (!dates.length && !runIds.length) return { dates: 0, runs: 0 };
  const fields = { updatedAt: { integerValue: String(Date.now()) } };
  const mask = ['updateMask.fieldPaths=updatedAt'];
  if (dates.length) {
    fields.days = { mapValue: { fields: Object.fromEntries(dates.map((d) => [d, fsMap(days[d])])) } };
    dates.forEach((d) => mask.push(maskPath('days', d)));
  }
  if (runIds.length) {
    fields.runs = { mapValue: { fields: Object.fromEntries(runIds.map((id) => [id, fsMap(runs[id])])) } };
    runIds.forEach((id) => mask.push(maskPath('runs', id)));
  }
  const res = await fetch(`${DOC_URL}?${mask.join('&')}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`Saving to Firestore failed (HTTP ${res.status}) ${(await res.text()).slice(0, 200)}`);
  return { dates: dates.length, runs: runIds.length };
}

async function main() {
  const health = rangeFor(DAYS_BACK);
  const runRange = rangeFor(RUN_DAYS_BACK);
  console.log(`Steps/body battery: ${health.start} to ${health.end}. Runs: ${runRange.start} to ${runRange.end}.`);
  const token = await getToken();
  const days = {};
  const runs = {};
  const typesSeen = {};
  let okCount = 0;
  let shownShape = {};

  async function attempt(name, path, extract) {
    try {
      const res = await garminGet(token, path);
      okCount++;
      if (DEBUG && !shownShape[name]) { shownShape[name] = true; console.log(`[${name}] response shape:`, JSON.stringify(shape(res), null, 1)); }
      extract(res);
      return res;
    } catch (e) {
      console.warn(`[${name}] ${e.message}`);
      return null;
    }
  }

  for (const [s, e] of chunks(health.start, health.end)) {
    await attempt('daily summaries', `/usersummary-service/v2/dailysummaries?startDate=${s}&endDate=${e}`, (r) => fromDailySummaries(r, days));
    await attempt('steps', `/usersummary-service/stats/steps/daily/${s}/${e}`, (r) => fromSteps(r, days));
    await attempt('body battery', `/wellness-service/wellness/bodyBattery/reports/daily?startDate=${s}&endDate=${e}`, (r) => fromBodyBattery(r, days));
  }

  // Activities: page through everything in the range and keep the runs.
  const PAGE = 100;
  for (let start = 0; start < 1000; start += PAGE) {
    const path = `/activitylist-service/activities/search/activities?start=${start}&limit=${PAGE}&startDate=${runRange.start}&endDate=${runRange.end}`;
    const res = await attempt('activities', path, (r) => fromActivities(asList(r), runs, typesSeen));
    if (!res || asList(res).length < PAGE) break;
  }

  if (!okCount) throw new Error('None of the Garmin requests worked.');
  console.log('Activity types seen:', Object.keys(typesSeen).length ? Object.entries(typesSeen).map(([k, v]) => `${k}×${v}`).join(', ') : 'none');
  const daySummary = Object.keys(days).sort().map((d) => `${d}: ${Object.keys(days[d]).join('+') || 'nothing'}`);
  console.log('Days with data:', daySummary.length ? daySummary.join(' | ') : 'none');
  console.log('Runs found:', Object.keys(runs).length);
  const written = await writeFirestore(days, runs);
  console.log(`Saved ${written.dates} day(s) and ${written.runs} run(s) to the app.`);
}

main().catch((e) => {
  console.error('Sync failed:', e.message);
  process.exit(1);
});
