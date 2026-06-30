# Hosted Daemon TLS + Entra Desktop Login

This runbook covers the hosted Autopod daemon used by Azure Container Apps
Sandboxes:

```text
https://autopod-daemon-ewi.swedencentral.cloudapp.azure.com
```

## Target State

- Caddy terminates public HTTPS on the daemon VM and proxies to
  `127.0.0.1:3100`.
- Desktop clients use native Microsoft Entra sign-in and send Entra access
  tokens to the daemon.
- Sandbox MCP traffic uses
  `AUTOPOD_MCP_BASE_URL=https://autopod-daemon-ewi.swedencentral.cloudapp.azure.com`.
- Docker/local execution preview links returned to desktop clients use the daemon
  request host, or `AUTOPOD_PREVIEW_PUBLIC_HOST` when set, instead of
  `127.0.0.1`.
- Direct public access to daemon `:3100` is closed or restricted after HTTPS is
  verified.
- The macOS app has no ATS exception for plain HTTP to the hosted daemon.

Local development remains unchanged: `http://localhost:3100` and the local dev
token are still supported.

## Entra App Registration

The desktop app is a native/mobile public client. Do not add Web or SPA redirect
URIs for the macOS app.

Required registration values:

```text
Tenant ID: 0d3aa8f9-8168-4bc2-bda1-c3972e6d9352
Client ID: 3ccd604d-3887-4309-9988-739358fb5811
Application ID URI: api://3ccd604d-3887-4309-9988-739358fb5811
Delegated scope: access_as_user
Native redirect URI: msauth.com.autopod.desktop://auth
```

Azure CLI:

```bash
az ad app update \
  --id 3ccd604d-3887-4309-9988-739358fb5811 \
  --public-client-redirect-uris \
    http://localhost \
    msauth.com.autopod.desktop://auth
```

Portal path: Entra ID -> App registrations -> `ewi` -> Authentication ->
Platform configurations -> Mobile and desktop applications -> Redirect URIs.

The daemon must accept the same audience:

```bash
ENTRA_CLIENT_ID=3ccd604d-3887-4309-9988-739358fb5811
ENTRA_TENANT_ID=0d3aa8f9-8168-4bc2-bda1-c3972e6d9352
ENTRA_AUDIENCE=api://3ccd604d-3887-4309-9988-739358fb5811
NODE_ENV=production
```

## Caddy Reverse Proxy

Install Caddy on the daemon VM:

```bash
sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y caddy
```

Use this `/etc/caddy/Caddyfile`:

```caddyfile
{
  auto_https disable_redirects
}

autopod-daemon-ewi.swedencentral.cloudapp.azure.com:443 {
  encode zstd gzip
  reverse_proxy 127.0.0.1:3100
}
```

Then:

```bash
sudo systemctl enable caddy
sudo systemctl restart caddy
sudo journalctl -u caddy -n 120 --no-pager
```

Caddy preserves `Authorization` headers, WebSocket upgrades, HTTP streaming, and
MCP request bodies by default when using `reverse_proxy`.

## Azure NSG

Inbound `443/tcp` must be open before Let's Encrypt can issue the certificate.
Caddy can solve TLS-ALPN-01 on `443`; inbound `80/tcp` does not need to be public
for certificate issuance if `443` is reachable.

Find the VM NIC and NSG:

```bash
az vm list -g ewi-sandboxes -d -o table
az network nsg list -g ewi-sandboxes -o table
az network nsg rule list -g ewi-sandboxes --nsg-name <nsg-name> -o table
```

Add HTTPS:

```bash
az network nsg rule create \
  --resource-group ewi-sandboxes \
  --nsg-name <nsg-name> \
  --name AllowHttpsAutopodDaemon \
  --priority 110 \
  --direction Inbound \
  --access Allow \
  --protocol Tcp \
  --source-address-prefixes Internet \
  --source-port-ranges '*' \
  --destination-address-prefixes '*' \
  --destination-port-ranges 443
```

### Preview App Ports

For Docker-backed pods running on the VM, Autopod maps the app container port to
a random VM host port in `10000-48999`. The API rewrites loopback preview URLs
like `http://127.0.0.1:15000` to the daemon's public host, for example
`http://autopod-daemon-ewi.swedencentral.cloudapp.azure.com:15000`.

To use desktop "Open App" against VM-hosted Docker pods, allow that preview port
range only from trusted operator IPs or a private overlay network. If the daemon
is reached through a hostname that should not be used for previews, set:

```ini
[Service]
Environment=AUTOPOD_PREVIEW_PUBLIC_HOST=<preview-hostname-or-tailscale-name>
```

Azure Container Apps Sandboxes still do not expose Docker-style host port
forwarding; this preview-port rule applies to Docker/local execution pods on the
VM.

After HTTPS is verified, close or restrict direct daemon `3100/tcp`:

```bash
az network nsg rule delete \
  --resource-group ewi-sandboxes \
  --nsg-name <nsg-name> \
  --name <rule-that-allows-3100>
```

If rollback access is needed, recreate a temporary `3100/tcp` rule restricted to
trusted operator IPs only.

## Daemon MCP URL

After HTTPS works, set the daemon's MCP base URL to the public HTTPS origin used
by sandbox pods:

```bash
sudo systemctl edit autopod-daemon
```

Drop-in:

```ini
[Service]
Environment=AUTOPOD_MCP_BASE_URL=https://autopod-daemon-ewi.swedencentral.cloudapp.azure.com
```

Apply:

```bash
sudo systemctl daemon-reload
sudo systemctl restart autopod-daemon
sudo systemctl restart caddy
```

## Verification

Run the consolidated hosted-daemon gate check from the repo root:

```bash
node scripts/check-hosted-daemon-tls-entra.mjs
```

It verifies HTTPS health, authenticated `/pods/stats`, native redirect
registration, Azure resource-group access, and that direct public `:3100` is no
longer reachable from the current client. During staged setup, use
`--skip-auth` or `--skip-azure` to check only the network gates.

External health over HTTPS:

```bash
curl -sS https://autopod-daemon-ewi.swedencentral.cloudapp.azure.com/health
```

Authenticated API over HTTPS:

```bash
TOKEN="$(ap token)"
curl -sS \
  -H "Authorization: Bearer $TOKEN" \
  https://autopod-daemon-ewi.swedencentral.cloudapp.azure.com/pods/stats
```

Desktop:

1. Open Settings -> Connections -> add connection.
2. URL:
   `https://autopod-daemon-ewi.swedencentral.cloudapp.azure.com`
3. Select Microsoft auth.
4. Sign in with a user from tenant `0d3aa8f9-8168-4bc2-bda1-c3972e6d9352`.
5. Test connection, save, then verify pods and profiles load.

Sandbox MCP smoke:

```bash
ap pod create \
  --profile <sandbox-profile-with-warmImageTag> \
  --task "Report a one-line MCP smoke result, then exit."
```

The pod should run through the sandbox target, reach MCP through the HTTPS base
URL, report a summary, and clean up.

## Rollback

To roll back TLS without touching the daemon:

```bash
sudo systemctl stop caddy
sudo systemctl disable caddy
sudo systemctl start autopod-mcp-proxy
```

Then restore the old HTTP MCP base URL if needed:

```ini
[Service]
Environment=AUTOPOD_MCP_BASE_URL=http://autopod-daemon-ewi.swedencentral.cloudapp.azure.com
```

Only keep the HTTP rollback path temporarily. The production posture is HTTPS
with Entra tokens and no public direct daemon port.
