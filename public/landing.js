// Landing page behaviour: reveal-on-scroll, mobile menu, animated product mock, auth-aware nav.

const $ = (s) => document.querySelector(s);
const API = String(window.GRAB_API || "").replace(/\/$/, "");

/* reveal on scroll */
const io = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
}, { threshold: 0.12 });
document.querySelectorAll(".reveal").forEach((el) => io.observe(el));

/* mobile menu */
const burger = $("#burger"), menu = $("#mobile-menu");
burger.addEventListener("click", () => {
  const open = menu.hidden;
  menu.hidden = !open;
  burger.setAttribute("aria-expanded", String(open));
});
menu.addEventListener("click", (e) => { if (e.target.tagName === "A") { menu.hidden = true; burger.setAttribute("aria-expanded", "false"); } });

/* animated download in the hero mock — loops: 0 → 100%, merging, completed, pause, restart */
(function animateMock() {
  const fill = $("#mock-fill"), pct = $("#mock-pct"), stat = $("#mock-stat");
  if (!fill || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  let p = 0, phase = "video";
  const speeds = ["27.1", "28.4", "26.9", "29.3", "31.0"];
  const tick = () => {
    if (phase === "video" || phase === "audio") {
      p += 1.6 + Math.random() * 1.4;
      if (p >= 100) { p = 100; phase = phase === "video" ? "audio-wait" : "merge"; }
      const shown = phase === "audio" ? 50 + p / 2 : p / 2;
      fill.style.width = `${Math.min(100, shown)}%`;
      pct.textContent = `${Math.floor(Math.min(100, shown))}%`;
      const left = Math.max(0, Math.round((100 - p) / 12));
      stat.textContent = `${phase === "video" ? "Video" : "Audio"} stream · ${speeds[Math.floor(Math.random() * speeds.length)]} MB/s · 00:${String(left).padStart(2, "0")} left`;
      return setTimeout(tick, 120);
    }
    if (phase === "audio-wait") { phase = "audio"; p = 0; return setTimeout(tick, 200); }
    if (phase === "merge") { fill.style.width = "100%"; pct.textContent = "100%"; stat.textContent = "Merging video and audio"; phase = "done"; return setTimeout(tick, 1400); }
    if (phase === "done") { fill.classList.add("done"); stat.textContent = "Completed · 168.7 MB"; stat.style.color = "var(--ok)"; phase = "reset"; return setTimeout(tick, 3200); }
    fill.classList.remove("done"); fill.style.width = "0%"; pct.textContent = "0%"; stat.style.color = ""; p = 0; phase = "video";
    setTimeout(tick, 600);
  };
  setTimeout(tick, 1200);
})();

/* animate the compare bars when visible */
const cmp = $(".compare");
if (cmp) {
  cmp.querySelectorAll(".compare-bar div").forEach((d) => { d.dataset.w = d.style.width; d.style.width = "0"; });
  new IntersectionObserver((es, o) => {
    if (es.some((e) => e.isIntersecting)) { cmp.querySelectorAll(".compare-bar div").forEach((d) => (d.style.width = d.dataset.w)); o.disconnect(); }
  }, { threshold: 0.3 }).observe(cmp);
}

/* auth-aware nav: show "Log in" only when the server has Firebase sign-in enabled */
fetch(`${API}/api/health`).then((r) => r.json()).then((h) => {
  if (h?.auth?.firebase) for (const id of ["nav-login", "mobile-login", "foot-login"]) $(`#${id}`).hidden = false;
}).catch(() => {});
