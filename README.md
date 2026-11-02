# Karl Bot Hosting

This app runs an Express server and persistent Python bot processes. Deploy the full app on Railway or a VPS with Docker. Netlify Functions cannot keep these bot processes running continuously.

## Railway deployment

1. Create a Railway service from this repository. The included Railway configuration selects the Dockerfile, which provides Node 24, Python 3, and pip.
2. Attach a persistent volume to the service at `/data` before starting it. Railway volumes must be created in the dashboard; the Docker image already points the existing app's data directory to this mount. This preserves the SQLite database, uploaded bots, and logs across deployments.
3. Configure `SESSION_SECRET`, `ADMIN_USERNAME`, and `ADMIN_PASSWORD` in the service's private variables. Use your own strong values before exposing the service publicly.
4. Generate a public domain. Set `BASE_URL` to that HTTPS URL. Railway supplies the listening port automatically.
5. If using Telegram integration, configure `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ADMIN_ID` privately.
6. Deploy and check `/login`. Register an account and verify that uploading and starting a Python bot works. Use a single service replica because bot process tracking belongs to the running server.

The `/login` health check confirms that the web server responds; it does not verify individual Python bots. Browser login sessions currently reset when the server restarts.

## Dependency installation fix

The previous better-sqlite3 9 dependency could not compile against Node 24's V8 headers. The app now uses better-sqlite3 12, a Node 24 version file, and a dependency lockfile. Docker uses `npm ci` for reproducible installs. The optional Nixpacks configuration uses supported Node 22 and the same lockfile.

Node 24.22.2 was used to verify a clean dependency installation and a native SQLite create/insert/read check. A successful Netlify dependency install does not run this persistent server; the full app must be deployed to the server host above.
