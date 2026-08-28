# Mira Production Setup

## 1. Server deployment

**Environment file**
Create `~/.mira/mira.env` with at least:
```
MIRA_TOKEN=<32+ char random secret>
MIRA_DB=/home/<user>/.mira/data/mira.db
HOST=127.0.0.1
PORT=4096
CORS_ORIGINS=https://yourdomain.com
NODE_ENV=production
MIRA_STRICT_AUTH=1
```

Generate token:
```bash
openssl rand -hex 32
```

**Start server**
```bash
scripts/serve-local.sh start
# status
scripts/serve-local.sh status
```

Auth is enforced in production: `/healthz` and `/metrics` are public, all other routes require `Authorization: Bearer <MIRA_TOKEN>` or API key.

Optional multi-tenant:
```
MIRA_API_KEYS=key1:alice,key2:bob
```
Each key maps to an ownerID. Sessions are scoped to the owner.

### Issuing per-user API keys at runtime

Instead of editing `MIRA_API_KEYS` and restarting, an admin can mint scoped keys
on the fly via the built-in admin endpoint. It requires the **master** `MIRA_TOKEN`
(owner `default`); in open/dev mode (no `MIRA_TOKEN`) it is reachable without auth.

```bash
# Mint a key for a user (returns the raw key once)
curl -X POST https://<your-domain>/admin/api-keys \
  -H "Authorization: Bearer $MIRA_TOKEN" \
  -d '{"owner":"alice"}'
# → {"key":"<96-hex>","owner":"alice"}

# List issued keys (raw keys masked in the response)
curl https://<your-domain>/admin/api-keys -H "Authorization: Bearer $MIRA_TOKEN"

# Revoke a key
curl -X DELETE https://<your-domain>/admin/api-keys/<key> \
  -H "Authorization: Bearer $MIRA_TOKEN"
```

Issued keys are persisted in the `api_keys` table and reloaded on restart, so they
survive reboots. Hand the `key` to the user — they paste it into the web UI
(Settings → token), which stores it in `localStorage.mira_token`.

## 2. Web UI

**Build**
```bash
cd packages/web
npm run build
```
Build output goes to `dist/`. `base` is set from `VITE_BASE`, default `/mira/`.

For production, **do not** embed token in build. Users enter token in Settings UI which stores it in `localStorage.mira_token`.

**CORS**
Set `CORS_ORIGINS` to your production domain(s). Comma-separated.

## 3. Public access

### Option A: Cloudflare quick tunnel (no account)
```bash
scripts/cloudflare-local.sh api start   # 4096
scripts/cloudflare-local.sh web start   # 3000
```
Or combined:
```bash
scripts/dev-all.sh start
```

### Option B: Named tunnel / reverse proxy
Create a named tunnel and route via DNS:
```bash
cloudflared tunnel login
cloudflared tunnel create mira
cloudflared tunnel route dns mira mira.yourdomain.com
```
Then point it to `http://127.0.0.1:4096` for API and `http://127.0.0.1:3000` for web.

### Option C: zrok reserved name
```bash
zrok enable <account token>
zrok create name <your-name> -n public
zrok share public -n public:<your-name> http://127.0.0.1:4096 --headless
```
Reserved URL: `https://<your-name>.shares.zrok.io`

## 4. Backups & maintenance

```bash
scripts/backup-db.sh      # dump + gzip, keeps last 7
scripts/wait-for-health.sh
scripts/watch-local.sh    # watchdog + nightly backup + weekly GC
```

## 5. Security checklist

- [ ] `MIRA_TOKEN` is random, not `change-me-to-a-long-random-secret`
- [ ] `NODE_ENV=production` and `MIRA_STRICT_AUTH=1`
- [ ] `HOST=127.0.0.1` — never bind public; expose via tunnel/reverse proxy
- [ ] `CORS_ORIGINS` limited to your domain(s)
- [ ] Backups run nightly, retained 7 days
- [ ] `scripts/serve-local.sh` warns if token missing in prod

## 6. Quick start for production

```bash
# 1. Config
cat > ~/.mira/mira.env <<EOF
MIRA_TOKEN=$(openssl rand -hex 32)
MIRA_DB=$HOME/.mira/data/mira.db
HOST=127.0.0.1
PORT=4096
CORS_ORIGINS=https://yourdomain.com
NODE_ENV=production
MIRA_STRICT_AUTH=1
EOF

# 2. Server
scripts/serve-local.sh start

# 3. Web build
cd packages/web && npm run build

# 4. Expose
scripts/cloudflare-local.sh api start
```

Frontend will prompt for token on first load. Save token securely.
