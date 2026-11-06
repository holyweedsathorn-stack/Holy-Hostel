/* POST /api/workos/cancel
 * Body: { bookingId, reason, staffName, allowIncome }
 * "Cancel booking" pressed on Work OS: the PMS booking is cancelled exactly like the PMS's own Cancel
 * booking (red, crossed out, payments voided, room freed). If money was already collected, it is only
 * removed from income when allowIncome is true -- otherwise the answer is "income_collected" with the
 * amount, so Work OS can ask staff first. Closed months are refused (the owner does it in the PMS).
 * Needs "Authorization: Bearer <WORKOS_API_SECRET>". */
"use strict";
const { authorize, send, sb, doc, docs, todayBkk, closedMonthsHit, shape } = require("./_shared");

const baht = n => "฿" + (Math.round(n * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

module.exports = async (req, res) => {
  if (req.method !== "POST") return send(res, 405, { ok: false, code: "method_not_allowed" });
  if (!authorize(req, res)) return;
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
  const { bookingId, staffName, allowIncome } = body || {};
  const reason = typeof (body || {}).reason === "string" ? body.reason.trim().slice(0, 200) : "";
  if (typeof bookingId !== "string" || !bookingId || !reason) {
    return send(res, 400, { ok: false, code: "bad_request", message: "Send bookingId and a reason." });
  }
  try {
    const [b, settings] = await Promise.all([doc("bookings", bookingId), doc("settings", "main")]);
    if (!b) return send(res, 404, { ok: false, code: "not_found", message: "That booking isn't in the PMS." });
    const units = b.unitId ? await docs("units", ["id=eq." + encodeURIComponent(b.unitId)]) : [];
    const unitsById = Object.fromEntries(units.map(u => [u.id, u]));
    const out = x => shape(x, unitsById, settings, todayBkk());

    if (b.status !== "cancelled" && b.status !== "void") {
      const closed = closedMonthsHit(b, unitsById, settings);
      if (closed.length) return send(res, 409, { ok: false, code: "month_closed", message: "This stay is in a closed month (" + closed.join(", ") + "). The owner has to cancel it in the PMS.", booking: out(b) });
    }

    const r = await sb("rpc/workos_cancel_booking", {
      method: "POST",
      body: JSON.stringify({ p_id: bookingId, p_reason: reason, p_staff: typeof staffName === "string" ? staffName : "", p_allow_income: allowIncome === true }),
    });
    const after = r.booking ? Object.assign({ id: bookingId }, r.booking) : b;
    if (r.result === "ok") return send(res, 200, { ok: true, booking: out(after), incomeRemoved: +r.income || 0 });
    if (r.result === "already") return send(res, 200, { ok: true, already: true, booking: out(after) });
    if (r.result === "not_found") return send(res, 404, { ok: false, code: "not_found", message: "That booking isn't in the PMS." });
    if (r.result === "income_collected") {
      const amount = +r.income || 0;
      return send(res, 409, { ok: false, code: "income_collected", amount, message: `${baht(amount)} was already collected on this booking. Cancelling removes it from income (give the money back to the guest if it was really received).`, booking: out(after) });
    }
    return send(res, 502, { ok: false, code: "pms_error", message: "Couldn't cancel the booking in the PMS right now." });
  } catch (e) {
    console.error("[workos/cancel]", e);
    send(res, 502, { ok: false, code: "pms_error", message: "Couldn't cancel the booking in the PMS right now." });
  }
};
