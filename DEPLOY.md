# SüRJ ADVISE Tool — Deployment Instructions
## advise.surj.app

---

## WHAT YOU'RE DEPLOYING

Three files in the `advise-tool/` folder:
- `worker.js` — the Cloudflare Worker (routing, KV, GHL webhook)
- `wrangler.toml` — Worker config
- `public/index.html` — the ADVISE tool
- `public/dashboard.html` — session dashboard

---

## STEP 1 — Get your KV Namespace ID

In Cloudflare Dashboard:
1. Workers & Pages → KV
2. You should have created `ADVISE_SESSIONS` already
3. Copy the **Namespace ID** (looks like: `a1b2c3d4e5f6...`)
4. Open `wrangler.toml` and replace `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` with it

---

## STEP 2 — Get your GHL Custom Field ID

In GHL (go.surj.app):
1. Settings → Custom Fields
2. Find "ADVISE Brief URL" field you created
3. Click it — the URL in your browser will contain the field ID
   Example: `.../custom-fields/abc123xyz` → ID is `abc123xyz`
4. Open `worker.js` and replace `REPLACE_WITH_YOUR_CUSTOM_FIELD_ID` with it

---

## STEP 3 — Get your GHL Pipeline ID

In GHL:
1. Opportunities → Pipelines
2. Open "SüRJ — Online Lead Pipeline"
3. The URL will contain the pipeline ID
   Example: `.../pipelines/xyz789abc` → ID is `xyz789abc`
4. In `worker.js`, replace `REPLACE_WITH_PIPELINE_ID` with it

---

## STEP 4 — Push to GitHub

```bash
cd advise-tool
git init
git add .
git commit -m "Initial ADVISE tool deploy"
git remote add origin YOUR_GITHUB_REPO_URL
git push -u origin main
```

---

## STEP 5 — Deploy with Wrangler

```bash
# From inside the advise-tool/ folder
wrangler deploy
```

You should see:
```
✓ Deployed advise-tool to advise.surj.app
```

---

## STEP 6 — Verify

Open these URLs:
- https://advise.surj.app — should show the pre-call screen
- https://advise.surj.app/dashboard — should show the empty dashboard
- Run a test session end to end
- Hit "Generate Brief" — check that a brief URL is created
- Check GHL — a new contact should appear with a note and brief URL

---

## STEP 7 — Set up auto-deploy (optional but recommended)

In Cloudflare Dashboard:
1. Workers & Pages → advise-tool → Settings
2. Connect to GitHub repo
3. Every push to `main` auto-deploys

---

## ONGOING UPDATES

To update the tool after changes:
```bash
wrangler deploy
```
Or just push to GitHub if auto-deploy is connected.

---

## IF SOMETHING BREAKS

- **KV not saving**: Check that the KV namespace ID in `wrangler.toml` matches exactly
- **GHL not firing**: The webhook fires async — check GHL contact list for new entries
- **Brief URL 404**: Brief is stored in KV — check that the session ID matches
- **Tool works but no auto-save**: localStorage is the backup — data still captured locally

---

## DATA LOCATIONS SUMMARY

| Data | Where | Duration |
|------|-------|----------|
| Session (Q&A, KPIs, notes) | Cloudflare KV + localStorage | 90 days KV / browser session local |
| Brief HTML | Cloudflare KV | 1 year |
| Contact record | GHL | Permanent |
| Call notes | GHL contact note | Permanent |
| Brief URL | GHL custom field on contact | Permanent |
| Opportunity | GHL pipeline | Permanent |

---

## QUESTIONS?

Contact: Steve Wilson · admin@surj.app · (405) 913-1956
