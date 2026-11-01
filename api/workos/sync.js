/* POST /api/workos/sync
 * Body: { ids: ["bookingId", ...] }  (bookings Work OS already has on its hostel log, up to 300)
 * Everything Work OS needs to keep its hostel log the same as the PMS:
 *   - every booking checked in right now,
 *   - bookings checked out in the last few days (so a guest checked in and out on the PMS
 *     while nobody had Work OS open still reaches its log),
 *   - the current state of each booking in `ids` (cancelled, moved, dates changed, ...).
 * The PMS is the source of truth for status, dates and room. Needs "Authorization: Bearer <WORKOS_API_SECRET>". */
"use strict";
const { authorize, send, docs, doc, todayBkk, addDays, bookingProp, shape } = require("./_shared");

const MAX_IDS = 300;
const RECENT_DAYS = 3;

module.exports = async (req, res) => {
  if (req.method !== "POST") return send(res, 405, { ok: false, code: "method_not_allowed" });
  if (!authorize(req, res)) return;
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
  const raw = body && body.ids === undefined ? [] : body && body.ids;
  const ids = Array.isArray(raw) ? [...new Set(raw.filter(id => typeof id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(id)))] : null;
  if (!ids || ids.length > MAX_IDS) return send(res, 400, { ok: false, code: "bad_request", message: `Send ids: up to ${MAX_IDS} booking ids.` });

  const today = todayBkk(), since = addDays(today, -RECENT_DAYS), prop = "sathorn";
  try {
    const [units, settings, inHouse, recentOut, linked] = await Promise.all([
      docs("units"),
      doc("settings", "main"),
      docs("bookings", ["data->>status=eq.checked_in"]),
      docs("bookings", ["data->>status=eq.checked_out", "data->>checkOut=gte." + since]),
      ids.length ? docs("bookings", ["id=in.(" + ids.map(encodeURIComponent).join(",") + ")"]) : [],
    ]);
    const unitsById = Object.fromEntries(units.map(u => [u.id, u]));
    const byId = new Map();
    for (const b of linked) byId.set(b.id, b); // linked ones whatever their status or property
    for (const b of inHouse.concat(recentOut)) if (bookingProp(b, unitsById) === prop) byId.set(b.id, b);
    send(res, 200, {
      ok: true, date: today,
      bookings: [...byId.values()].map(b => Object.assign(shape(b, unitsById, settings, today), { workosStayId: b.workosStayId || null })),
    });
  } catch (e) {
    console.error("[workos/sync]", e);
    send(res, 502, { ok: false, code: "pms_error", message: "Couldn't read the PMS right now." });
  }
};
