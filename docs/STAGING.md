# Staging Environment

Staging mirrors production with reduced safety nets and staging-specific CORS / model keys.

## Files

- `.env.staging` – environment variables for staging
- `docker-compose.staging.yml` – compose stack for server + web

## Usage

### Local with Docker Compose

```bash
cp .env.example .env.staging
# Edit .env.staging and set the staging credentials before starting.
docker compose -f docker-compose.staging.yml up --build
```

Server, API, and web app: http://localhost:4096
The root URL serves the web app; API routes remain on the same origin.

### CI/CD

Inject secrets via CI:

- `MIRA_TOKEN`
- `OPENROUTER_API_KEY`
- `ANTHROPIC_API_KEY`
- `NVIDIA_API_KEY`

Set `NODE_ENV=staging` and `MIRA_STRICT_AUTH=1`, `MIRA_TRUST_PROXY=1`.

## Notes

- CORS_ORIGINS must include staging domain.
- Autopilot disabled by default in staging.
- DB path is local SQLite; for persistent staging use `DATABASE_URL` Postgres.
