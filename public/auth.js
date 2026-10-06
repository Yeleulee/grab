// Firebase Authentication for the browser. Loads the SDK from /vendor/firebase (served from node_modules
// via an import map in index.html). Returns null when the server has no FIREBASE_* env vars set.

export async function initFirebaseAuth(configUrl = "/firebase-config.json") {
  let cfg = null;
  try { cfg = await (await fetch(configUrl, { cache: "no-store" })).json(); } catch { return null; }
  if (!cfg?.apiKey || !cfg?.projectId) return null;

  const { initializeApp } = await import("firebase/app");
  const fb = await import("firebase/auth");

  const app = initializeApp({ apiKey: cfg.apiKey, authDomain: cfg.authDomain, projectId: cfg.projectId, appId: cfg.appId });
  const auth = fb.getAuth(app);
  auth.useDeviceLanguage();
  await fb.setPersistence(auth, fb.browserLocalPersistence).catch(() => {});

  const providers = Array.isArray(cfg.providers) && cfg.providers.length ? cfg.providers : ["google", "password"];

  // Resolve once Firebase has restored (or not) the persisted session.
  const ready = new Promise((resolve) => {
    const off = fb.onAuthStateChanged(auth, (u) => { off(); resolve(u); });
  });

  const friendly = (e) => {
    const code = e?.code || "";
    const map = {
      "auth/invalid-email": "That email address doesn't look right.",
      "auth/user-not-found": "No account with that email.",
      "auth/wrong-password": "Wrong password.",
      "auth/invalid-credential": "Wrong email or password.",
      "auth/email-already-in-use": "An account with that email already exists — sign in instead.",
      "auth/weak-password": "Use at least 6 characters.",
      "auth/too-many-requests": "Too many attempts. Try again in a few minutes.",
      "auth/popup-closed-by-user": "Sign-in window was closed.",
      "auth/popup-blocked": "Your browser blocked the sign-in popup — allow popups and try again.",
      "auth/unauthorized-domain": "This domain isn't authorised in Firebase → Authentication → Settings → Authorized domains.",
      "auth/operation-not-allowed": "This sign-in method is disabled in the Firebase console.",
      "auth/network-request-failed": "Network error — check your connection.",
      "auth/configuration-not-found": "Firebase Authentication isn't enabled for this project — open the Firebase console → Authentication → Get started.",
      "auth/invalid-api-key": "The Firebase API key (FIREBASE_API_KEY) is invalid.",
      "auth/api-key-not-valid.-please-pass-a-valid-api-key.": "The Firebase API key (FIREBASE_API_KEY) is invalid.",
    };
    if (map[code]) return map[code];
    if (code.startsWith("auth/")) {
      // "auth/some-error-code" → "Some error code."
      const text = code.slice(5).replace(/[-.]+/g, " ").trim();
      return text ? text[0].toUpperCase() + text.slice(1) + "." : "Sign-in failed.";
    }
    return e?.message?.replace(/^Firebase:\s*/, "").replace(/\s*\(auth\/[^)]+\)\.?$/, "") || "Sign-in failed.";
  };

  const wrap = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { throw new Error(friendly(e)); } };

  return {
    providers,
    ready,
    get user() { return auth.currentUser; },
    onChange: (cb) => fb.onAuthStateChanged(auth, cb),
    /** Fresh ID token (SDK caches and auto-refreshes). force=true after a 401. */
    getToken: (force = false) => (auth.currentUser ? auth.currentUser.getIdToken(force) : Promise.resolve("")),
    signInGoogle: wrap(async () => {
      const p = new fb.GoogleAuthProvider();
      p.setCustomParameters({ prompt: "select_account" });
      try {
        return await fb.signInWithPopup(auth, p);
      } catch (e) {
        if (e?.code === "auth/popup-blocked") return fb.signInWithRedirect(auth, p);
        throw e;
      }
    }),
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
