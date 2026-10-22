/* Holy Hostel PMS — shared code for the Work OS endpoints (api/workos/*).
 * Files starting with "_" are not exposed as routes by Vercel.
 *
 * Needs these Vercel environment variables (never in the repo, see README "Work OS link"):
 *   WORKOS_API_SECRET          shared secret; Work OS sends it as "Authorization: Bearer …"
 *   SUPABASE_URL               same Project URL as config.js
 *   SUPABASE_SERVICE_ROLE_KEY  Supabase → Project Settings → API → service_role / secret key
 */
"use strict";
const crypto = require("crypto");

/* ---------- auth ---------- */
const sha = s => crypto.createHash("sha256").update(String(s)).digest();
// true when the request carries the shared secret; answers 401/500 itself otherwise
function authorize(req, res) {
  const secret = process.env.WORKOS_API_SECRET;
  if (!secret || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    send(res, 500, { ok: false, code: "not_configured", message: "The PMS isn't set up for Work OS yet (README: Work OS link)." });
    return false;
  }
  const m = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  if (!m || !crypto.timingSafeEqual(sha(m[1].trim()), sha(secret))) {
    send(res, 401, { ok: false, code: "unauthorized" });
    return false;
  }
  return true;
}
function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

/* ---------- Supabase (REST, service role: bypasses row-level security, server only) ---------- */
async function sb(path, init = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = Object.assign({ apikey: key, "Content-Type": "application/json" }, init.headers || {});
  if (/^eyJ/.test(key)) headers.Authorization = "Bearer " + key; // legacy JWT service_role key
  const r = await fetch(process.env.SUPABASE_URL.replace(/\/+$/, "") + "/rest/v1/" + path, Object.assign({}, init, { headers }));
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error((data && data.message) || "Supabase error " + r.status);
  return data;
}
// every doc in a collection matching PostgREST filters, e.g. ["data->>status=in.(confirmed,checked_in)"]
async function docs(collection, filters = []) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const q = ["select=id,data", "collection=eq." + encodeURIComponent(collection)].concat(filters, ["order=id", "limit=1000", "offset=" + from]);
    const rows = await sb("docs?" + q.join("&"));
    out.push(...rows.map(r => Object.assign({ id: r.id }, r.data)));
    if (rows.length < 1000) break;
  }
  return out;
}
async function doc(collection, id) {
  const rows = await sb("docs?select=id,data&collection=eq." + encodeURIComponent(collection) + "&id=eq." + encodeURIComponent(id));
  return rows.length ? Object.assign({ id: rows[0].id }, rows[0].data) : null;
}

/* ---------- same rules as index.html ---------- */
const DEF_CHANNELS = {
  walkin: "Walk-in", direct: "Direct (phone / LINE)", booking: "Booking.com", hostelworld: "Hostelworld",
  agoda: "Agoda", airbnb: "Airbnb", expedia: "Expedia", tripcom: "Trip.com",
};
function todayBkk() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
const validDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
const pad = n => String(n).padStart(2, "0");
function d2n(s) { const [y, m, d] = s.split("-").map(Number); return Math.round(Date.UTC(y, m - 1, d) / 864e5); }
function n2d(n) { const t = new Date(n * 864e5); return t.getUTCFullYear() + "-" + pad(t.getUTCMonth() + 1) + "-" + pad(t.getUTCDate()); }
const addDays = (s, k) => n2d(d2n(s) + k);
const nightsBetween = (a, b) => validDate(a) && validDate(b) ? d2n(b) - d2n(a) : 0;
const ymAdd = (ym, k) => { const [y, m] = ym.split("-").map(Number), t = y * 12 + (m - 1) + k; return Math.floor(t / 12) + "-" + pad(t % 12 + 1); };

const isCancel = s => s === "cancelled" || s === "void";
const LIVE = s => s !== "cancelled" && s !== "no_show" && s !== "void";
const isDisc = c => c && (c.kind === "discount" || (/^discount/i.test(c.desc || "") && +c.amount < 0));
const isIncome = p => p && p.status !== "pending" && !p.voided;

// balance owed, same maths as folio() in index.html
function balanceOf(b) {
  const n = Math.max(0, nightsBetween(b.checkIn, b.checkOut));
  const room = LIVE(b.status) ? n * (+b.rate || 0) : 0;
  const charges = isCancel(b.status) ? [] : (b.charges || []);
  const total = room + charges.reduce((s, c) => s + (+c.amount || 0), 0);
  const paid = (b.payments || []).filter(isIncome).reduce((s, p) => s + (+p.amount || 0), 0);
  return Math.round((total - paid) * 100) / 100;
}
const unitProp = u => (u && u.prop) || "sathorn";
const bookingProp = (b, unitsById) => b.prop || unitProp(unitsById[b.unitId]);
function monthsOf(ci, co) { const out = []; if (!validDate(ci) || !validDate(co)) return out; for (let ym = ci.slice(0, 7); ym <= addDays(co, -1).slice(0, 7); ym = ymAdd(ym, 1)) out.push(ym); return out; }
// closed months a status change on this booking would touch (lockHits in index.html)
function closedMonthsHit(b, unitsById, settings) {
  const c = ((settings && settings.closedMonths) || {})[bookingProp(b, unitsById)] || {};
  return monthsOf(b.checkIn, b.checkOut).filter(ym => c[ym]);
}

// what Work OS gets for each booking: only what the desk needs, no contact or ID details
function shape(b, unitsById, settings, date) {
  const u = unitsById[b.unitId];
  const labels = Object.assign({}, DEF_CHANNELS);
  for (const [k, v] of Object.entries((settings && settings.channels) || {})) if (v && v.label) labels[k] = v.label;
  return {
    id: b.id, ref: b.ref || String(b.id).slice(-6).toUpperCase(),
    guestName: b.guestName || "", guests: +b.guests || 1,
    checkIn: b.checkIn, checkOut: b.checkOut, nights: Math.max(0, nightsBetween(b.checkIn, b.checkOut)),
    status: b.status,
    late: b.status === "confirmed" && b.checkIn < date,
    dueOut: b.status === "checked_in" && b.checkOut <= date,
    channel: b.channel || "", channelLabel: labels[b.channel] || b.channel || "", otaRef: b.otaRef || "",
    unit: u ? { id: u.id, label: u.group ? u.group + " · " + u.name : u.name, type: u.type || "", group: u.group || "", name: u.name || "" }
            : { id: b.unitId || "", label: "Unassigned", type: "", group: "", name: "" },
    balance: balanceOf(b),
    notes: b.notes || "",
  };
}

// a unit's price for this many guests (unitRate in index.html)
function unitRate(u, guests) {
  if (!u) return 0;
  const base = +u.rate || 0, inc = Math.max(1, +u.baseOcc || (u.type === "dorm" ? 1 : 2));
  return base + Math.max(0, (guests || 1) - inc) * (+u.extraPerson || 0);
}
const unitLabel = u => (u ? (u.group ? u.group + " · " + u.name : u.name) : "Unassigned");
// Work OS names rooms by number ("202") and dorm beds by number ("201", bed "3").
// Find the one active PMS unit whose name has that room number (and bed number for a dorm bed).
function matchUnit(units, prop, roomNumber, bedNumber) {
  const room = String(roomNumber || "").trim(), bed = String(bedNumber || "").trim();
  if (!/^\d+$/.test(room)) return { error: "no_unit" };
  const hasNum = (text, n) => new RegExp("(^|\\D)" + n + "(\\D|$)").test(text || "");
  let hits = units.filter(u => u.active !== false && unitProp(u) === prop && hasNum((u.group || "") + " " + (u.name || ""), room));
  if (bed) {
    // the bed number is in the unit's own name ("Bed 3", "B3", "3"), not in its room/dorm name
    const beds = hits.filter(u => new RegExp("(^|\\D)" + bed + "(\\D|$)").test(String(u.name || "").replace(new RegExp(room, "g"), "")));
    if (beds.length) hits = beds;
    else if (hits.length > 1) return { error: "no_unit" };
  }
  if (hits.length === 1) return { unit: hits[0] };
  return { error: hits.length ? "ambiguous_unit" : "no_unit" };
}

module.exports = {
  authorize, send, sb, docs, doc, todayBkk, validDate, addDays, nightsBetween, LIVE, balanceOf, bookingProp,
  closedMonthsHit, shape, unitRate, unitLabel, unitProp, matchUnit,
};
