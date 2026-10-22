# Holy Hostel PMS

Front-desk and finance system for Holy Hostel (Sathorn). It's a static web app hosted on **Vercel**, with the data in **Supabase** (Postgres, plus live updates between tablets).

- No daily login. Each tablet is approved **once** with a setup code and then opens straight to the front desk.
- **Staff code** gives full front-desk use: bookings, check-in/out, Collect/Uncollect, import and reports.
- **Owner code** also unlocks Expenses, Setup (rooms, prices), month close, OTA invoice entry and full backups.
- Guest data (including passport photos) can only be read by approved devices. The public Supabase key on its own can't read anything.

---

## Going live — one-time setup (about 20 minutes)

### 1. Create the Supabase project
1. Go to [supabase.com](https://supabase.com) → **New project**.
2. Name it `holy-hostel-pms`.
3. Region: **Southeast Asia (Singapore)**.
4. Set a strong database password and save it in your password manager.

### 2. Switch on anonymous sign-ins
This is what lets tablets connect without a login.

**Authentication → Sign In / Providers → "Allow anonymous sign-ins" → ON → Save.**

### 3. Create the tables and load your data
In **SQL Editor → New query**:

1. Paste all of `supabase/schema.sql` → **Run**. You should see "Success. No rows returned".
2. Choose your two setup codes. Make them long and random (10+ characters), e.g. `desk-7Hq2-mPz9` and `owner-Kx4r-81Vt`. Run:
   ```sql
   insert into public.app_secrets (id, staff_code, admin_code)
   values (1, 'YOUR-STAFF-CODE', 'YOUR-OWNER-CODE')
   on conflict (id) do update set staff_code = excluded.staff_code, admin_code = excluded.admin_code;
   ```
3. Open the data file **`holy-hostel-data.seed.sql`** (sent separately — it is *not* in this repo because it contains guest details). Paste it all → **Run**.

   The last line says how many records were loaded: 1 settings, 18 rooms/beds, 377 bookings.

### 4. Connect the app to Supabase
1. In Supabase go to **Project Settings → API**. Copy the **Project URL** and the **anon / publishable key**.
2. Paste both into `config.js` in this repo and commit.

   > Never paste the `service_role` / secret key anywhere in this repo.

### 5. Deploy on Vercel
1. Go to [vercel.com](https://vercel.com) → **Add New → Project** → import this GitHub repo.
2. Use these settings:
   - Framework preset: **Other**
   - Build command: *(leave empty)*
   - Output directory: *(leave empty / `.`)*
3. **Deploy**. Every push to `main` redeploys automatically.
4. Optional: **Settings → Domains** → add e.g. `pms.yourdomain.com`.

### 6. Set up each device (once)
1. Open the Vercel link.
2. Enter a device name (e.g. *Front desk tablet 1*) and the **staff code**. On your own phone or laptop, use the **owner code**.
3. Add it to the home screen:
   - iPad / iPhone: Safari → Share → **Add to Home Screen**.
   - Android: Chrome → ⋮ → **Add to Home screen**.

Done. The device stays approved until you remove it. Clearing the browser's website data makes it ask for the code again.

---

## Work OS link (check-in / check-out from Holyweed Work OS)

Staff can check guests in and out from the Hostel section of the Work OS clock screen. Work OS reads today's arrivals and in-house guests from the PMS and marks the booking checked in / out here, so nobody types it twice. The tablets update live, and the booking's History says *"Checked in via Work OS (staff name)"*.

Two private endpoints do this. Only a server that knows the shared secret can use them:

| Endpoint | What it does |
|---|---|
| `GET /api/workos/front-desk?date=YYYY-MM-DD` | Today's arrivals (incl. late ones), in-house guests and who's due out. Guest name, room, dates, channel, balance. No phone, email, ID or photos. |
| `POST /api/workos/walk-in` | A guest checked in on Work OS by hand. If the PMS already has exactly one booking for them (same OTA booking number, or same name arriving now), that booking is checked in. Otherwise a new booking is created in Work OS's room/bed, already checked in: today → expected check-out (1 night if none), price = amount paid ÷ nights (or the room's normal price), a payment **to collect** is always added (Cash, PromptPay for a bank transfer, or Prepaid via OTA; the amount typed in Work OS, or the stay's total), so the booking has a *Collect* button; it counts as income once staff press it. Refused if that room or bed is already booked. Sending it twice never makes two bookings. |
| `POST /api/workos/booking-statuses` | `{ ids: [...] }` → the status of each booking. Work OS uses it to take guests off its hostel log once their booking is cancelled here. |
| `POST /api/workos/booking-status` | `{ bookingId, action: "check_in" \| "check_out", staffName, allowBalance }`. Early arrivals, early departures and closed months are refused (do those here in the PMS). Check-out with money owing needs `allowBalance: true`. |

Setup (once):
1. Supabase → SQL Editor: paste all of `supabase/schema.sql` again → **Run** (section 6 adds `workos_set_booking_status` and `workos_create_walk_in`). Run it again whenever this file changes.
2. Make a long random secret, e.g. run `openssl rand -hex 32`, or use a password manager's generator (64 characters).
3. Vercel → this project → **Settings → Environment Variables** (Production and Preview):
   - `WORKOS_API_SECRET` = the secret from step 2
   - `SUPABASE_URL` = the Project URL (same as `config.js`)
   - `SUPABASE_SERVICE_ROLE_KEY` = Supabase → Project Settings → API → **service_role / secret** key

   > This key can read and change everything. It goes **only** in Vercel's environment variables, never in `config.js` or any file in this repo.
4. Redeploy. In the Work OS Vercel project set `PMS_API_URL` (this site's address) and `PMS_API_SECRET` (the same secret).

To change the secret, update it in both Vercel projects and redeploy both.

---

## Day-to-day admin

| Task | How |
|---|---|
| See approved devices | SQL Editor: `select name, role, created_at, uid from public.devices order by created_at;` |
| Remove a lost/stolen device | `delete from auth.users where id = 'UID-FROM-ABOVE';` (it can no longer open the PMS) |
| Change the setup codes | Re-run the `insert into public.app_secrets …` query with new codes. Approved devices keep working. |
| Rename a device | `update public.devices set name = 'Front desk tablet 2' where uid = '…';` |
| Download a full backup | On an owner device open **`/backup`** → *Download backup*. Do this monthly and keep the file private. |

**Keep it active:** Supabase pauses free projects after 7 days with no use. Daily front-desk use keeps it awake. The Pro plan ($25/month) adds daily automatic backups and never pauses.

---

## Files

| Path | What it is |
|---|---|
| `index.html` | The whole PMS (screens, reports, imports) |
| `js/backend.js` | Connects the PMS to Supabase, handles the one-time device setup, live updates and downloads |
| `config.js` | Your Supabase URL + anon/publishable key |
| `supabase/schema.sql` | Tables, security rules, live-update setup |
| `backup.html` | Owner-only full data export |
| `api/workos/` | Private endpoints Work OS uses to check guests in/out (see *Work OS link*) |
| `vendor/supabase-2.99.3.js` | Supabase client library (MIT licence), bundled so the app doesn't depend on a CDN |
| `manifest.webmanifest`, `icons/` | Home-screen app icon and name |

The channel-manager (Channex) code is still in `index.html` but switched off (`CM_ON = false`). OTAs stay on Hoteliers Guru; use **Bookings → Import** for the Hoteliers Guru and Airbnb files.
