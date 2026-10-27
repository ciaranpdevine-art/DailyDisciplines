// Pulls your steps and body battery from Garmin's Personal API and stores them in
// Firestore (doc daily-disciplines/garmin-data) for the Health tab to display.
// Runs in GitHub Actions; the key comes from the GARMIN_API_KEY repository secret.

const API_KEY = process.env.GARMIN_API_KEY;
const HOST = process.env.GARMIN_HOST || 'https://personal.connectapi.garmin.com';
const PROJECT = 'daily-disciplines-b7819';
const DOC_URL = process.env.FIRESTORE_DOC_URL || `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/daily-disciplines/garmin-data`;
const DAYS_BACK = Math.max(1, Number(process.env.DAYS_BACK || 3));
const DEBUG = process.env.DEBUG_SHAPES === 'true';

if (!API_KEY) {
  console.error('GARMIN_API_KEY is not set. Add it under Settings > Secrets and variables > Actions.');
  process.exit(1);
}

// ---- dates (UK local days) ----
function ukDate(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function dateRange() {
  const end = new Date();
  const start = new Date(end.getTime() - (DAYS_BACK - 1) * 86400000);
  return { start: ukDate(start), end: ukDate(end) };
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
  // The token may come back as raw text or as JSON.
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
    for (const k of Object.keys(v).slice(0, 60)) out[k] = shape(v[k], depth + 1);
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

// ---- Firestore (REST; the project's rules allow this collection) ----
function fsValue(v) {
  return { integerValue: String(v) };
}

async function writeFirestore(days) {
  const dates = Object.keys(days).filter((d) => Object.keys(days[d]).length);
  if (!dates.length) return 0;
  const fields = {};
  const dayFields = {};
  for (const d of dates) {
    const f = {};
    for (const [k, v] of Object.entries(days[d])) f[k] = fsValue(v);
    dayFields[d] = { mapValue: { fields: f } };
  }
  fields.days = { mapValue: { fields: dayFields } };
  fields.updatedAt = { integerValue: String(Date.now()) };
  const mask = dates.map((d) => `updateMask.fieldPaths=${encodeURIComponent('days.`' + d + '`')}`);
  mask.push('updateMask.fieldPaths=updatedAt');
  const res = await fetch(`${DOC_URL}?${mask.join('&')}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`Saving to Firestore failed (HTTP ${res.status}) ${(await res.text()).slice(0, 200)}`);
  return dates.length;
}

async function main() {
  const { start, end } = dateRange();
  console.log(`Fetching ${start} to ${end}`);
  const token = await getToken();
  const out = {};
  const attempts = [
    ['daily summaries', `/usersummary-service/v2/dailysummaries?startDate=${start}&endDate=${end}`, fromDailySummaries],
    ['steps', `/usersummary-service/stats/steps/daily/${start}/${end}`, fromSteps],
    ['body battery', `/wellness-service/wellness/bodyBattery/reports/daily?startDate=${start}&endDate=${end}`, fromBodyBattery],
  ];
  let okCount = 0;
  for (const [name, path, extract] of attempts) {
    try {
      const res = await garminGet(token, path);
      okCount++;
      if (DEBUG) console.log(`[${name}] response shape:`, JSON.stringify(shape(res), null, 1));
      extract(res, out);
    } catch (e) {
      console.warn(`[${name}] ${e.message}`);
    }
  }
  if (!okCount) throw new Error('None of the Garmin requests worked.');
  const summary = Object.keys(out).sort().map((d) => `${d}: ${Object.keys(out[d]).join('+') || 'nothing'}`);
  console.log('Found data for:', summary.length ? summary.join(' | ') : 'no days');
  const written = await writeFirestore(out);
  console.log(`Saved ${written} day(s) to the app.`);
}

main().catch((e) => {
  console.error('Sync failed:', e.message);
  process.exit(1);
});
