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

/* hero video (rendered by scripts/render-hero.mjs): respect reduced motion, only play while on screen */
(function heroVideo() {
  const v = $(".hero-video");
  if (!v) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) { v.removeAttribute("autoplay"); v.pause(); v.controls = true; return; }
  new IntersectionObserver((es) => {
    for (const e of es) e.isIntersecting ? v.play().catch(() => {}) : v.pause();
  }, { threshold: 0.25 }).observe(v);
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
