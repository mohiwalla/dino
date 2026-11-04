export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /**
   * Comma-separated origins the game is served from, e.g. https://dino.mohiwalla.com. Sign-in
   * comes back to the one the player is on, and writes from any other origin are refused.
   */
  ORIGINS: string;
  ENTRA_TENANT_ID: string;
  ENTRA_CLIENT_ID: string;
  /** Secret (wrangler secret put / .dev.vars). */
  ENTRA_CLIENT_SECRET: string;
  /** Comma-separated emails of the players who can review runs and ban players. */
  ADMIN_EMAILS: string;
  /** "1" enables /api/auth/dev sign-in, only honoured when every origin is a localhost URL. */
  DEV_LOGIN?: string;
}
