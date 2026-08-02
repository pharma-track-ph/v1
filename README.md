# PharmaTrack

PharmaTrack uses a single static frontend source at `frontend/`. Express serves that folder from `backend/server.js`.

Do not create or edit a second frontend copy under `backend/public/`; that path is ignored so stale deployment copies do not become another source of truth.

## Local Run

```bash
cd backend
npm start
```

The app is served at `http://localhost:5000/pages/login.html`.
