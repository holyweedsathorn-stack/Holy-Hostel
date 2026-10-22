/* POST /api/workos/booking-statuses
 * Body: { ids: ["bookingId", ...] }  (up to 300)
 * The current status of each PMS booking Work OS has a hostel-log entry for, so Work OS can take
 * a guest off its log once the booking is cancelled here. Bookings that don't exist are left out.
 * Needs "Authorization: Bearer <WORKOS_API_SECRET>". */
"use strict";
const { authorize, send, docs } = require("./_shared");

const MAX_IDS = 300;

module.exports = async (req, res) => {
  if (req.method !== "POST") return send(res, 405, { ok: false, code: "method_not_allowed" });
  if (!authorize(req, res)) return;
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
  const ids = Array.isArray(body && body.ids)
    ? [...new Set(body.ids.filter(id => typeof id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(id)))]
    : null;
  if (!ids || ids.length > MAX_IDS) return send(res, 400, { ok: false, code: "bad_request", message: `Send ids: up to ${MAX_IDS} booking ids.` });
  if (!ids.length) return send(res, 200, { ok: true, statuses: {} });
  try {
    const rows = await docs("bookings", ["id=in.(" + ids.map(encodeURIComponent).join(",") + ")"]);
    send(res, 200, { ok: true, statuses: Object.fromEntries(rows.map(b => [b.id, b.status || ""])) });
  } catch (e) {
    console.error("[workos/booking-statuses]", e);
    send(res, 502, { ok: false, code: "pms_error", message: "Couldn't read the PMS right now." });
  }
};
