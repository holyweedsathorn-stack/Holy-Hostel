/* POST /api/workos/walk-in
 * A guest checked in on Work OS by hand (not picked from the PMS arrivals list).
 * Body: { stayId, guestName, roomNumber, bedNumber, checkIn, checkOut, bookingSource,
 *         paymentMethod, amountThb, otaRef, notes, staffName }
 * Needs "Authorization: Bearer <WORKOS_API_SECRET>".
 *
 * - If exactly one PMS booking is already waiting for this guest (same OTA booking number, or same
 *   name arriving now), that booking is checked in instead of making a second one.
 * - Otherwise a new booking is created in the same shape the PMS saves its own bookings
 *   (saveBooking in index.html), already checked in, so it shows on the calendar and in reports.
 *   Money staff typed in Work OS goes on as a "to collect" payment (cash, or PromptPay for a bank
 *   transfer); it counts as income once staff press Collect in the PMS, like any other booking.
 * - The Work OS stay id is stored on the booking, so sending the same walk-in again never creates two. */
"use strict";
const crypto = require("crypto");
const {
  authorize, send, sb, docs, doc, todayBkk, validDate, addDays, nightsBetween,
  bookingProp, closedMonthsHit, shape, unitRate, unitLabel, matchUnit,
} = require("./_shared");

// Work OS booking source -> PMS channel
const CHANNEL = {
  booking_com: "booking", agoda: "agoda", airbnb: "airbnb", hostelworld: "hostelworld",
  expedia: "expedia", trip_com: "tripcom", direct: "walkin", other: "walkin",
};
const MAX_NIGHTS = 90;
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const norm = s => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
const fd = s => new Date(s + "T00:00:00Z").toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short" });
const baht = n => "฿" + (Math.round(n * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

module.exports = async (req, res) => {
  if (req.method !== "POST") return send(res, 405, { ok: false, code: "method_not_allowed" });
  if (!authorize(req, res)) return;
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
  body = body || {};

  const stayId = str(body.stayId, 64);
  if (!/^[0-9a-f-]{32,36}$/i.test(stayId)) return send(res, 400, { ok: false, code: "bad_request", message: "Send the Work OS stayId." });
  const today = todayBkk();
  const checkIn = validDate(body.checkIn) && body.checkIn <= today && body.checkIn >= addDays(today, -60) ? body.checkIn : today;
  let checkOut = validDate(body.checkOut) && body.checkOut > checkIn ? body.checkOut : addDays(checkIn, 1); // no date: 1 night
  if (nightsBetween(checkIn, checkOut) > MAX_NIGHTS) checkOut = addDays(checkIn, MAX_NIGHTS);
  const staff = str(body.staffName, 80);
  const otaRef = str(body.otaRef, 60);
  const prop = "sathorn";
  const now = new Date().toISOString();

  try {
    const [units, settings, mine, open] = await Promise.all([
      docs("units"),
      doc("settings", "main"),
      docs("bookings", ["data->>workosStayId=eq." + encodeURIComponent(stayId)]),
      // bookings that could be this same guest: waiting to arrive now, or (by OTA number) anything live
      docs("bookings", ["data->>status=in.(confirmed,checked_in)", "data->>checkOut=gt." + checkIn]),
    ]);
    const unitsById = Object.fromEntries(units.map(u => [u.id, u]));
    const out = b => shape(b, unitsById, settings, today);

    // Sent before: answer with the same booking, never a second one.
    if (mine.length) return send(res, 200, { ok: true, already: true, booking: out(mine[0]) });

    // 1. Already in the PMS? Check that booking in rather than adding a duplicate.
    const here = open.filter(b => bookingProp(b, unitsById) === prop);
    let match = otaRef ? here.filter(b => String(b.otaRef || "") === otaRef) : [];
    if (!match.length && norm(body.guestName)) {
      match = here.filter(b => b.status === "confirmed" && b.checkIn <= checkIn && norm(b.guestName) === norm(body.guestName));
    }
    if (match.length > 1) {
      return send(res, 409, { ok: false, code: "duplicate_guest", message: `The PMS has ${match.length} bookings for ${str(body.guestName, 200) || "this guest"} right now. Pick the right one from "Today in the PMS".` });
    }
    if (match.length === 1) {
      const b = match[0];
      if (b.status === "confirmed") {
        const closed = closedMonthsHit(b, unitsById, settings);
        if (closed.length) return send(res, 409, { ok: false, code: "month_closed", message: "This stay is in a closed month (" + closed.join(", ") + "). The owner has to do this in the PMS." });
        const r = await sb("rpc/workos_set_booking_status", { method: "POST", body: JSON.stringify({ p_id: b.id, p_action: "check_in", p_staff: staff }) });
        if (r.result !== "ok" && r.result !== "already") return send(res, 409, { ok: false, code: "wrong_status", message: "That PMS booking can't be checked in right now." });
      }
      await sb("rpc/doc_merge", { method: "POST", body: JSON.stringify({ p_collection: "bookings", p_id: b.id, p_patch: { workosStayId: stayId } }) });
      const fresh = await doc("bookings", b.id);
      return send(res, 200, { ok: true, linked: true, booking: out(fresh || b) });
    }

    // 2. New booking: which room / bed?
    const m = matchUnit(units, prop, body.roomNumber, body.bedNumber);
    const place = "room " + str(String(body.roomNumber ?? ""), 20) + (str(String(body.bedNumber ?? ""), 20) ? ", bed " + str(String(body.bedNumber), 20) : "");
    if (m.error) {
      return send(res, 409, { ok: false, code: m.error, message: m.error === "ambiguous_unit"
        ? `More than one PMS room matches ${place}. Add the booking in the PMS.`
        : `No PMS room matches ${place}. Add the booking in the PMS.` });
    }
    const u = m.unit;
    const nights = nightsBetween(checkIn, checkOut);
    const amount = Math.round(Math.max(0, +body.amountThb || 0) * 100) / 100;
    const rate = amount > 0 ? Math.round(amount / nights * 100) / 100 : unitRate(u, 1);
    const draft = { checkIn, checkOut, unitId: u.id, prop };
    const closed = closedMonthsHit(draft, unitsById, settings);
    if (closed.length) return send(res, 409, { ok: false, code: "month_closed", message: "These dates are in a closed month (" + closed.join(", ") + "). The owner has to add this booking in the PMS." });

    // Money taken at the desk: a "to collect" payment, exactly like the payment field on the PMS's own
    // New booking (saveBooking in index.html). It isn't income until staff press Collect in the PMS.
    // The PMS has no bank-transfer method; its own payKey() files "transfer" under PromptPay.
    const mk = body.paymentMethod === "cash" ? "cash" : body.paymentMethod === "bank_transfer" ? "promptpay" : null;
    const payments = mk && amount > 0 ? [{
      id: crypto.randomBytes(4).toString("hex"), mk, method: mk === "cash" ? "Cash" : "PromptPay", amount,
      note: mk === "cash" ? "Taken at check-in (Work OS)" : "Bank transfer, recorded at check-in (Work OS)",
      status: "pending", date: checkIn, createdAt: now, by: null,
    }] : [];
    const id = "wos" + stayId.replace(/-/g, "").toLowerCase();
    const who = staff ? ` (${staff})` : "";
    const history = [{ at: now, by: null, action: "Walk-in from Work OS, checked in" + who }]
      .concat(payments.map(p => ({ at: now, by: null, action: `Expected payment ${baht(p.amount)} by ${p.method} (not collected yet)` })));
    const booking = {
      guestName: str(body.guestName, 200) || "Walk-in guest", phone: "", email: "", nationality: "", idNumber: "",
      checkIn, checkOut, guests: 1, rate, channel: CHANNEL[body.bookingSource] || "walkin", otaRef, notes: str(body.notes, 1000),
      unitId: u.id, prop, status: "checked_in", ref: id.slice(-6).toUpperCase(), groupId: null,
      charges: [], payments, createdAt: now, createdBy: null, checkedInAt: now,
      history, updatedAt: now, updatedBy: null, source: "workos", workosStayId: stayId,
    };

    const r = await sb("rpc/workos_create_walk_in", { method: "POST", body: JSON.stringify({ p_id: id, p_doc: booking }) });
    if (r.result === "ok") return send(res, 200, { ok: true, created: true, booking: out(Object.assign({ id }, r.booking)) });
    if (r.result === "already") return send(res, 200, { ok: true, already: true, booking: out(Object.assign({ id }, r.booking)) });
    if (r.result === "room_taken") {
      const c = r.clash || {};
      return send(res, 409, { ok: false, code: "room_taken", message: `${unitLabel(u)} is booked for ${c.guestName || "another guest"} (${fd(c.checkIn)} → ${fd(c.checkOut)}) in the PMS. Pick another room or bed.` });
    }
    return send(res, 502, { ok: false, code: "pms_error", message: "Couldn't add the booking to the PMS right now." });
  } catch (e) {
    console.error("[workos/walk-in]", e);
    send(res, 502, { ok: false, code: "pms_error", message: "Couldn't add the booking to the PMS right now." });
  }
};
