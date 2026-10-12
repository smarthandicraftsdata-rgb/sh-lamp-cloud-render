# SH Lamp Render — RF7 full project update 0.1.1

This package updates your supplied RF7 P2B shadow-auth project. It includes the complete project, the persistent-login server fixes, and an external five-minute Render health ping. Read this file before replacing your branch.

## Replace your GitHub branch

1. Extract the ZIP. Open the `sh-lamp-cloud-render` folder inside it.
2. Replace the repository contents with the contents of that folder. `package.json`, `src`, `prisma` and `render.yaml` must be directly at repository root; do not create an extra nested project folder or upload the ZIP itself.
3. Include the hidden `.github` folder. On Windows, enable viewing hidden items. If GitHub's web upload omits it, use **Add file → Create new file** to add each workflow at its complete path and paste its supplied content:
   - `.github/workflows/render-keep-alive.yml`
   - `.github/workflows/session-regression.yml`
4. Commit the complete replacement. The five-minute scheduled ping activates when its workflow is present on your repository's default branch (`main`). Uploading to another branch requires merging it into the default branch before scheduled runs start.
5. Open **Actions → Render keep-alive**. The workflow runs when added/changed on `main`; you can also select **Run workflow**. Confirm it succeeds with HTTP 200. Enable Actions in repository settings if disabled.
6. Open **Actions → Session regression** and check its PostgreSQL-backed tests. These use a separate disposable test database, not your Render database.

No browser permission or direct GitHub upload by ChatGPT is needed for this manual replacement. This ZIP does not itself activate a live schedule.

## Render deployment

- Node: 22 (the local checks used 22.23.3).
- Build: `npm install --production=false && npm run build`
- Start: `npm run start:render`
- Health path: `/health`
- Keep `ACCESS_TOKEN_SECRET`, `ADMIN_SETUP_KEY`, and any existing `DEVICE_CREDENTIAL_MASTER_KEY_B64` unchanged.
- Set `DATABASE_URL` to your database's internal URL. A new empty database contains no previous accounts or lamp registrations; restore a backup or recreate them.
- Keep the existing RF7 shadow-auth configuration. The supplied blueprint defaults `SHADOW_AUTH_ENABLED` to false; do not change this unless deliberately following the RF7 provisioning instructions.
- `REFRESH_RETRY_GRACE_SECONDS` defaults to 120; access-token and refresh-token lifetimes remain 900 seconds and 30 days.
- The start command applies all migrations, including the original RF7 migration and `202610120001_session_retry`, before starting the server. Include the entire `prisma` folder. A schema-only upload is insufficient.
- After deployment, `/health` reports version `0.1.1`.

## Five-minute ping

The workflow sends an HTTPS GET to:

`https://sh-lamp-cloud-render.onrender.com/health`

It runs at minutes `02, 07, 12, …, 57` of every hour. This is a five-minute interval offset from the start of the hour. It uses retries and time limits and requires no account secrets or database access. The server's existing 30-second WebSocket heartbeats remain in place.

GitHub scheduled runs are best effort: they can be delayed or dropped. Public-repository schedules can also be disabled after 60 days without repository activity. This reduces idle sleep when requests arrive; it does not guarantee continuous uptime. Reference: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule

## Login reliability fixes

- Refresh rotation is atomic under a database row lock shared across server instances.
- A lost reply can be retried with the old token within a fixed two-minute window and returns the same replacement token. Recovery storage is encrypted; normal tokens are hashed.
- Concurrent refreshes, logout, and password reset are coordinated. Logout revokes only that session; password reset revokes all sessions for the user.
- Valid existing refresh tokens migrate on first use.
- Temporary WebSocket server/database failures use reconnectable close code 1011; handshake timeout uses 1013. Rejected authentication retains code 4003.
- Concurrent or completed WebSocket auth messages cannot switch accounts, and a closed handshake cannot publish access later.

Use the persistent-login app provided earlier. An expired/revoked token, explicit logout, password reset, or a retry outside the recovery window can still require sign-in.

## RF7 preservation and validation

The original RF7 shadow-auth modules, credential wrapping, device provisioning routes, command service and existing migrations are preserved. `authV2Hello` / `authV2Proof` remain shadow-only and require legacy authentication. They do not grant command authority or disconnect the lamp on proof failure.

See `validation/RESULTS.md` for current checks. Older release reports and hashes in this project describe historical builds; use `validation/SHA256SUMS.txt` for this delivered package.
