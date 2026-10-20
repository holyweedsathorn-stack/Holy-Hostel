/* POST /api/workos/booking-status
 * Body: { bookingId, action: "check_in" | "check_out", staffName, allowBalance }
 * Marks a booking checked in / out from Work OS. Needs "Authorization: Bearer <WORKOS_API_SECRET>".
 * Anything that changes dates or money (early arrival, early departure, closed month) is refused:
 * staff do those in the PMS, where the usual prompts handle them. */
"use strict";
const { authorize, send, sb, doc, docs, todayBkk, balanceOf, closedMonthsHit, shape } = require("./_shared");

const NEED = { check_in: "confirmed", check_out: "checked_in" };

module.exports = async (req, res) => {
  if (req.method !== "POST") return send(res, 405, { ok: false, code: "method_not_allowed" });
  if (!authorize(req, res)) return;
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
  const { bookingId, action, staffName, allowBalance } = body || {};
  if (typeof bookingId !== "string" || !bookingId || !(action in NEED)) {
    return send(res, 400, { ok: false, code: "bad_request", message: "Send bookingId and action (check_in or check_out)." });
  }
  try {
    const [b, settings] = await Promise.all([doc("bookings", bookingId), doc("settings", "main")]);
    if (!b) return send(res, 404, { ok: false, code: "not_found", message: "That booking isn't in the PMS." });
    const units = b.unitId ? await docs("units", ["id=eq." + encodeURIComponent(b.unitId)]) : [];
    const unitsById = Object.fromEntries(units.map(u => [u.id, u]));
    const today = todayBkk();
    const out = x => shape(x, unitsById, settings, today);
    const refuse = (code, message, extra) => send(res, 409, Object.assign({ ok: false, code, message, booking: out(b) }, extra || {}));

    // checks only apply when the change would actually happen; repeats fall through to "already"
    if (b.status === NEED[action]) {
      if (action === "check_in" && b.checkIn > today) return refuse("early_arrival", "This guest is booked from a later date. Check them in early in the PMS.");
      if (action === "check_out" && b.checkOut > today) return refuse("early_departure", "This guest is leaving early. Check them out in the PMS so the stay can be shortened.");
      const closed = closedMonthsHit(b, unitsById, settings);
      if (closed.length) return refuse("month_closed", "This stay is in a closed month (" + closed.join(", ") + "). The owner has to do this in the PMS.");
      const balance = balanceOf(b);
      if (action === "check_out" && balance > 0 && allowBalance !== true) return refuse("balance_due", "This guest still owes ฿" + balance.toFixed(2) + ".", { balance });
    }

    const r = await sb("rpc/workos_set_booking_status", {
      method: "POST",
      body: JSON.stringify({ p_id: bookingId, p_action: action, p_staff: typeof staffName === "string" ? staffName : "" }),
    });
    const after = r.booking ? Object.assign({ id: bookingId }, r.booking) : b;
    if (r.result === "ok") return send(res, 200, { ok: true, booking: out(after) });
    if (r.result === "already") return send(res, 200, { ok: true, already: true, booking: out(after) });
    if (r.result === "not_found") return send(res, 404, { ok: false, code: "not_found", message: "That booking isn't in the PMS." });
    return send(res, 409, { ok: false, code: "wrong_status", message: "This booking is " + String(after.status || "").replace("_", " ") + " in the PMS.", booking: out(after) });
  } catch (e) {
    console.error("[workos/booking-status]", e);
    send(res, 502, { ok: false, code: "pms_error", message: "Couldn't update the PMS right now." });
  }
};
