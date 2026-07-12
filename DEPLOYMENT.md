# Pi-Science Deployment Guide

This document covers deploying pi-science in production environments. For development setup, see [README.md](./README.md).

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Prerequisites](#prerequisites)
3. [Environment Variables](#environment-variables)
4. [Deployment Options](#deployment-options)
   - [Option A: Single Server (systemd)](#option-a-single-server-systemd)
   - [Option B: Docker Compose](#option-b-docker-compose)
   - [Option C: Kubernetes](#option-c-kubernetes)
5. [Reverse Proxy Configuration](#reverse-proxy-configuration)
6. [Security](#security)
7. [Monitoring](#monitoring)
8. [Backup & Recovery](#backup--recovery)
9. [Troubleshooting](#troubleshooting)
10. [Scaling Considerations](#scaling-considerations)

---

## Architecture Overview

```
                     ┌──────────────┐
    Users ──────────→│  Nginx/Caddy │──→ Frontend static files
                     │  (Reverse    │──→ Backend API (FastAPI)
                     │   Proxy)     │──→ SSE connections (long-lived)
                     └──────────────┘
                            │
                     ┌──────▼──────┐
                     │  FastAPI     │
                     │  (Backend)   │──→ pi subprocess (agent runtime)
                     │              │──→ Python/R kernels (scientific compute)
                     └──────────────┘
```

**Key points for production:**
- The frontend is static files — serve via any HTTP server or CDN
- The backend uses **long-lived SSE connections** — the reverse proxy must support this
- Each active session spawns a **pi Node.js subprocess** — memory/CPU must be provisioned accordingly
- Session data lives on disk as **JSONL files** — ensure persistent volumes

---

## Prerequisites

### All deployments require:

| Component | Minimum Version | Purpose |
|-----------|----------------|---------|
| Python | 3.11+ | Backend runtime |
| Node.js | 22+ | pi agent runtime (spawned as subprocess) |
| pi + extensions | Latest | Agent runtime + MCP adapter, subagents, web access |
| LLM API Key | — | At least one provider key (or set via Settings UI) |

### pi & extensions setup

```bash
# Install pi runtime
npm install @earendil-works/pi-coding-agent

# Install extensions (optional but recommended)
npm install pi-mcp-adapter pi-subagents pi-web-access
```

Or use the bundled `scripts/fetch-pi.sh` which auto-installs everything. |

### Resource estimates (per active session):

| Resource | Light usage | Heavy usage (scientific compute) |
|----------|-------------|----------------------------------|
| RAM | ~200 MB (pi) + ~100 MB (Python) | +500 MB–2 GB (kernels) |
| CPU | 0.5 core | 2–4 cores |
| Disk | ~10 MB/session (JSONL) | +workspace artifacts |

---

## Environment Variables

All configuration is via environment variables. Create a `.env` file or set in your deployment orchestrator.

### Required

```bash
# Path to pi's CLI entry point (required)
PI_CLI_PATH=/opt/pi/dist/cli.js

# LLM API keys can be set via env vars OR via the Settings UI (stored in ~/.pi-science/config.json)
# At least one of:
ANTHROPIC_API_KEY=sk-ant-...
DEEPSEEK_API_KEY=sk-...
OPENAI_API_KEY=sk-...
```

### Recommended

```bash
# Backend
PI_SCIENCE_HOST=0.0.0.0
PI_SCIENCE_PORT=8787
PI_SCIENCE_HOME=/var/lib/pi-science          # legacy config/sessions
PI_SCIENCE_WORKSPACES=/var/lib/pi-science/workspaces
PI_SCIENCE_CORS=https://your-domain.com      # comma-separated origins

# Agent
PI_DEFAULT_MODEL=deepseek/deepseek-v4-pro
PI_DEFAULT_THINKING=high
PI_NODE_PATH=/usr/bin/node
```

### Full list

See [README.md](./README.md#2-start-the-backend) for all available variables.

---

## Deployment Options

### Option A: Single Server (systemd)

Best for: small teams, single-node deployments.

#### 1. Prepare directories

```bash
sudo mkdir -p /opt/pi-science /var/lib/pi-science/{sessions,workspaces}
sudo chown -R app:app /opt/pi-science /var/lib/pi-science
```

#### 2. Clone and build frontend

```bash
cd /opt/pi-science
git clone <your-repo> .
cd frontend
npm ci
npm run build    # → dist/
```

#### 3. Install backend dependencies

```bash
cd /opt/pi-science/backend
python3 -m venv venv
source venv/bin/activate
pip install fastapi uvicorn pydantic sse-starlette aiofiles
```

#### 4. Create environment file

```bash
# /etc/pi-science/env
PI_CLI_PATH=/opt/pi/packages/coding-agent/dist/cli.js
PI_SCIENCE_HOST=127.0.0.1
PI_SCIENCE_PORT=8787
PI_SCIENCE_HOME=/var/lib/pi-science
PI_SCIENCE_WORKSPACES=/var/lib/pi-science/workspaces
ANTHROPIC_API_KEY=sk-ant-...
```

#### 5. Create systemd service

```ini
# /etc/systemd/system/pi-science.service
[Unit]
Description=Pi-Science Backend
After=network.target

[Service]
Type=simple
User=app
Group=app
EnvironmentFile=/etc/pi-science/env
WorkingDirectory=/opt/pi-science/backend
ExecStart=/opt/pi-science/backend/venv/bin/uvicorn main:app \
  --host 127.0.0.1 --port 8787 --workers 4
Restart=always
RestartSec=5

# Resource limits
MemoryMax=4G
CPUQuota=200%

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pi-science
```

#### 6. Configure Nginx

See [Reverse Proxy Configuration](#reverse-proxy-configuration) below.

---

### Option B: Docker Compose

Best for: containerized environments, easy scaling.

#### 1. Backend Dockerfile

```dockerfile
# backend/Dockerfile
FROM python:3.12-slim

# Install Node.js for pi subprocess
RUN apt-get update && apt-get install -y nodejs npm && \
    rm -rf /var/lib/apt/lists/*

# Install pi
ARG PI_VERSION=latest
RUN npm install -g @earendil-works/pi-coding-agent@${PI_VERSION}

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PI_CLI_PATH=/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js
ENV PI_NODE_PATH=/usr/bin/node
ENV PI_SCIENCE_HOST=0.0.0.0
ENV PI_SCIENCE_PORT=8787
ENV PI_SCIENCE_HOME=/data

VOLUME ["/data", "/workspaces"]

EXPOSE 8787

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8787", "--workers", "4"]
```

#### 2. Frontend Dockerfile

```dockerfile
# frontend/Dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

#### 3. docker-compose.yml

```yaml
version: "3.8"

services:
  backend:
    build:
      context: ./backend
      args:
        PI_VERSION: "0.0.3"
    container_name: pi-science-backend
    ports:
      - "127.0.0.1:8787:8787"
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY}
      - PI_SCIENCE_HOME=/data
      - PI_SCIENCE_WORKSPACES=/workspaces
      - PI_DEFAULT_MODEL=deepseek/deepseek-v4-pro
      - PI_DEFAULT_THINKING=high
    volumes:
      - pi_science_data:/data
      - pi_science_workspaces:/workspaces
      - /var/run/docker.sock:/var/run/docker.sock  # for kernel isolation (optional)
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8787/api/health"]
      interval: 30s
      timeout: 10s
      retries: 3
    deploy:
      resources:
        limits:
          memory: 4G
          cpus: "2"

  frontend:
    build:
      context: ./frontend
    container_name: pi-science-frontend
    ports:
      - "80:80"
    depends_on:
      - backend
    restart: unless-stopped

  # Optional: Redis for session coordination (multi-instance)
  # redis:
  #   image: redis:7-alpine
  #   restart: unless-stopped

volumes:
  pi_science_data:
  pi_science_workspaces:
```

#### 4. Frontend Nginx config (frontend/nginx.conf)

```nginx
server {
    listen 80;
    server_name _;

    root /usr/share/nginx/html;
    index index.html;

    # SPA routing
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Proxy API requests to backend
    location /api/ {
        proxy_pass http://backend:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        # SSE support — disable buffering for event streams
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 24h;  # long-lived SSE connections
        chunked_transfer_encoding on;
    }
}
```

#### 5. Start

```bash
ANTHROPIC_API_KEY=sk-ant-... docker compose up -d
```

---

### Option C: Kubernetes

Best for: large-scale, multi-tenant deployments.

#### Key considerations

1. **SSE connections**: Use a load balancer that supports long-lived HTTP connections (e.g., Nginx Ingress with appropriate annotations)
2. **Session affinity**: Pi processes are stateful per-session — use sticky sessions or route by session ID
3. **Persistent volumes**: Session JSONL files and workspace artifacts need persistent storage
4. **Pi subprocess**: Each pod needs Node.js installed alongside Python

```yaml
# k8s/deployment.yaml (example)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pi-science-backend
spec:
  replicas: 2
  selector:
    matchLabels:
      app: pi-science-backend
  template:
    metadata:
      labels:
        app: pi-science-backend
    spec:
      containers:
      - name: backend
        image: pi-science-backend:latest
        ports:
        - containerPort: 8787
        env:
        - name: PI_SCIENCE_HOST
          value: "0.0.0.0"
        - name: PI_SCIENCE_PORT
          value: "8787"
        - name: ANTHROPIC_API_KEY
          valueFrom:
            secretKeyRef:
              name: pi-science-secrets
              key: anthropic-api-key
        volumeMounts:
        - name: data
          mountPath: /data
        - name: workspaces
          mountPath: /workspaces
        resources:
          requests:
            memory: "1Gi"
            cpu: "0.5"
          limits:
            memory: "4Gi"
            cpu: "2"
      volumes:
      - name: data
        persistentVolumeClaim:
          claimName: pi-science-data
      - name: workspaces
        persistentVolumeClaim:
          claimName: pi-science-workspaces
---
apiVersion: v1
kind: Service
metadata:
  name: pi-science-backend
spec:
  selector:
    app: pi-science-backend
  ports:
  - port: 8787
    targetPort: 8787
  sessionAffinity: ClientIP  # Sticky sessions for SSE
  sessionAffinityConfig:
    clientIP:
      timeoutSeconds: 3600
```

**Nginx Ingress annotations for SSE:**

```yaml
metadata:
  annotations:
    nginx.ingress.kubernetes.io/proxy-buffering: "off"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "86400"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "86400"
    nginx.ingress.kubernetes.io/affinity: "cookie"
    nginx.ingress.kubernetes.io/session-cookie-name: "pi-science-route"
    nginx.ingress.kubernetes.io/session-cookie-expires: "86400"
    nginx.ingress.kubernetes.io/session-cookie-max-age: "86400"
```

---

## Reverse Proxy Configuration

### Nginx (standalone)

```nginx
server {
    listen 443 ssl http2;
    server_name pi-science.example.com;

    ssl_certificate     /etc/ssl/pi-science.crt;
    ssl_certificate_key /etc/ssl/pi-science.key;

    # Frontend (static)
    location / {
        root /opt/pi-science/frontend/dist;
        index index.html;
        try_files $uri $uri/ /index.html;
    }

    # Backend API
    location /api/ {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Critical for SSE — disable all buffering
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 24h;
        proxy_send_timeout 24h;
        chunked_transfer_encoding on;

        # Increase body size for file uploads
        client_max_body_size 500m;
    }
}
```

### Caddy

```caddyfile
pi-science.example.com {
    # Frontend
    root * /opt/pi-science/frontend/dist
    file_server
    try_files {path} /index.html

    # Backend API
    handle /api/* {
        reverse_proxy 127.0.0.1:8787 {
            flush_interval -1  # Disable response buffering (SSE)
        }
    }
}
```

---

## Security

### API Keys

- **Never hardcode API keys**. Use environment variables or a secrets manager.
- API keys for LLM providers are passed to pi subprocesses via environment variables.
- In Kubernetes, use `SealedSecrets` or `ExternalSecrets` with a vault provider.

### Network

- The backend should bind to `127.0.0.1` unless behind a reverse proxy.
- Expose only the reverse proxy (Nginx/Caddy) to the internet.
- Use HTTPS (TLS 1.2+) for all external traffic.
- pi subprocesses communicate via local stdin/stdout — no network exposure.

### Workspace Isolation

- Each session's workspace is scoped to a directory under `PI_SCIENCE_WORKSPACES`.
- Consider running sessions in isolated containers for multi-tenant deployments.
- File API validates that requested paths are within the workspace root.

### Rate Limiting

Add rate limiting at the reverse proxy layer:

```nginx
# Nginx rate limiting
limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;
limit_req_zone $binary_remote_addr zone=prompt:10m rate=1r/s;

location /api/sessions/ {
    limit_req zone=api burst=20 nodelay;
}
location /api/sessions/*/prompt {
    limit_req zone=prompt burst=3;
}
```

---

## Monitoring

### Health Check

The backend exposes `/api/health`:

```bash
curl http://localhost:8787/api/health
# → {"status":"ok","active_pi_processes":2}
```

### Key Metrics to Monitor

| Metric | Source | Alert Threshold |
|--------|--------|-----------------|
| Backend HTTP 5xx rate | Nginx/Caddy logs | > 1% of requests |
| SSE connection drops | Backend logs | Spike |
| pi process count | `/api/health` | > 80% of capacity |
| Disk usage (sessions) | Host metrics | > 80% |
| API response latency | Backend logs | p95 > 2s |
| pi subprocess crashes | stderr logs | > 0 |

### Logging

The backend writes structured logs to stdout:

```python
# Enable debug logging
PI_SCIENCE_LOG_LEVEL=DEBUG uvicorn main:app
```

Pi subprocess stderr is captured and logged by PiManager.

---

## Backup & Recovery

### What to back up

| Path | Contents | Frequency |
|------|----------|-----------|
| `$PI_SCIENCE_WORKSPACES/` | User workspaces (artifacts + sessions) | Daily (incremental) |
| `$PI_SCIENCE_WORKSPACES/**/.pi-science/sessions/` | Per-workspace session JSONL files | Daily |
| `$PI_SCIENCE_HOME/config.json` | API keys | Weekly |
| `~/.pi/agent/auth.json` | pi API keys (legacy) | Weekly |
| `~/.pi/agent/settings.json` | pi settings | Weekly |
| `~/.config/mcp/mcp.json` | MCP server config | Weekly |

### Backup script (example)

```bash
#!/bin/bash
BACKUP_DIR=/backups/pi-science
DATE=$(date +%Y%m%d-%H%M%S)

# Session data
tar -czf "$BACKUP_DIR/sessions-$DATE.tar.gz" \
  -C /var/lib/pi-science sessions/

# Workspaces (incremental with rsync)
rsync -av --delete \
  /var/lib/pi-science/workspaces/ \
  "$BACKUP_DIR/workspaces-current/"

# Retention: keep 30 daily backups
find "$BACKUP_DIR" -name "sessions-*.tar.gz" -mtime +30 -delete
```

### Recovery

```bash
# Restore sessions
tar -xzf /backups/pi-science/sessions-20260710-120000.tar.gz \
  -C /var/lib/pi-science/

# Restore workspaces
rsync -av /backups/pi-science/workspaces-current/ \
  /var/lib/pi-science/workspaces/
```

---

## Troubleshooting

### Backend won't start

```bash
# Check Python version
python3 --version  # must be ≥ 3.11

# Check pi CLI path
ls -la $PI_CLI_PATH

# Test pi manually
node $PI_CLI_PATH --mode rpc --help
```

### "pi process exited with code …"

Common causes:
1. **Node.js version too old** — pi requires Node.js ≥ 22
2. **Missing API key** — set `ANTHROPIC_API_KEY` or equivalent
3. **Pi not installed** — `npm install -g @earendil-works/pi-coding-agent`

### SSE connections dropping

```bash
# Check proxy config — buffering must be OFF
grep -r "proxy_buffering" /etc/nginx/

# Check timeout settings
grep -r "proxy_read_timeout" /etc/nginx/
```

### Frontend can't reach backend

1. Check CORS: `PI_SCIENCE_CORS` must include the frontend origin
2. Check proxy: Vite dev server proxies `/api` to backend, production needs Nginx
3. Check firewall: port 8787 must be reachable from the frontend host

### Memory exhaustion

- Each pi subprocess uses ~200 MB baseline
- Python/R kernels add 500 MB–2 GB each
- Set resource limits in systemd/Docker/K8s
- Consider session idle timeout (`PI_SCIENCE_SESSION_IDLE_TIMEOUT`)

---

## Scaling Considerations

### Single-node scaling

- Use `--workers N` in uvicorn to handle multiple concurrent connections
- Each worker handles its own pi subprocesses
- Monitor memory — 4 workers × 4 sessions = ~800 MB baseline + kernel overhead

### Multi-node scaling

Pi-science is **stateful by design** (one pi process per session). For multi-node:

1. **Session affinity is required** — route requests for a given session to the same node
2. Use a shared filesystem (NFS, EFS) for session data and workspaces
3. Consider Redis for session-to-node mapping
4. Use Kubernetes with StatefulSet and persistent volumes

### Database (future)

For larger deployments, session data can be moved to a database:

```python
# Future: Postgres-backed session store
# - Session metadata → PostgreSQL
# - Message content → PostgreSQL (JSONB)
# - Workspace artifacts → S3/MinIO
# - pi subprocess management → Redis pub/sub for cross-node coordination
```

---

## Support

For issues, consult:
- [README.md](./README.md) — development and configuration
- `uvicorn --help` — server options
- pi documentation — agent runtime reference
- `/api/docs` — interactive API documentation (when backend is running)
