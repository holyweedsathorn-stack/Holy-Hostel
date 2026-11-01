/* POST /api/workos/extend
 * Body: { bookingId, checkOut, amountThb, paymentMethod, staffName }
 * "Extend" (or shorten) pressed on Work OS: move the PMS booking's check-out date, refused if the room
 * or bed is booked by someone else in the new nights or a closed month would change. An extension
 * payment goes on as "to collect", like every Work OS payment. Needs "Authorization: Bearer <WORKOS_API_SECRET>". */
"use strict";
const crypto = require("crypto");
const { authorize, send, sb, doc, docs, todayBkk, validDate, monthsOf, bookingProp, shape, unitLabel } = require("./_shared");

const PAY = {
  cash: { mk: "cash", method: "Cash", note: "Extension, taken in Work OS" },
  bank_transfer: { mk: "promptpay", method: "PromptPay", note: "Extension, bank transfer recorded in Work OS" },
  ota_collect: { mk: "ota", method: "Prepaid via OTA", note: "Extension, expected from the booking site (Work OS)" },
};
const fd = s => new Date(s + "T00:00:00Z").toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short" });

module.exports = async (req, res) => {
  if (req.method !== "POST") return send(res, 405, { ok: false, code: "method_not_allowed" });
  if (!authorize(req, res)) return;
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
  const { bookingId, checkOut, paymentMethod, staffName } = body || {};
  if (typeof bookingId !== "string" || !bookingId || !validDate(checkOut)) {
    return send(res, 400, { ok: false, code: "bad_request", message: "Send bookingId and the new checkOut date." });
  }
  try {
    const [b, settings] = await Promise.all([doc("bookings", bookingId), doc("settings", "main")]);
    if (!b) return send(res, 404, { ok: false, code: "not_found", message: "That booking isn't in the PMS." });
    const units = b.unitId ? await docs("units", ["id=eq." + encodeURIComponent(b.unitId)]) : [];
    const unitsById = Object.fromEntries(units.map(u => [u.id, u]));
    const out = x => shape(x, unitsById, settings, todayBkk());

    // closed months the old or the new stay touches (lockHits in index.html)
    const c = ((settings && settings.closedMonths) || {})[bookingProp(b, unitsById)] || {};
    const closed = [...new Set(monthsOf(b.checkIn, b.checkOut).concat(monthsOf(b.checkIn, checkOut)))].filter(ym => c[ym]);
    if (checkOut !== b.checkOut && closed.length) {
      return send(res, 409, { ok: false, code: "month_closed", message: "This stay is in a closed month (" + closed.join(", ") + "). The owner has to change it in the PMS." });
    }

    const amount = Math.round(Math.max(0, +body.amountThb || 0) * 100) / 100;
    const p = PAY[paymentMethod] || PAY.cash;
    const payment = amount > 0 ? {
      id: crypto.randomBytes(4).toString("hex"), mk: p.mk, method: p.method, amount, note: p.note,
      status: "pending", date: todayBkk(), expDate: todayBkk(), createdAt: new Date().toISOString(), by: null,
    } : null;

    const r = await sb("rpc/workos_extend_booking", {
      method: "POST",
      body: JSON.stringify({ p_id: bookingId, p_check_out: checkOut, p_payment: payment, p_staff: typeof staffName === "string" ? staffName : "" }),
    });
    const after = r.booking ? Object.assign({ id: bookingId }, r.booking) : b;
    if (r.result === "ok") return send(res, 200, { ok: true, booking: out(after) });
    if (r.result === "already") return send(res, 200, { ok: true, already: true, booking: out(after) });
    if (r.result === "not_found") return send(res, 404, { ok: false, code: "not_found", message: "That booking isn't in the PMS." });
    if (r.result === "room_taken") {
      const x = r.clash || {};
      return send(res, 409, { ok: false, code: "room_taken", message: `${unitLabel(unitsById[b.unitId])} is booked for ${x.guestName || "another guest"} from ${fd(x.checkIn)} in the PMS, so the stay can't run to ${fd(checkOut)}. Move the booking in the PMS first.` });
    }
    if (r.result === "bad_date") return send(res, 400, { ok: false, code: "bad_request", message: "The new check-out has to be after the check-in date." });
    return send(res, 409, { ok: false, code: "wrong_status", message: "This booking is " + String(after.status || "").replace("_", " ") + " in the PMS, so it can't be changed." });
  } catch (e) {
    console.error("[workos/extend]", e);
    send(res, 502, { ok: false, code: "pms_error", message: "Couldn't update the PMS right now." });
  }
};
