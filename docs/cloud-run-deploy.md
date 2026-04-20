# GymBuddy Cloud Run Deployment

This runbook deploys GymBuddy to Google Cloud Run as two services:

- `gymbuddy-backend`
- `gymbuddy-frontend`

The first production launch uses:

- one Google Cloud project
- region `us-east1`
- default `run.app` URLs
- GitHub-triggered continuous deployment from `main`
- Supabase and Upstash as external managed services

## 1. Repo preparation

Before touching Google Cloud, make sure your intended release branch is merged into `main`.

```powershell
git checkout main
git merge <your-release-branch>
git push origin main
```

For the current repo state, `<your-release-branch>` is `feat/cloud`.

Run the release checks from the repo root:

```powershell
uv run pytest backend/tests/test_new_agents.py -q
```

From `frontend/`:

```powershell
cmd /c npm run build
```

Cloud Run source deployments in this repo rely on these files:

- root `Procfile` for the FastAPI entrypoint
- `frontend/Procfile` for the Next.js entrypoint
- root `.python-version` to pin Python `3.12`
- `frontend/package.json` `engines.node` to pin Node `22.x`

## 2. GCP project setup

Choose one project and keep both services in `us-east1`.

Set local shell variables in Cloud Shell:

```bash
export PROJECT_ID="your-gcp-project-id"
export REGION="us-east1"
export BACKEND_SERVICE="gymbuddy-backend"
export FRONTEND_SERVICE="gymbuddy-frontend"
export BACKEND_SA="gymbuddy-backend-sa"
export FRONTEND_SA="gymbuddy-frontend-sa"
```

Select the project:

```bash
gcloud config set project "$PROJECT_ID"
```

Enable required APIs:

```bash
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com
```

Get the project number:

```bash
export PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
```

Create service accounts:

```bash
gcloud iam service-accounts create "$BACKEND_SA" \
  --display-name="GymBuddy backend Cloud Run service account"

gcloud iam service-accounts create "$FRONTEND_SA" \
  --display-name="GymBuddy frontend Cloud Run service account"
```

Grant the backend service account access to secrets:

```bash
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${BACKEND_SA}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

Grant the default Cloud Build service account the source-build role Cloud Run needs:

```bash
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/run.builder"
```

## 3. Secrets and runtime values

Create backend secrets in Secret Manager:

```bash
printf '%s' 'your-openai-api-key' | gcloud secrets create OPENAI_API_KEY --data-file=-
printf '%s' 'your-database-url' | gcloud secrets create DATABASE_URL --data-file=-
printf '%s' 'your-supabase-jwks-url' | gcloud secrets create SUPABASE_JWKS_URL --data-file=-
printf '%s' 'your-youtube-api-key' | gcloud secrets create YOUTUBE_API_KEY --data-file=-
printf '%s' 'your-upstash-url' | gcloud secrets create UPSTASH_REDIS_REST_URL --data-file=-
printf '%s' 'your-upstash-token' | gcloud secrets create UPSTASH_REDIS_REST_TOKEN --data-file=-
```

If a secret already exists, add a new version instead:

```bash
printf '%s' 'new-value' | gcloud secrets versions add SECRET_NAME --data-file=-
```

Frontend public values are not secrets:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` or `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `NEXT_PUBLIC_API_URL`

Backend runtime non-secret value:

- `CORS_ALLOWED_ORIGINS`

## 4. Backend Cloud Run service

Create the backend service from the Cloud Run console:

1. Open Cloud Run in the Google Cloud console.
2. Click `Create service`.
3. Choose `Continuously deploy new revisions from a source repository`.
4. Connect GitHub if prompted.
5. Select repository `srinath-19/GymBuddy`.
6. Branch: `main`.
7. Service name: `gymbuddy-backend`.
8. Region: `us-east1`.
9. Build type: `Buildpacks`.
10. Build context directory: `.`.
11. Entrypoint: leave blank because the repo root `Procfile` defines it.
12. Authentication: `Allow public access`.
13. Service account: `gymbuddy-backend-sa@PROJECT_ID.iam.gserviceaccount.com`.

Set container configuration:

- CPU: `1`
- Memory: `1 GiB`
- Request timeout: `300 seconds`
- Minimum instances: `1`
- Maximum instances: `1`

Set runtime secrets:

- `OPENAI_API_KEY` from Secret Manager
- `DATABASE_URL` from Secret Manager
- `SUPABASE_JWKS_URL` from Secret Manager
- `YOUTUBE_API_KEY` from Secret Manager
- `UPSTASH_REDIS_REST_URL` from Secret Manager
- `UPSTASH_REDIS_REST_TOKEN` from Secret Manager

Set runtime environment variables:

- `CORS_ALLOWED_ORIGINS=http://localhost:3000`

Create the service, wait for the first build, and copy the backend URL:

```bash
export BACKEND_URL="https://gymbuddy-backend-xxxxx-xx.a.run.app"
```

Verify health:

```bash
curl "${BACKEND_URL}/health"
```

The expected response is:

```json
{"status":"ok"}
```

## 5. Frontend Cloud Run service

Create the frontend service from the Cloud Run console:

1. Open Cloud Run.
2. Click `Create service`.
3. Choose `Continuously deploy new revisions from a source repository`.
4. Select repository `srinath-19/GymBuddy`.
5. Branch: `main`.
6. Service name: `gymbuddy-frontend`.
7. Region: `us-east1`.
8. Build type: `Buildpacks`.
9. Build context directory: `frontend`.
10. Entrypoint: leave blank because `frontend/Procfile` defines it.
11. Authentication: `Allow public access`.
12. Service account: `gymbuddy-frontend-sa@PROJECT_ID.iam.gserviceaccount.com`.

Set container configuration:

- CPU: `1`
- Memory: `512 MiB`
- Request timeout: `60 seconds`
- Minimum instances: `0`

Set build environment variables:

- `NEXT_PUBLIC_SUPABASE_URL=<your Supabase URL>`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<your Supabase publishable key>`
- or `NEXT_PUBLIC_SUPABASE_ANON_KEY=<legacy anon key>`
- `NEXT_PUBLIC_API_URL=${BACKEND_URL}`

Set the same public variables as runtime environment variables:

- `NEXT_PUBLIC_SUPABASE_URL=<your Supabase URL>`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<your Supabase publishable key>`
- or `NEXT_PUBLIC_SUPABASE_ANON_KEY=<legacy anon key>`
- `NEXT_PUBLIC_API_URL=${BACKEND_URL}`

Create the service, wait for the first build, and copy the frontend URL:

```bash
export FRONTEND_URL="https://gymbuddy-frontend-xxxxx-xx.a.run.app"
```

## 6. Finish backend CORS

After the frontend exists, update the backend service:

- `CORS_ALLOWED_ORIGINS=${FRONTEND_URL}`

Redeploy the backend or create a new revision from the Cloud Run console so the frontend origin is allowed.

CLI equivalent:

```bash
gcloud run services update "$BACKEND_SERVICE" \
  --region "$REGION" \
  --update-env-vars "CORS_ALLOWED_ORIGINS=${FRONTEND_URL}"
```

## 7. Continuous deployment behavior

After both services are created from the repository:

- pushes to `main` rebuild and redeploy `gymbuddy-backend`
- pushes to `main` rebuild and redeploy `gymbuddy-frontend`

The backend trigger uses build context `.`.

The frontend trigger uses build context `frontend`.

If you need to inspect or edit trigger settings:

1. Open Cloud Run.
2. Open the service.
3. Open the `Source` or `Build` section.
4. Follow the link to the associated Cloud Build trigger.

## 8. Smoke test checklist

After the first full deployment, test these flows from the deployed frontend:

- login
- workout logging
- manual workout add/edit/delete
- coach flow
- pacer flow
- TTS playback

Watch the backend logs while testing:

```bash
gcloud run services logs tail "$BACKEND_SERVICE" --region "$REGION"
```

What to watch for:

- startup DDL failures from `create_tables()`
- Supabase JWT verification failures
- OpenAI request failures
- CORS errors
- Upstash connectivity errors

## 9. Operating constraints for v1

Keep backend `max instances = 1`.

Reason:

- `backend/app/services/conversation.py` stores conversation state in memory
- `backend/app/services/pacer_session.py` stores pacer state in memory

If you scale the backend horizontally before moving that state to Redis or Postgres, follow-up coach or pacer requests can land on a different instance and lose context.

## 10. Rollback and recovery

List backend revisions:

```bash
gcloud run revisions list \
  --service "$BACKEND_SERVICE" \
  --region "$REGION"
```

Rollback traffic to a known-good revision:

```bash
gcloud run services update-traffic "$BACKEND_SERVICE" \
  --region "$REGION" \
  --to-revisions REVISION_NAME=100
```

Do the same for the frontend service if needed.

## 11. Manual CLI fallback

If you ever need a manual deployment outside the GitHub trigger flow, deploy from source:

Backend:

```bash
gcloud run deploy "$BACKEND_SERVICE" \
  --region "$REGION" \
  --source .
```

Frontend:

```bash
cd frontend
gcloud run deploy "$FRONTEND_SERVICE" \
  --region "$REGION" \
  --source .
```

If you use the manual fallback for the frontend, remember to provide the frontend build environment variables during deployment.

## References

- Cloud Run source deploys: https://cloud.google.com/run/docs/deploying-source-code
- Continuous deployment from repository: https://cloud.google.com/run/docs/continuous-deployment-with-cloud-build
- Build env vars for source deployments: https://cloud.google.com/run/docs/configuring/services/build-environment-variables
- Runtime env vars: https://cloud.google.com/run/docs/configuring/services/environment-variables
- Secrets: https://cloud.google.com/run/docs/configuring/services/secrets
- Public access: https://cloud.google.com/run/docs/authenticating/public
- Next.js on Cloud Run: https://cloud.google.com/run/docs/quickstarts/frameworks/deploy-nextjs-service
- FastAPI on Cloud Run: https://cloud.google.com/run/docs/quickstarts/build-and-deploy/deploy-python-fastapi-service
- Custom domains later: https://cloud.google.com/run/docs/mapping-custom-domains
