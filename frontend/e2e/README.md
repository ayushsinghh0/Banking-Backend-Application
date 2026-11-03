# Browser journeys and screenshots (Playwright)

The journeys drive the real stack through Chromium exactly as people use it: they read verification,
activation and reset links from Mailpit, compute authenticator codes like a phone app, and move real money
through the ledger.

## Run

```bash
# 1. A fresh full stack with the dev overlay (Mailpit, relaxed per-IP limits, new authenticators allowed to step up)
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build     # from the repository root

# 2. Bootstrap the two administrators (once per fresh database)
cd frontend
npx playwright install chromium
node e2e/bootstrap.mjs                    # or COMPOSE="wsl -d Ubuntu -- docker compose" when Docker runs in WSL

# 3. Journeys, then screenshots
npm run e2e -- --project=journeys
npm run e2e:screenshots
```

| Variable | Default |
|---|---|
| `E2E_BASE_URL` | `http://localhost:8080` |
| `MAILPIT_URL` | `http://localhost:8025` |

State (bootstrap enrolment tokens, authenticator secrets of the test users, used TOTP steps) is kept in
`e2e/.state/state.json`, which is git-ignored. Screenshots are written to `../docs/screenshots`.
