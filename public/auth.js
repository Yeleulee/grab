// Firebase Authentication for the browser. Loads the SDK from /vendor/firebase (served from node_modules
// via an import map in index.html). Returns null when the server has no FIREBASE_* env vars set.

export async function initFirebaseAuth(configUrl = "/firebase-config.json") {
  let cfg = null;
  try { cfg = await (await fetch(configUrl, { cache: "no-store" })).json(); } catch { return null; }
  if (!cfg?.apiKey || !cfg?.projectId) return null;

  const { initializeApp } = await import("firebase/app");
  const fb = await import("firebase/auth");

  // With FIREBASE_AUTH_PROXY=1 the server proxies /__/auth/* from firebaseapp.com, so the auth helper can run
  // on this very domain — the fix for redirect sign-in on browsers that block third-party storage.
  const authDomain = cfg.authProxy ? location.host : cfg.authDomain;
  const app = initializeApp({ apiKey: cfg.apiKey, authDomain, projectId: cfg.projectId, appId: cfg.appId });
  const auth = fb.getAuth(app);
  auth.useDeviceLanguage();
  await fb.setPersistence(auth, fb.browserLocalPersistence).catch(() => {});

  const providers = Array.isArray(cfg.providers) && cfg.providers.length ? cfg.providers : ["google", "password"];

  // Resolve once Firebase has restored (or not) the persisted session.
  const ready = new Promise((resolve) => {
    const off = fb.onAuthStateChanged(auth, (u) => { off(); resolve(u); });
  });

  // If we're returning from a redirect sign-in, surface its outcome (success or a real error) instead of
  // silently landing back on the login page signed out.
  const redirectResult = fb.getRedirectResult(auth).then((r) => ({ user: r?.user ?? null, error: null }), (e) => ({ user: null, error: friendly(e) }));

  const host = location.hostname;
  function friendly(e) {
    const code = e?.code || "";
    const map = {
      "auth/invalid-email": "That email address doesn't look right.",
      "auth/user-not-found": "No account with that email.",
      "auth/wrong-password": "Wrong password.",
      "auth/invalid-credential": "Wrong email or password.",
      "auth/email-already-in-use": "An account with that email already exists — sign in instead.",
      "auth/weak-password": "Use at least 6 characters.",
      "auth/too-many-requests": "Too many attempts. Try again in a few minutes.",
      "auth/popup-closed-by-user": "The sign-in window was closed before finishing.",
      "auth/cancelled-popup-request": "Another sign-in window is already open.",
      "auth/popup-blocked": "Your browser blocked the sign-in window. Allow pop-ups for this site, or use the redirect option below.",
      "auth/unauthorized-domain": `“${host}” isn't an authorised domain yet. In the Firebase console open Authentication → Settings → Authorized domains and add “${host}”.`,
      "auth/operation-not-allowed": "This sign-in method is disabled in the Firebase console (Authentication → Sign-in method).",
      "auth/network-request-failed": "Network error — check your connection.",
      "auth/configuration-not-found": "Firebase Authentication isn't enabled for this project — open the Firebase console → Authentication → Get started.",
      "auth/invalid-api-key": "The Firebase API key (FIREBASE_API_KEY) is invalid.",
      "auth/api-key-not-valid.-please-pass-a-valid-api-key.": "The Firebase API key (FIREBASE_API_KEY) is invalid.",
      "auth/missing-or-invalid-nonce": "Sign-in state was lost during the redirect (browser blocked third-party storage). Use the pop-up option instead.",
      "auth/web-storage-unsupported": "Your browser blocks the storage Firebase needs. Allow cookies for this site or use a different browser.",
    };
    const msg = map[code]
      || (code.startsWith("auth/") ? (() => { const t = code.slice(5).replace(/[-.]+/g, " ").trim(); return t ? t[0].toUpperCase() + t.slice(1) + "." : "Sign-in failed."; })() : null)
      || e?.message?.replace(/^Firebase:\s*/, "").replace(/\s*\(auth\/[^)]+\)\.?$/, "")
      || "Sign-in failed.";
    const err = new Error(msg);
    err.code = code;
    return err;
  }

  const wrap = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { throw friendly(e); } };
  const googleProvider = () => { const p = new fb.GoogleAuthProvider(); p.setCustomParameters({ prompt: "select_account" }); return p; };

  return {
    providers,
    ready,
    redirectResult,
    get user() { return auth.currentUser; },
    onChange: (cb) => fb.onAuthStateChanged(auth, cb),
    /** Fresh ID token (SDK caches and auto-refreshes). force=true after a 401. */
    getToken: (force = false) => (auth.currentUser ? auth.currentUser.getIdToken(force) : Promise.resolve("")),
    /** Pop-up sign-in. Never falls back to a redirect on its own: redirects break on browsers that block
     *  third-party storage unless the auth helper is proxied through this domain (see README). */
    signInGoogle: wrap(() => fb.signInWithPopup(auth, googleProvider())),
    /** Explicit redirect sign-in, offered only when the user asks for it after a blocked pop-up. */
    signInGoogleRedirect: wrap(() => fb.signInWithRedirect(auth, googleProvider())),
    signInEmail: wrap((email, password) => fb.signInWithEmailAndPassword(auth, email, password)),
    signUpEmail: wrap(async (email, password, name) => {
      const cred = await fb.createUserWithEmailAndPassword(auth, email, password);
      if (name) await fb.updateProfile(cred.user, { displayName: name }).catch(() => {});
      return cred;
    }),
    resetPassword: wrap((email) => fb.sendPasswordResetEmail(auth, email)),
    signOut: () => fb.signOut(auth),
  };
}
