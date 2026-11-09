# DEPLOY.md — Despliegue en Hetzner VPS

Stack objetivo: Ubuntu 24.04 LTS · nginx (reverse proxy + SSL) · systemd · pnpm · Node 20 LTS.
El mismo VPS puede convivir con tu n8n self-hosted.

## 1. Preparar el servidor

```bash
# Como root
adduser genesus && usermod -aG sudo genesus
su - genesus

# Node 20 + pnpm
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs nginx certbot python3-certbot-nginx git
corepack enable && corepack prepare pnpm@latest --activate
```

## 2. Código y dependencias

```bash
cd /opt && sudo mkdir genesus-os && sudo chown genesus:genesus genesus-os
git clone <tu-repo> /opt/genesus-os
cd /opt/genesus-os
pnpm install
pnpm build            # compila apps/web a apps/web/dist
```

## 3. Variables de entorno

```bash
cp .env.example apps/server/.env
nano apps/server/.env   # ANTHROPIC_API_KEY, SUPABASE_*, DATABASE_URL, BUDGET_DAILY_USD…
chmod 600 apps/server/.env
```

Aplica las migraciones (`supabase/migrations/0001…0003`) en tu proyecto Supabase y ejecuta `pnpm seed` una vez.

## 4. systemd para el server

`/etc/systemd/system/genesus-server.service`:

```ini
[Unit]
Description=GENESUS OS API server
After=network.target

[Service]
Type=simple
User=genesus
WorkingDirectory=/opt/genesus-os/apps/server
ExecStart=/usr/bin/env pnpm exec tsx src/index.ts
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now genesus-server
sudo journalctl -u genesus-server -f   # logs
```

> Alternativa PM2: `pm2 start "pnpm exec tsx src/index.ts" --name genesus-server --cwd /opt/genesus-os/apps/server && pm2 save && pm2 startup`.

## 5. nginx: estáticos + proxy de API + SSE

`/etc/nginx/sites-available/genesus`:

```nginx
server {
    server_name os.genesustech.com;

    # Frontend estático (Vite build)
    root /opt/genesus-os/apps/web/dist;
    index index.html;
    location / {
        try_files $uri /index.html;
    }

    # API → Fastify
    location /api/ {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        # SSE (chat GENESUS): sin buffering ni timeouts cortos
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_set_header Connection '';
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/genesus /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d os.genesustech.com   # SSL automático + renovación
```

## 6. Checklist post-deploy

- [ ] `curl https://os.genesustech.com/api/health` → `ok: true`, red 1000/10000
- [ ] Network tab del navegador: cero llamadas a `api.anthropic.com`
- [ ] `pnpm seed` ejecutado: `select count(*) from agents` = 1000
- [ ] Presupuesto: `BUDGET_DAILY_USD` acorde al entorno (default 25)
- [ ] Webhook n8n configurado (`N8N_WEBHOOK_URL`) y probado desde Configuración
- [ ] `apps/server/.env` con permisos 600 y fuera de git
- [ ] Backup automático de Postgres (Supabase lo incluye) y de workflows n8n
