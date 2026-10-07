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

/* hero video (rendered by scripts/render-hero.mjs): always autoplays muted, pauses only while off screen */
(function heroVideo() {
  const v = $(".hero-video");
  if (!v) return;
  // Browsers only allow autoplay when muted; set the property too, since the attribute alone isn't always honoured.
  v.muted = true;
  v.defaultMuted = true;
  v.playsInline = true;
  let onScreen = true;
  const play = () => { if (onScreen && !document.hidden) v.play().catch(() => {}); };
  new IntersectionObserver((es) => {
    for (const e of es) { onScreen = e.isIntersecting; onScreen ? play() : v.pause(); }
  }, { threshold: 0 }).observe(v);
  document.addEventListener("visibilitychange", play);
  // If autoplay was still blocked (e.g. data saver / low-power mode), start on the first interaction.
  for (const ev of ["pointerdown", "touchstart", "keydown", "scroll"]) addEventListener(ev, play, { once: true, passive: true });
  if (v.readyState >= 2) play(); else v.addEventListener("canplay", play, { once: true });
})();

/* animate the compare bars when visible */
const cmp = $(".compare");
if (cmp) {
  cmp.querySelectorAll(".compare-bar div").forEach((d) => { d.dataset.w = d.style.width; d.style.width = "0"; });
  new IntersectionObserver((es, o) => {
    if (es.some((e) => e.isIntersecting)) { cmp.querySelectorAll(".compare-bar div").forEach((d) => (d.style.width = d.dataset.w)); o.disconnect(); }
  }, { threshold: 0.3 }).observe(cmp);
}

/* auth-aware nav: show "Log in" only when the server has Firebase sign-in enabled (retry while it wakes up) */
(async function probe() {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const r = await fetch(`${API}/api/health`, { cache: "no-store" });
      if (r.ok) {
        const h = await r.json();
        if (h?.auth?.firebase) for (const id of ["nav-login", "mobile-login", "foot-login"]) $(`#${id}`).hidden = false;
        return;
      }
    } catch {}
    await new Promise((res) => setTimeout(res, 5000));
  }
})();
