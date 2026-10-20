/* GET /api/workos/front-desk?date=YYYY-MM-DD&prop=sathorn
 * Today's arrivals and in-house guests for the Work OS check-in screen.
 * Same lists as the PMS "Today" screen (vTodayLive in index.html). Needs "Authorization: Bearer <WORKOS_API_SECRET>". */
"use strict";
const { authorize, send, docs, doc, todayBkk, validDate, bookingProp, shape } = require("./_shared");

module.exports = async (req, res) => {
  if (req.method !== "GET") return send(res, 405, { ok: false, code: "method_not_allowed" });
  if (!authorize(req, res)) return;
  const date = req.query && validDate(req.query.date) ? req.query.date : todayBkk();
  const prop = (req.query && req.query.prop) || "sathorn";
  try {
    const [bookings, units, settings] = await Promise.all([
      docs("bookings", ["data->>status=in.(confirmed,checked_in)", "data->>checkIn=lte." + date]),
      docs("units"),
      doc("settings", "main"),
    ]);
    const unitsById = Object.fromEntries(units.map(u => [u.id, u]));
    const mine = bookings.filter(b => bookingProp(b, unitsById) === prop);
    const out = b => shape(b, unitsById, settings, date);
    const byIn = (a, b) => (a.checkIn || "").localeCompare(b.checkIn || "") || (a.guestName || "").localeCompare(b.guestName || "");
    send(res, 200, {
      ok: true, date, prop,
      // not yet checked in: arriving today, plus late arrivals whose stay hasn't ended
      arrivals: mine.filter(b => b.status === "confirmed" && (b.checkIn === date || b.checkOut > date)).sort(byIn).map(out),
      inHouse: mine.filter(b => b.status === "checked_in").sort(byIn).map(out),
      checkedInToday: mine.filter(b => b.status === "checked_in" && b.checkIn === date).sort(byIn).map(out),
    });
  } catch (e) {
    console.error("[workos/front-desk]", e);
    send(res, 502, { ok: false, code: "pms_error", message: "Couldn't read the PMS right now." });
  }
};
