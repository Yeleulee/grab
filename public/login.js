import { initFirebaseAuth } from "/auth.js";

const $ = (s) => document.querySelector(s);
const API = String(window.GRAB_API || "").replace(/\/$/, "");

// Where to go after sign-in. Only same-origin paths are allowed (no open redirect).
const params = new URLSearchParams(location.search);
const rawNext = params.get("next") || "/app";
const next = /^\/(?!\/)/.test(rawNext) ? rawNext : "/app";

const els = {
  title: $("#title"), subtitle: $("#subtitle"), ui: $("#auth-ui"), unavailable: $("#unavailable"),
  google: $("#google-btn"), divider: $("#divider"), form: $("#form"),
  nameFld: $("#name-fld"), name: $("#name"), email: $("#email"), password: $("#password"),
  error: $("#error"), ok: $("#okmsg"), submit: $("#submit"), toggle: $("#toggle"), switchText: $("#switch-text"), forgot: $("#forgot"),
};

let mode = params.get("mode") === "signup" ? "signup" : "signin";

const show = (el, msg) => { el.textContent = msg; el.hidden = false; };
const clear = () => { els.error.hidden = true; els.ok.hidden = true; };
const busy = (btn, on, label) => {
  btn.disabled = on;
  const span = btn.querySelector(".btn-label");
  if (span) span.innerHTML = on ? `<span class="spinner"></span>${label}` : btn.dataset.label;
  else if (on) btn.insertAdjacentHTML("afterbegin", '<span class="spinner"></span>');
  else btn.querySelector(".spinner")?.remove();
};

function setMode(m) {
  mode = m;
  const signup = m === "signup";
  els.title.textContent = signup ? "Create your account" : "Welcome back";
  els.subtitle.textContent = signup ? "Free. Takes ten seconds." : "Sign in to download and see your history.";
  els.nameFld.hidden = !signup;
  els.password.autocomplete = signup ? "new-password" : "current-password";
  els.submit.dataset.label = signup ? "Create account" : "Sign in";
  els.submit.querySelector(".btn-label").textContent = els.submit.dataset.label;
  els.switchText.textContent = signup ? "Already have an account?" : "New here?";
  els.toggle.textContent = signup ? "Sign in" : "Create an account";
  els.forgot.hidden = signup;
  clear();
  history.replaceState(null, "", `${location.pathname}?${new URLSearchParams({ ...(next !== "/app" && { next }), ...(signup && { mode: "signup" }) })}`.replace(/\?$/, ""));
}

// Nothing is clickable until the server has answered — otherwise the Google button silently does nothing.
const controls = [els.google, els.submit, $("#redirect-btn")];
controls.forEach((b) => (b.disabled = true));
const originalSubtitle = els.subtitle.textContent;
els.subtitle.textContent = "Connecting to the server…";

let firebase;
try {
  firebase = await initFirebaseAuth(`${API}/firebase-config.json`, {
    onWaiting: (attempt) => {
      if (attempt >= 1) els.subtitle.textContent = "Waking up the server — it sleeps when idle, this usually takes 30–60 seconds…";
    },
  });
} catch (e) {
  els.title.textContent = "Can't reach the server";
  els.subtitle.textContent = `${e.message} (${API || location.origin})`;
  els.ui.hidden = true;
  throw e;
}
controls.forEach((b) => (b.disabled = false));
els.subtitle.textContent = originalSubtitle;

if (!firebase) {
  els.ui.hidden = true;
  els.unavailable.hidden = false;
  els.title.textContent = "No sign-in needed";
  els.subtitle.textContent = "This server runs without accounts.";
} else {
  // Returning from a redirect sign-in? Finish it (or show why it failed) before anything else.
  const redirect = await firebase.redirectResult;
  await firebase.ready;
  if (firebase.user || redirect.user) { await firebase.getToken(); location.replace(next); }

  const hasGoogle = firebase.providers.includes("google"), hasPassword = firebase.providers.includes("password");
  els.google.hidden = !hasGoogle;
  els.divider.hidden = !(hasGoogle && hasPassword);
  els.form.hidden = !hasPassword;
  $(".switch").hidden = !hasPassword;
  setMode(mode);
  if (redirect.error) show(els.error, redirect.error);
  if (hasPassword && !redirect.error) (mode === "signup" ? els.name : els.email).focus();

  const complete = async () => {
    await firebase.getToken(); // make sure the token is minted before the app asks for it
    location.replace(next);
  };

  // Pop-up first. If the browser blocks it, explain and offer a redirect as an explicit second choice.
  const redirectBtn = $("#redirect-btn");
  els.google.addEventListener("click", async () => {
    clear(); redirectBtn.hidden = true; busy(els.google, true);
    try { await firebase.signInGoogle(); await complete(); }
    catch (e) {
      show(els.error, e.message);
      if (e.code === "auth/popup-blocked") redirectBtn.hidden = false;
    }
    finally { busy(els.google, false); }
  });
  redirectBtn.addEventListener("click", async () => {
    clear(); busy(redirectBtn, true, "Redirecting");
    try { await firebase.signInGoogleRedirect(); }
    catch (e) { show(els.error, e.message); busy(redirectBtn, false); }
  });

  els.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clear();
    const email = els.email.value.trim(), password = els.password.value;
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) { show(els.error, "Enter a valid email address."); els.email.focus(); return; }
    if (password.length < 6) { show(els.error, "Password must be at least 6 characters."); els.password.focus(); return; }
    busy(els.submit, true, mode === "signup" ? "Creating account" : "Signing in");
    try {
      if (mode === "signup") await firebase.signUpEmail(email, password, els.name.value.trim());
      else await firebase.signInEmail(email, password);
      await complete();
    } catch (ex) {
      show(els.error, ex.message);
      els.password.select();
    } finally {
      busy(els.submit, false);
    }
  });

  els.toggle.addEventListener("click", () => setMode(mode === "signup" ? "signin" : "signup"));

  els.forgot.addEventListener("click", async () => {
    clear();
    const email = els.email.value.trim();
    if (!email) { show(els.error, "Enter your email above first."); els.email.focus(); return; }
    try { await firebase.resetPassword(email); show(els.ok, `Password reset email sent to ${email}.`); }
    catch (ex) { show(els.error, ex.message); }
  });
}
