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
  pools. This is a host configuration change, not a daemon change.
