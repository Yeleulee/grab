import type { NextFunction, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";

export interface FirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
  providers?: string[];
}

export interface AuthUser {
  uid: string;
  email?: string;
  name?: string;
  picture?: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/** Firebase web config from FIREBASE_* env vars (.env locally, Render env vars in production). */
export function loadFirebaseConfig(env: NodeJS.ProcessEnv = process.env): FirebaseConfig | null {
  const projectId = env.FIREBASE_PROJECT_ID?.trim() ?? "";
  const cfg: FirebaseConfig = {
    apiKey: env.FIREBASE_API_KEY?.trim() ?? "",
    authDomain: env.FIREBASE_AUTH_DOMAIN?.trim() || (projectId ? `${projectId}.firebaseapp.com` : ""),
    projectId,
    appId: env.FIREBASE_APP_ID?.trim() ?? "",
    providers: (env.FIREBASE_PROVIDERS ?? "google,password").split(",").map((s) => s.trim()).filter(Boolean),
  };
  return cfg.apiKey && cfg.projectId ? cfg : null;
}

/**
 * Verifies Firebase ID tokens using Google's public keys — no service account required.
 * https://firebase.google.com/docs/auth/admin/verify-id-tokens#verify_id_tokens_using_a_third-party_jwt_library
 */
export function createFirebaseAuth(projectId: string) {
  const JWKS = createRemoteJWKSet(
    new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com")
  );

  async function verify(idToken: string): Promise<AuthUser> {
    const { payload } = await jwtVerify(idToken, JWKS, {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
      algorithms: ["RS256"],
    });
    if (!payload.sub) throw new Error("Token has no subject.");
    return {
      uid: payload.sub,
      email: typeof payload.email === "string" ? payload.email : undefined,
      name: typeof payload.name === "string" ? payload.name : undefined,
      picture: typeof payload.picture === "string" ? payload.picture : undefined,
    };
  }

  /** Express middleware: requires `Authorization: Bearer <Firebase ID token>`. */
  async function requireAuth(req: Request, res: Response, next: NextFunction) {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : req.query.token;
    if (typeof token !== "string" || !token) return res.status(401).json({ error: "Sign in required." });
    try {
      req.user = await verify(token);
      next();
    } catch (e: any) {
      res.status(401).json({ error: /exp/i.test(e.code ?? e.message) ? "Session expired — sign in again." : "Invalid session." });
    }
  }

  return { verify, requireAuth };
}
