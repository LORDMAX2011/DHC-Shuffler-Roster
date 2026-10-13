# School Classroom Shuffle

A responsive school roster app with a password-protected Express API and MongoDB Atlas storage. One Render web service serves the app and API. The first administrator is configured with Render environment variables; administrators can manage backups and review a recent activity log. There is no public registration.

## Run locally

Requirements: Node.js 20 or newer and a MongoDB Atlas connection string.

1. Copy `.env.example` to `.env` and fill in `MONGODB_URI`, `ADMIN_NAME`, `ADMIN_PASSWORD`, and `JWT_SECRET`. The administrator login can be any name. Existing deployments can keep using `ADMIN_EMAIL`; `ADMIN_USERNAME` is also accepted and takes precedence if set.
2. Use an admin password with at least 12 characters. Use a random JWT secret at least 48 characters long.
3. In PowerShell, run `npm install`, then `npm start`.
4. Open `http://localhost:3000` and sign in with the configured admin name and password. The bootstrap administrator is created from the environment settings the first time the server starts against an empty account collection; later password changes remain in effect across restarts.

Never commit `.env`. `.gitignore` excludes it. `.env.example` contains placeholders only.

## Publish to GitHub from Windows PowerShell

First create a new **empty private repository** on GitHub (do not initialize it with a README, license, or `.gitignore`). Then open PowerShell and run these commands from the project folder:

```powershell
cd "C:\Users\USER\Documents\Codex\2026-10-10\linear-plugin-linear-openai-curated-remote"
npm install
git init
git add .
git status
git commit -m "Add school roster app and MongoDB backend"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPOSITORY.git
git push -u origin main
```

Replace the GitHub URL with the URL for your repository. Check `git status` before committing and make sure `.env` is not listed. GitHub may open a browser for sign-in. If `git remote add origin` says `origin` already exists, use `git remote set-url origin https://github.com/YOUR-USERNAME/YOUR-REPOSITORY.git` instead.

For future updates:

```powershell
git add .
git commit -m "Describe your change"
git push
```

## Set up MongoDB Atlas

1. Create an Atlas project and cluster, then create a **database user** with read/write access to the app database.
2. In Atlas Network Access, add the outbound IP address ranges listed for your Render web service. Render shows these in the service's Connect area. If Render lists several ranges, add each one to Atlas.
3. Copy the Atlas driver connection string. Use the database name `school_roster`, for example `mongodb+srv://USER:PASSWORD@YOUR-CLUSTER.mongodb.net/school_roster?retryWrites=true&w=majority`.
4. Replace the username, password, and cluster host. URL-encode special characters in the username/password if needed. Keep this URI private.

Atlas requires network access to be allowed by its IP access list. Avoid `0.0.0.0/0` for a school roster database; it allows connection attempts from any IP and is broader than needed.

## Deploy on Render

1. Sign in to Render and choose **New → Web Service**. Connect your GitHub account and select this repository.
2. Configure:
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `npm start`
   - Health check path: `/api/health`
3. Add these environment variables under the service's Environment settings:
   - `MONGODB_URI`: the Atlas URI from above
   - `ADMIN_NAME`: the school administrator's sign-in name (an email or normal name). Existing `ADMIN_EMAIL` and `ADMIN_USERNAME` settings are also supported.
   - `ADMIN_PASSWORD`: a unique password of at least 12 characters
   - `JWT_SECRET`: a newly generated random secret, at least 48 characters
   - `NODE_ENV`: `production`
4. Generate a JWT secret in PowerShell with `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`. Paste the result directly into Render's environment settings. Do not put it in GitHub or share it.
5. Create the service and wait for the first deploy. Open the `onrender.com` URL, sign in, and confirm the connection indicator says it is saving to the cloud.

Render can redeploy the service after you push later commits to the connected branch. If deployment fails, check the Render deploy logs and verify all four required secrets are set correctly. The health endpoint reports whether the app process is up; MongoDB connection success is also logged during startup.

## Data and access

After sign-in, the app stores school profile and appearance settings, classes, student names, current groups, saved rosters, and grouping rules in MongoDB. Signed-in users can manage rosters and use the Security section to change their username and password. Administrators can export school data, restore backups, and review recent account and data activity. Accounts use 12+ character passwords; sign-in sessions expire after 12 hours.

The server makes a MongoDB snapshot before each school-data update and a scheduled snapshot every 24 hours. Up to 30 snapshots are retained; administrators can also create and restore backups manually. These snapshots are stored in the same MongoDB cluster, so they are not a substitute for an independent Atlas backup plan. Roster history undo is available during the current browser session. Saved-roster retention can be configured in the Classes section; the default is to keep rosters until manually deleted.

The app includes print layouts, CSV/Excel/JSON exports, high-contrast and reduced-motion support, date formats for Nigeria/UK/US, and an installable PWA. If the API is unavailable, it can run in local browser mode; local changes do not sync until you sign in. Review imported/OCR-extracted names before shuffling. Student names and any optional grouping attributes are sensitive school data: use a private GitHub repository, keep credentials out of source control, and limit Atlas network access to Render's listed outbound ranges.
