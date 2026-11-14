# Docker network capacity

Every local Docker pod with a network policy gets its own bridge network,
`autopod-<identity>`. Each bridge takes one subnet from dockerd's local address
pools. When the pools are used up, Docker refuses new networks with
`all predefined address pools have been fully subnetted`, and no new local pod
can start.

Without a `default-address-pools` setting, Docker allows about 31 local
subnets: 172.17–172.31 as /16s, plus 192.168.0.0/16 split into /20s. The
default `docker0` bridge uses one of them.

## What holds a subnet

| Owner | Released when |
|---|---|
| Running or validating pod | The pod is cleaned up |
| Failed pod that has not been killed | `ap kill <pod>`, or the subnet-exhaustion prune below (if no custody holds it) |
| Retained checkpoint identity (original and every `-retained-*` generation) | Not released automatically. Custody keeps the bridge until an explicit release protocol exists (#565) |

## What the daemon does

1. When `network.create` reports exhausted pools, the daemon prunes unattached
   `com.autopod.pod-network` bridges. Retained-custody bridges are never
   removed. The daemon logs the number of networks it removed and how many it
   skipped as retained, attached or failed (`Subnet pool prune finished`).
2. If the retry still fails, the pod fails with `HOST_NETWORK_CAPACITY`
   (`Pod could not start (HOST_NETWORK_CAPACITY): ...`), which includes those
   counts. It is not reported as a generic setup failure. No agent or container
   was started. Free capacity first, then retry or relaunch the task.

## Check pressure

```bash
ap health              # prints a "Docker networks:" line
ap health --json       # docker.networks in full
curl -s "$DAEMON/health?detail=full" | jq .docker.networks
```

`docker.networks` reports the following:

- `addressPools.capacity`, `used` and `free`: pool-sized subnets. `source` is
  `configured` when dockerd reports `DefaultAddressPools`, `builtin-default`
  when it reports none, and `unknown` when `docker info` failed.
- `podNetworks`: the number of autopod bridges, broken down as `retained`
  (custody-held), `attached` (live endpoints), `unattached`, `reclaimable`
  (unattached and not retained, so the prune can free them) and `unknown`
  (inspection failed).
- `reclaimableHeadroom`: `free` plus `reclaimable`. `severity` is `critical`
  at 0 and `warning` at 5 or fewer. A `critical` result makes
  `/health?detail=full` report `degraded`. Basic `/health` is unchanged.

These counts are a read-only estimate. A value that could not be measured is
`null`, never treated as healthy.

## Free capacity

- Kill failed pods you no longer need: `ap kill <pod>`.
- Do not remove retained-checkpoint bridges by hand with `docker network rm`.
  They are part of recovery custody.
- If retained checkpoints alone exhaust the pools, enlarge the host's address
  pools (below). This is a host configuration change, not a daemon change.

## Enlarge the host address pools

Recommended dockerd setting for a pod host, giving 256 networks:

```json
{
  "default-address-pools": [{ "base": "10.200.0.0/16", "size": 24 }]
}
```

Before you apply it:

- **Choose a non-overlapping range.** The base must not overlap the VM's VNet
  or subnet, peered or VPN-routed ranges, Tailscale (`100.64.0.0/10`), or any
  network that pods or the daemon must reach. Check the VNet address space and
  `ip -4 route` on the host. If 10.200.0.0/16 is taken, pick another free /16.
- **Merge, don't overwrite.** `/etc/docker/daemon.json` may already hold other
  keys. Read it first, add only `default-address-pools`, and validate the
  result with `sudo dockerd --validate --config-file /etc/docker/daemon.json`
  (Docker 23+).
- **Configured pools replace the built-in ones.** They apply to networks
  created afterwards. Existing networks, including retained-checkpoint bridges,
  keep their current subnets. Unless `bip` is set, the default `docker0` bridge
  may be renumbered from the new pool. If anything on the host names
  `172.17.0.1` (for example `AUTOPOD_CONTAINER_HOST` or a firewall rule), set
  `"bip": "172.17.0.1/16"` as well or update those references.
- **A dockerd restart is required, and it stops containers.**
  `default-address-pools` cannot be reloaded. The hosted VM runs without
  `live-restore`, so `systemctl restart docker` stops every running container,
  including pod and sidecar containers. Apply only in a maintenance window with
  no restart-blocking pods (the same check `scripts/deploy-hosted-daemon.sh`
  runs). Stopped retained containers and their networks are kept.
  `live-restore` itself is reloadable (`systemctl reload docker`). It would
  keep containers running across future dockerd restarts, but it changes
  failure semantics, so treat enabling it as a separate owner decision.

On the hosted VM there is no SSH, so run each step through
`az vm run-command invoke -g <rg> -n <vm> --command-id RunShellScript`.
This is an operator procedure. Neither the deploy script nor the daemon
applies it.

```bash
# 1. Inspect (read-only)
cat /etc/docker/daemon.json 2>/dev/null || echo '(none)'
docker info 2>/dev/null | grep -A3 'Default Address Pools' || true
ip -4 route
# 2. Write the merged daemon.json (a backup first), then validate
sudo cp -a /etc/docker/daemon.json /etc/docker/daemon.json.bak 2>/dev/null || true
sudo dockerd --validate --config-file /etc/docker/daemon.json
# 3. Maintenance window only: confirm no restart-blocking pods, then
sudo systemctl restart docker
```

Afterwards, check that `ap health` reports `Docker networks: ok` and that
`docker.networks.addressPools` shows `source: configured` with `capacity: 256`.
Then start one canary pod with a network policy.

For a newly provisioned host, put `default-address-pools` in
`/etc/docker/daemon.json` before Docker first starts, so no restart is needed.
