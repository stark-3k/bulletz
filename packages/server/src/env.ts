export const env = {
  port: Number(process.env.PORT ?? 4000),
  /**
   * Loopback by default so a dev server is not accidentally exposed on a
   * laptop's network. A container has to bind 0.0.0.0 or nothing outside it —
   * including the reverse proxy in front — can ever connect.
   */
  host: process.env.HOST ?? "127.0.0.1",
  databaseUrl:
    process.env.DATABASE_URL ?? "postgres://bulletz:bulletz@localhost:5433/bulletz",
  logLevel: process.env.LOG_LEVEL ?? "info",
  /**
   * Where the built web UI lives, when this server is also serving it. Unset
   * means API only — which is how the desktop app alone uses it.
   */
  webRoot: process.env.WEB_ROOT ?? "",
  /**
   * Browser origins allowed to call this API, comma separated.
   *
   * Empty means same-origin only, which is correct when the server serves the
   * UI itself. Three things are allowed regardless of this list: the desktop
   * app (not a browser origin — it loads over file:// and sends `Origin:
   * null` or none at all), requests with no Origin, and loopback origins,
   * which can only come from a page served by this same machine. CORS is not
   * what protects this API; the bearer token is.
   */
  corsOrigins: (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};
