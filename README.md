# GymBuddy

GymBuddy is a voice-first workout tracker with a Next.js frontend and a FastAPI backend.

## Local development

Backend:

```powershell
uv run uvicorn backend.app.main:app --reload --port 8000
```

Frontend:

```powershell
cd frontend
cmd /c npm run dev
```

## Deployment

Use the Cloud Run runbook in [docs/cloud-run-deploy.md](docs/cloud-run-deploy.md).
