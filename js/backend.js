/* Holy Hostel PMS — Supabase backend.
 * Gives the app the same small database / user / download interface it had on claude.ai
 * (window.claude.use("db" | "user" | "downloads" | "mcp")), backed by Supabase.
 *
 * Devices: the first time a tablet opens the PMS it asks for a device name and a setup code (once).
 * After that it opens straight to the front desk — no login. Codes are set in Supabase (README step 3).
 */
(() => {
  "use strict";
  const CFG = window.HOLY_CONFIG || {};
  const configured = CFG.supabaseUrl && CFG.supabaseAnonKey && !/YOUR[-_]/i.test(CFG.supabaseUrl + CFG.supabaseAnonKey);

  /* ---------- tiny UI for first-time device setup ---------- */
  const css = `
  #dev-gate{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:20px;background:var(--bg,#F2F5F4);font-family:var(--f-body,system-ui,sans-serif);color:var(--ink,#14201C)}
  #dev-gate .card{width:min(440px,100%);background:var(--surface,#fff);border:1px solid var(--line,#DAE1DE);border-radius:12px;padding:22px;display:flex;flex-direction:column;gap:14px;box-shadow:0 10px 40px rgba(0,0,0,.08)}
  #dev-gate h1{font-family:var(--f-display,system-ui);font-size:1.35rem;margin:0}
  #dev-gate p{margin:0;color:var(--muted,#5C6A65);line-height:1.45}
  #dev-gate label{display:flex;flex-direction:column;gap:5px;font-size:.85rem;font-weight:500;color:var(--muted,#5C6A65)}
  #dev-gate input{font:inherit;font-size:16px;padding:11px 12px;border:1px solid var(--line,#DAE1DE);border-radius:8px;background:var(--surface,#fff);color:var(--ink,#14201C)}
  #dev-gate button{font:inherit;font-weight:600;font-size:1rem;padding:12px;border-radius:8px;border:0;background:var(--accent,#0E6A59);color:var(--accent-ink,#fff);cursor:pointer}
  #dev-gate button:disabled{opacity:.6}
  #dev-gate .err{color:var(--bad,#B3261E);background:var(--bad-soft,#F9DEDC);border-radius:8px;padding:8px 10px;font-size:.9rem}
  #dev-gate .mark{display:inline-grid;place-items:center;width:34px;height:34px;border-radius:8px;background:var(--accent,#0E6A59);color:var(--accent-ink,#fff);font-weight:700;font-size:1.1rem}`;
  const style = document.createElement("style"); style.textContent = css; document.head.appendChild(style);

  function gateUI(html) {
    let el = document.getElementById("dev-gate");
    if (!el) { el = document.createElement("div"); el.id = "dev-gate"; document.body.appendChild(el); }
    el.innerHTML = `<div class="card">${html}</div>`;
    return el;
  }
  const closeGate = () => { const el = document.getElementById("dev-gate"); if (el) el.remove(); };
  const escHtml = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  if (!configured) {
    const show = () => gateUI(`<span class="mark">H</span><h1>Almost there</h1><p>This copy of the PMS isn't connected to Supabase yet. Put your project URL and anon key in <b>config.js</b> and deploy again (README step 4).</p>`);
    document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", show) : show();
    window.claude = { use: async () => null };
    return;
  }

  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: "holy-pms-device" },
  });
  window.__sb = sb;

  let me = null; // { uid, name, role }

  // Names devices automatically (shown as "taken by" on payments), e.g. "iPad 3F2A".
  function deviceName() {
    const ua = navigator.userAgent;
    const kind = /iPad|Macintosh.*Mobile|Macintosh(?=.*Safari)(?=.*Version)/.test(ua) && navigator.maxTouchPoints > 1 ? "iPad"
      : /iPhone/.test(ua) ? "iPhone" : /Android/.test(ua) ? (/Mobile/.test(ua) ? "Android phone" : "Android tablet")
      : /Windows/.test(ua) ? "Windows PC" : /Mac/.test(ua) ? "Mac" : "Device";
    return kind + " " + Math.random().toString(16).slice(2, 6).toUpperCase();
  }
  function askSetup(uid) {
    return new Promise(resolve => {
      const draw = (err) => {
        const el = gateUI(`<span class="mark">H</span><h1>Holy Hostel PMS</h1>
          <p>Enter the access code once on this device. After that it opens straight to the front desk.</p>
          ${err ? `<div class="err">${escHtml(err)}</div>` : ""}
          <label>Access code<input id="dg-code" type="password" inputmode="numeric" autocomplete="off" placeholder="Enter code"></label>
          <button id="dg-go">Open PMS</button>`);
        const go = async () => {
          const c = el.querySelector("#dg-code").value.trim();
          if (!c) return draw("Enter the access code.");
          el.querySelector("#dg-go").disabled = true;
          const { data: role, error } = await sb.rpc("claim_device", { code: c, device_name: deviceName() });
          if (error) return draw(error.message || "Couldn't open the PMS on this device.");
          if (!role) return draw("Wrong code. Try again.");
          const { data } = await sb.from("devices").select("uid,name,role").eq("uid", uid).maybeSingle();
          resolve(data);
        };
        el.querySelector("#dg-go").onclick = go;
        el.querySelector("#dg-code").onkeydown = e => { if (e.key === "Enter") go(); };
        setTimeout(() => el.querySelector("#dg-code")?.focus(), 50);
      };
      draw("");
    });
  }

  async function gate() {
    await new Promise(r => document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", r) : r());
    let { data: { session } } = await sb.auth.getSession();
    if (!session) {
      const { data, error } = await sb.auth.signInAnonymously();
      if (error) {
        gateUI(`<span class="mark">H</span><h1>Can't connect</h1><p>${escHtml(error.message)}</p><p>Check the internet connection, and that Anonymous sign-ins are switched on in Supabase (README step 2).</p><button onclick="location.reload()">Try again</button>`);
        throw error;
      }
      session = data.session;
    }
    const uid = session.user.id;
    let { data: row, error } = await sb.from("devices").select("uid,name,role").eq("uid", uid).maybeSingle();
    if (error) {
      gateUI(`<span class="mark">H</span><h1>Can't connect</h1><p>${escHtml(error.message)}</p><button onclick="location.reload()">Try again</button>`);
      throw error;
    }
    if (!row) row = await askSetup(uid);
    closeGate();
    me = { uid, name: row.name, role: row.role };
    window.__device = me;
  }
  const ready = gate();

  /* ---------- database adapter (same calls the app used on claude.ai) ---------- */
  const rid = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "") : Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 20);
  const split = path => { const p = path.split("/"); const id = p.pop(); return [p.join("/"), id]; };
  const fail = (error, fallback) => {
    const e = new Error(error?.message || fallback || "Database error");
    const m = String(error?.message || "") + " " + String(error?.code || "");
    e.code = /row-level security|permission|42501|not found|P0002/i.test(m) ? "invalid_argument" : /fetch|network|Failed to fetch|timeout/i.test(m) ? "unavailable" : (error?.code || "unknown");
    return e;
  };
  const OPS = { "==": "eq", "!=": "neq", ">": "gt", ">=": "gte", "<": "lt", "<=": "lte" };
  const snapOf = (id, data) => ({ id, exists: data !== undefined && data !== null, data: () => data ?? undefined });
  const listSnap = rows => { const docs = rows.map(r => snapOf(r.id, r.data)); return { docs, size: docs.length, empty: !docs.length, forEach: f => docs.forEach(f) }; };

  // Live updates: one realtime channel per collection; listeners re-read when anything in it changes.
  const watchers = new Map(); // collection -> { channel, fns:Set }
  function watch(collection, fn) {
    let w = watchers.get(collection);
    if (!w) {
      w = { fns: new Set(), channel: null };
      w.channel = sb.channel("docs:" + collection + ":" + rid())
        .on("postgres_changes", { event: "*", schema: "public", table: "docs", filter: "collection=eq." + collection }, () => w.fns.forEach(f => f()))
        .subscribe();
      watchers.set(collection, w);
    }
    w.fns.add(fn);
    return () => { w.fns.delete(fn); if (!w.fns.size) { sb.removeChannel(w.channel); watchers.delete(collection); } };
  }
  // Tablets sleep and drop the live connection: re-read everything when they wake up or come back online.
  const wakers = new Set();
  const wake = () => wakers.forEach(f => f());
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") wake(); });
  addEventListener("online", wake);
  addEventListener("focus", wake);

  function liveListener(load, next, error, collection) {
    let alive = true, t = null;
    const run = () => { if (!alive) return; clearTimeout(t); t = setTimeout(async () => { try { const s = await load(); if (alive) next(s); } catch (e) { if (alive && error) error(e); } }, 120); };
    run();
    const unWatch = watch(collection, run);
    wakers.add(run);
    return () => { alive = false; clearTimeout(t); unWatch(); wakers.delete(run); };
  }

  function docRef(path) {
    const [collection, id] = split(path);
    const get = async () => {
      const { data, error } = await sb.from("docs").select("data").eq("collection", collection).eq("id", id).maybeSingle();
      if (error) throw fail(error);
      return snapOf(id, data ? data.data : undefined);
    };
    return {
      id, path,
      get,
      set: async d => {
        const { error } = await sb.from("docs").upsert({ collection, id, data: d ?? {}, updated_at: new Date().toISOString() });
        if (error) throw fail(error);
      },
      update: async d => {
        const { error } = await sb.rpc("doc_merge", { p_collection: collection, p_id: id, p_patch: d ?? {} });
        if (error) throw fail(error);
      },
      delete: async () => {
        const { error } = await sb.from("docs").delete().eq("collection", collection).eq("id", id);
        if (error) throw fail(error);
      },
      onSnapshot: (next, error) => liveListener(get, next, error, collection),
      acquire: async () => ({ acquired: true }),
      collection: c => query(path + "/" + c),
    };
  }

  function query(collection, filters = []) {
    const load = async () => {
      const out = [];
      for (let from = 0; ; from += 1000) {
        let q = sb.from("docs").select("id,data").eq("collection", collection);
        for (const [f, op, v] of filters) q = q.filter("data->>" + f, OPS[op] || "eq", String(v));
        const { data, error } = await q.order("id").range(from, from + 999);
        if (error) throw fail(error);
        out.push(...data);
        if (data.length < 1000) break;
      }
      return listSnap(out);
    };
    const q = {
      where: (f, op, v) => query(collection, filters.concat([[f, op, v]])),
      orderBy: () => q, limit: () => q,
      doc: id => docRef(collection + "/" + (id || rid())),
      add: async d => { const r = docRef(collection + "/" + rid()); await r.set(d); return r; },
      get: load,
      onSnapshot: (next, error) => liveListener(load, next, error, collection),
    };
    return q;
  }
  const db = { collection: c => query(c), doc: p => docRef(p) };

  /* ---------- who is using it ---------- */
  const user = {
    id: async () => me.uid,
    canEdit: async () => me.role === "admin",
    can: async () => true,
    profiles: async ids => {
      const uuids = [...new Set(ids)].filter(x => /^[0-9a-f-]{36}$/i.test(x || ""));
      if (!uuids.length) return {};
      const { data } = await sb.from("devices").select("uid,name").in("uid", uuids);
      const out = {}; (data || []).forEach(r => out[r.uid] = { name: r.name }); return out;
    },
  };

  /* ---------- file downloads (invoice, PDF, Excel, CSV) ---------- */
  const MIME = { pdf: "application/pdf", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", csv: "text/csv", html: "text/html", json: "application/json", txt: "text/plain" };
  const downloads = {
    save: async ({ filename, data }) => {
      const ext = String(filename).split(".").pop().toLowerCase();
      const blob = data instanceof Blob ? data : new Blob([data], { type: MIME[ext] || "application/octet-stream" });
      const url = URL.createObjectURL(blob), a = document.createElement("a");
      a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      return { status: "saved" };
    },
  };

  window.claude = {
    use: async name => {
      await ready;
      if (name === "db") return db;
      if (name === "user") return user;
      if (name === "downloads") return downloads;
      return null; // channel manager (mcp) is not used in the live version
    },
  };
})();
