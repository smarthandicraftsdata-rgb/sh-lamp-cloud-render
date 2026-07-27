# Exact Render setup

## 1. Upload this repository to GitHub

Repository name: `sh-lamp-cloud-render`

Upload all files and folders from the ZIP root. Do not upload the containing ZIP itself as the repository content.

## 2. Create Render PostgreSQL first

- New → PostgreSQL
- Name: `sh-lamp-postgres`
- Region: Singapore
- Plan: Free
- Database: `shlamp`
- User: `shlamp`

Copy the **Internal Database URL**.

## 3. Create the Render Web Service

Select the GitHub repository and use:

- Name: `sh-lamp-cloud-render`
- Region: Singapore
- Runtime: Node
- Branch: `main`
- Build command: `npm install --production=false && npm run build`
- Start command: `npm run start:render`
- Instance type: Free
- Health check path: `/health`

## 4. Environment variables

Add:

- `NODE_ENV` = `production`
- `DATABASE_URL` = the Render PostgreSQL **Internal Database URL**
- `ACCESS_TOKEN_SECRET` = a random value of at least 32 characters
- `ADMIN_SETUP_KEY` = a different random value of at least 24 characters
- `ACCESS_TOKEN_TTL_SECONDS` = `900`
- `REFRESH_TOKEN_TTL_DAYS` = `30`
- `BCRYPT_ROUNDS` = `10`
- `CORS_ORIGINS` = `*`
- `COMMAND_TTL_SECONDS` = `120`

Do not put `ACCESS_TOKEN_SECRET`, `ADMIN_SETUP_KEY`, or `DATABASE_URL` into GitHub.

## 5. Verify

After deployment, open:

`https://YOUR-SERVICE.onrender.com/health`

Expected response contains:

```json
{"ok":true,"service":"sh-lamp-cloud-render"}
```
