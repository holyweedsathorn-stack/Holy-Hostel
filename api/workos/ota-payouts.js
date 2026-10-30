/* GET /api/workos/ota-payouts?date=YYYY-MM-DD&prop=sathorn
 * Weekly Airbnb / Booking.com payout summary for the Thursday email. Read only.
 * Reads the "Prepaid via OTA" payments on each booking, the same ones the PMS shows as
 * "awaiting collection" until the payout is recorded (Collect, or the Booking.com payout import).
 *   received: OTA payments collected in the 7 days before `date`
 *   expected: OTA payments still awaiting collection that were due by `date` + 7 days (overdue included)
 * Needs "Authorization: Bearer <WORKOS_API_SECRET>". */
"use strict";
const { authorize, send, docs, todayBkk, validDate, addDays, LIVE, bookingProp, unitLabel } = require("./_shared");

const CHANNELS = { airbnb: "Airbnb", booking: "Booking.com" };
const isOta = p => p && (p.mk === "ota" || (!p.mk && /ota/i.test(String(p.method || ""))));
const r2 = n => Math.round(n * 100) / 100;

module.exports = async (req, res) => {
  if (req.method !== "GET") return send(res, 405, { ok: false, code: "method_not_allowed" });
  if (!authorize(req, res)) return;
  const date = req.query && validDate(req.query.date) ? req.query.date : todayBkk();
  const prop = (req.query && req.query.prop) || "sathorn";
  const from = addDays(date, -7), until = addDays(date, 7);
  try {
    const [bookings, units] = await Promise.all([
      docs("bookings", ["data->>channel=in.(" + Object.keys(CHANNELS).join(",") + ")"]),
      docs("units"),
    ]);
    const unitsById = Object.fromEntries(units.map(u => [u.id, u]));
    const out = {};
    for (const [ch, label] of Object.entries(CHANNELS)) out[ch] = { label, received: [], expected: [], receivedTotal: 0, expectedTotal: 0 };

    for (const b of bookings) {
      if (!out[b.channel] || bookingProp(b, unitsById) !== prop) continue;
      for (const p of b.payments || []) {
        if (!isOta(p) || p.voided) continue;
        const row = {
          ref: b.ref || String(b.id).slice(-6).toUpperCase(), otaRef: b.otaRef || "", guestName: b.guestName || "",
          unit: unitLabel(unitsById[b.unitId]), checkIn: b.checkIn, checkOut: b.checkOut, amount: r2(+p.amount || 0),
        };
        const c = out[b.channel];
        if (p.status === "pending") {
          if (!LIVE(b.status)) continue; // a cancelled booking won't pay out
          const due = p.expDate || p.date || b.checkIn;
          if (!validDate(due) || due > until) continue;
          c.expected.push(Object.assign(row, { due, overdue: due < date }));
          c.expectedTotal += row.amount;
        } else if (validDate(p.date) && p.date >= from && p.date < date) {
          c.received.push(Object.assign(row, { paidOn: p.date, payoutId: p.payoutId || "" }));
          c.receivedTotal += row.amount;
        }
      }
    }
    for (const c of Object.values(out)) {
      c.received.sort((a, b) => a.paidOn.localeCompare(b.paidOn));
      c.expected.sort((a, b) => a.due.localeCompare(b.due));
      c.receivedTotal = r2(c.receivedTotal); c.expectedTotal = r2(c.expectedTotal);
    }
    send(res, 200, { ok: true, date, prop, receivedFrom: from, receivedUntil: addDays(date, -1), expectedUntil: until, channels: out });
  } catch (e) {
    console.error("[workos/ota-payouts]", e);
    send(res, 502, { ok: false, code: "pms_error", message: "Couldn't read the PMS right now." });
  }
};
