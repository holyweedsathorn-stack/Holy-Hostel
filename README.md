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
| `vendor/supabase-2.99.3.js` | Supabase client library (MIT licence), bundled so the app doesn't depend on a CDN |
| `manifest.webmanifest`, `icons/` | Home-screen app icon and name |

The channel-manager (Channex) code is still in `index.html` but switched off (`CM_ON = false`). OTAs stay on Hoteliers Guru; use **Bookings → Import** for the Hoteliers Guru and Airbnb files.
