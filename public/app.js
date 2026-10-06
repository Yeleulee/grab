const $ = (sel) => document.querySelector(sel);

let hosted = false; // set from /api/health; true when running on a remote server (e.g. Render)

const els = {
  form: $("#url-form"),
  input: $("#url-input"),
  fetchBtn: $("#fetch-btn"),
  pasteBtn: $("#paste-btn"),
  clearBtn: $("#clear-btn"),
  error: $("#url-error"),
  skeleton: $("#skeleton"),
  preview: $("#preview"),
  videoOptions: $("#video-options"),
  audioOptions: $("#audio-options"),
  downloadBtn: $("#download-btn"),
  ctaNote: $("#cta-note"),
  jobs: $("#jobs"),
  jobsEmpty: $("#jobs-empty"),
  jobsCount: $("#jobs-count"),
  engine: $("#engine-status"),
  engineText: $(".engine-text"),
  engineVersion: $("#engine-version"),
  downloadDir: $("#download-dir"),
  menu: $("#menu"),
  menuBtn: $("#menu-btn"),
  toasts: $("#toasts"),
};

let info = null;
let selection = null; // { kind: "video", height } | { kind: "mp3" } | { kind: "m4a" }
const jobs = new Map();
const streams = new Map();

/* ---------- utils ---------- */
const fmtBytes = (n) => {
  if (n == null) return "—";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i >= 2 ? 1 : 0)} ${u[i]}`;
};
const fmtDuration = (s) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return (h ? `${h}:${String(m).padStart(2, "0")}` : m) + ":" + String(sec).padStart(2, "0");
};
const fmtNumber = (n) => (n == null ? "—" : new Intl.NumberFormat().format(n));
const fmtDate = (yyyymmdd) => {
  if (!yyyymmdd || yyyymmdd.length !== 8) return "—";
  const d = new Date(`${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6)}`);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path, { method, body } = {}) {
  const res = await fetch(path, {
    method: method ?? (body ? "POST" : "GET"),
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg, type = "info", ms = 4000) {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  els.toasts.appendChild(el);
  setTimeout(() => { el.classList.add("leaving"); setTimeout(() => el.remove(), 220); }, ms);
}

function setBusy(btn, busy, label) {
  btn.disabled = busy;
  const span = btn.querySelector(".btn-label");
  if (busy) {
    btn.dataset.label = span.textContent;
    span.innerHTML = `<span class="spinner"></span>${label}`;
  } else {
    span.textContent = btn.dataset.label ?? label;
  }
}

/* ---------- theme ---------- */
const savedTheme = localStorage.getItem("theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
document.documentElement.dataset.theme = savedTheme;
$("#theme-btn").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("theme", next);
});

/* ---------- settings menu ---------- */
const closeMenu = () => { els.menu.hidden = true; els.menuBtn.setAttribute("aria-expanded", "false"); };
els.menuBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const open = els.menu.hidden;
  els.menu.hidden = !open;
  els.menuBtn.setAttribute("aria-expanded", String(open));
});
document.addEventListener("click", (e) => { if (!els.menu.hidden && !els.menu.contains(e.target)) closeMenu(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });

const openFolder = () => api("/api/open-folder", { method: "POST" }).catch((e) => toast(e.message, "error"));
$("#open-folder-btn").addEventListener("click", openFolder);
$("#open-folder-link").addEventListener("click", openFolder);

$("#update-engine-btn").addEventListener("click", async (e) => {
  const b = e.currentTarget;
  b.disabled = true; b.textContent = "Updating…";
  try {
    const r = await api("/api/update-engine", { method: "POST" });
    toast(r.output.split("\n").filter(Boolean).pop() || "yt-dlp updated", "ok", 6000);
    loadHealth();
  } catch (err) { toast(err.message, "error"); }
  finally { b.disabled = false; b.textContent = "Update yt-dlp"; }
});

$("#clear-finished-btn").addEventListener("click", async () => {
  await api("/api/jobs/finished", { method: "DELETE" }).catch(() => {});
  for (const [id, j] of jobs) if (j.status !== "running") jobs.delete(id);
  renderJobs();
  closeMenu();
});

async function loadHealth() {
  try {
    const h = await api("/api/health");
    els.engine.className = `engine ${h.ok ? "ok" : "bad"}`;
    els.engineText.textContent = h.ok ? "Engine ready" : "Engine missing";
    els.engineVersion.textContent = h.ytdlpVersion ? `yt-dlp ${h.ytdlpVersion} · ffmpeg` : "yt-dlp not found";
    els.downloadDir.textContent = h.downloadDir;
    if (h.hosted) {
      hosted = true;
      for (const id of ["open-folder-btn", "open-folder-link"]) $(`#${id}`).style.display = "none";
      els.downloadDir.textContent = "Server (temporary) — use Save to keep files";
      $("#footer-note").textContent = "Hosted server. Files are temporary — Save them to your device.";
      renderJobs();
    }
    if (!h.ok) toast("yt-dlp or ffmpeg is missing from bin/ — downloads won't work.", "error", 8000);
  } catch {
    els.engine.className = "engine bad";
    els.engineText.textContent = "Server unreachable";
  }
}
loadHealth();

/* ---------- url input ---------- */
const syncFieldButtons = () => { els.clearBtn.hidden = !els.input.value; els.pasteBtn.hidden = !!els.input.value; };
els.input.addEventListener("input", syncFieldButtons);
els.clearBtn.addEventListener("click", () => { els.input.value = ""; syncFieldButtons(); els.input.focus(); });
els.pasteBtn.addEventListener("click", async () => {
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (text) { els.input.value = text; syncFieldButtons(); els.form.requestSubmit(); }
  } catch { els.input.focus(); toast("Clipboard access was blocked — use Ctrl+V.", "info"); }
});
els.input.addEventListener("paste", () => setTimeout(() => { syncFieldButtons(); if (/youtu\.?be/.test(els.input.value)) els.form.requestSubmit(); }, 0));

els.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  els.error.hidden = true;
  els.preview.hidden = true;
  els.skeleton.hidden = false;
  setBusy(els.fetchBtn, true, "Fetching");
  try {
    info = await api("/api/info", { body: { url: els.input.value } });
    renderPreview(info);
  } catch (err) {
    els.error.textContent = err.message;
    els.error.hidden = false;
  } finally {
    els.skeleton.hidden = true;
    setBusy(els.fetchBtn, false, "Fetch");
  }
});

/* ---------- preview ---------- */
let codecPref = localStorage.getItem("codec") === "h264" ? "h264" : "best";
const optionFor = (q) => (codecPref === "h264" && q.h264 ? q.h264 : q.best);

function renderVideoOptions(v) {
  const rec = v.qualities.find((q) => q.height <= 1080) ?? v.qualities[0];
  els.videoOptions.innerHTML = v.qualities
    .map((q) => {
      const o = optionFor(q);
      const modern = o.codec !== "H.264";
      return `
      <button class="fmt" role="radio" aria-checked="false" data-kind="video" data-height="${q.height}">
        <span class="radio"></span>
        <span class="fmt-label">${q.label}${q === rec ? `<span class="tag good">Recommended</span>` : ""}</span>
        <span class="fmt-codec">${o.codec}${o.tbr ? ` · ${o.tbr} kbps` : ""}${modern ? " · modern player" : ""}</span>
        <span class="fmt-size mono">${fmtBytes(o.sizeEstimate)}</span>
      </button>`;
    })
    .join("");
  const anyH264 = v.qualities.some((q) => q.h264);
  $("#codec-pref").hidden = !anyH264;
  document.querySelectorAll("#codec-pref .seg").forEach((b) => b.classList.toggle("active", b.dataset.codec === codecPref));
}

function renderPreview(v) {
  $("#thumb").src = v.thumbnail;
  $("#title").textContent = v.title;
  $("#channel").textContent = v.channel || "—";
  $("#duration").textContent = fmtDuration(v.duration);
  $("#views").textContent = fmtNumber(v.view_count);
  $("#uploaded").textContent = fmtDate(v.upload_date);

  renderVideoOptions(v);
  els.audioOptions.innerHTML = v.audio
    .map((a) => `
      <button class="fmt" role="radio" aria-checked="false" data-kind="${a.kind}">
        <span class="radio"></span>
        <span class="fmt-label">${a.label}${a.abr ? `<span class="tag">${a.abr} kbps</span>` : ""}</span>
        <span class="fmt-codec">${esc(a.note)}</span>
        <span class="fmt-size mono">${fmtBytes(a.sizeEstimate)}</span>
      </button>`)
    .join("");

  const rec = v.qualities.find((q) => q.height <= 1080) ?? v.qualities[0];
  setMode("video");
  if (rec) select({ kind: "video", height: rec.height });
  els.preview.hidden = false;
  els.preview.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

$("#codec-pref").addEventListener("click", (e) => {
  const b = e.target.closest(".seg");
  if (!b || !info) return;
  codecPref = b.dataset.codec;
  localStorage.setItem("codec", codecPref);
  renderVideoOptions(info);
  if (selection?.kind === "video") select(selection);
});

function setMode(m) {
  document.querySelectorAll(".filter").forEach((t) => {
    const on = t.dataset.mode === m;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", String(on));
  });
  els.videoOptions.hidden = m !== "video";
  els.audioOptions.hidden = m !== "audio";
  $("#codec-pref").hidden = m !== "video" || !info?.qualities.some((q) => q.h264);
  if (m === "audio" && selection?.kind === "video") select({ kind: "mp3" });
  if (m === "video" && selection?.kind !== "video") {
    const rec = info?.qualities.find((q) => q.height <= 1080) ?? info?.qualities[0];
    if (rec) select({ kind: "video", height: rec.height });
  }
}

function select(sel) {
  selection = sel;
  document.querySelectorAll(".fmt").forEach((b) => {
    const on = b.dataset.kind === sel.kind && (sel.kind !== "video" || Number(b.dataset.height) === sel.height);
    b.setAttribute("aria-checked", String(on));
  });
  const label = els.downloadBtn.querySelector(".btn-label");
  if (sel.kind === "video") {
    const q = info.qualities.find((x) => x.height === sel.height);
    const o = q ? optionFor(q) : null;
    label.textContent = `Download ${q?.label ?? sel.height + "p"} MP4`;
    els.ctaNote.textContent = o?.sizeEstimate ? `About ${fmtBytes(o.sizeEstimate)} · ${o.codec}` : "";
  } else {
    const a = info.audio.find((x) => x.kind === sel.kind);
    label.textContent = `Download ${sel.kind.toUpperCase()}`;
    els.ctaNote.textContent = a?.sizeEstimate ? `About ${fmtBytes(a.sizeEstimate)}` : "";
  }
}

document.querySelectorAll(".filter").forEach((t) => t.addEventListener("click", () => setMode(t.dataset.mode)));
els.preview.addEventListener("click", (e) => {
  const b = e.target.closest(".fmt");
  if (!b) return;
  select(b.dataset.kind === "video" ? { kind: "video", height: Number(b.dataset.height) } : { kind: b.dataset.kind });
});

/* ---------- download ---------- */
els.downloadBtn.addEventListener("click", async () => {
  if (!info || !selection) return;
  setBusy(els.downloadBtn, true, "Starting");
  try {
    const job = await api("/api/download", {
      body: { url: info.webpage_url, kind: selection.kind, height: selection.height, codec: codecPref, title: info.title, thumbnail: info.thumbnail },
    });
    upsert(job);
    watch(job.id);
  } catch (err) {
    toast(err.message, "error");
  } finally {
    setBusy(els.downloadBtn, false);
  }
});

function upsert(job) {
  const prev = jobs.get(job.id);
  jobs.set(job.id, job);
  renderJobs();
  if (prev?.status === "running" && job.status !== "running") {
    if (job.status === "done") toast(`Saved · ${job.fileName}`, "ok", 5000);
    else if (job.status === "error") toast(`Failed · ${job.error}`, "error", 7000);
  }
}

function watch(id) {
  if (streams.has(id)) return;
  const es = new EventSource(`/api/jobs/${id}/events`);
  streams.set(id, es);
  es.onmessage = (e) => {
    const job = JSON.parse(e.data);
    upsert(job);
    if (job.status !== "running") { es.close(); streams.delete(id); }
  };
  es.onerror = () => { es.close(); streams.delete(id); };
}

function stageText(j) {
  const p = j.progress || {};
  if (j.status === "done") return `<span class="s-done">Completed</span>`;
  if (j.status === "error") return `<span class="s-error">Failed</span>`;
  if (j.status === "cancelled") return "Cancelled";
  if (p.stage === "merging") return "Merging video and audio";
  if (p.stage === "converting") return "Converting audio";
  const pct = Math.min(100, Math.floor(p.percent || 0));
  const bits = [`<span class="pct">${pct}%</span>`];
  if (p.parts > 1) bits.push(p.part === 1 ? "Video stream" : "Audio stream");
  if (p.speed && !/Unknown/.test(p.speed)) bits.push(p.speed.replace("iB", "B"));
  if (p.eta && !/Unknown/.test(p.eta)) bits.push(`${p.eta} left`);
  return bits.join(" · ");
}

function renderJobs() {
  const list = [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  els.jobsEmpty.hidden = list.length > 0;
  const running = list.filter((j) => j.status === "running").length;
  els.jobsCount.textContent = list.length ? (running ? `${running} active / ${list.length}` : String(list.length)) : "";

  els.jobs.innerHTML = list
    .map((j) => {
      const p = j.progress || {};
      const pct = j.status === "running" ? Math.min(100, p.percent || 0) : 100;
      const indeterminate = j.status === "running" && (p.stage === "merging" || p.stage === "converting" || (!p.percent && !p.totalSize));
      const label = j.kind === "video" ? `${j.height}p MP4${j.codec === "h264" ? " · H.264" : ""}` : j.kind.toUpperCase();
      const actions =
        j.status === "running"
          ? `<button class="btn small ghost" data-act="cancel" data-id="${j.id}">Cancel</button>`
          : j.status === "done" && j.fileExists
            ? hosted
              ? `<a class="btn small secondary" href="/api/jobs/${j.id}/file" title="Download the file to this device">Save</a>
               <button class="btn small ghost" data-act="remove" data-id="${j.id}" aria-label="Remove">Remove</button>`
              : `<button class="btn small secondary" data-act="reveal" data-id="${j.id}">Show in folder</button>
               <a class="btn small ghost" href="/api/jobs/${j.id}/file" title="Save a copy via the browser">Save</a>
               <button class="btn small ghost" data-act="remove" data-id="${j.id}" aria-label="Remove">Remove</button>`
            : `<button class="btn small ghost" data-act="remove" data-id="${j.id}" aria-label="Remove">Remove</button>`;
      const thumb = j.thumbnail
        ? `<img class="job-thumb" src="${esc(j.thumbnail)}" alt="" loading="lazy" />`
        : `<div class="job-thumb job-thumb-ph"><svg viewBox="0 0 24 24" width="18" height="18"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" d="M15 10l5-3v10l-5-3M3 7h12v10H3z"/></svg></div>`;
      return `
        <li class="job ${j.status}">
          ${thumb}
          <div class="job-body">
            <div class="job-head">
              <div class="job-title" title="${esc(j.title)}">${esc(j.title || j.url)}</div>
              <span class="badge mono">${label}</span>
              <div class="job-actions">${actions}</div>
            </div>
            <div class="bar ${indeterminate ? "indeterminate" : ""}"><div style="width:${pct}%"></div></div>
            <div class="job-stats">
              <span>${stageText(j)}</span>
              <span class="mono">${j.status === "done" ? fmtBytes(j.fileSize) : (p.totalSize ?? "").replace("iB", "B")}</span>
            </div>
            ${j.error ? `<div class="job-error">${esc(j.error)}</div>` : ""}
            ${j.fileName && j.status === "done" ? `<div class="job-file mono" title="${esc(j.fileName)}">${esc(j.fileName)}${j.fileExists ? "" : " — file moved or deleted"}</div>` : ""}
          </div>
        </li>`;
    })
    .join("");
}

els.jobs.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const { act, id } = b.dataset;
  b.disabled = true;
  try {
    if (act === "cancel") upsert(await api(`/api/jobs/${id}/cancel`, { method: "POST" }));
    else if (act === "reveal") await api(`/api/jobs/${id}/reveal`, { method: "POST" });
    else if (act === "remove") { await api(`/api/jobs/${id}`, { method: "DELETE" }); jobs.delete(id); renderJobs(); }
  } catch (err) { toast(err.message, "error"); b.disabled = false; }
});

/* ---------- restore history ---------- */
api("/api/jobs")
  .then((list) => { list.forEach((j) => { jobs.set(j.id, j); if (j.status === "running") watch(j.id); }); renderJobs(); })
  .catch(() => renderJobs());

els.input.focus();
