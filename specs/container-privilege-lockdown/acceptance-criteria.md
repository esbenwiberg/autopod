Every container spawned by DockerContainerManager.spawn() has SecurityOpt containing no-new-privileges:true in its HostConfig
SecurityOpt no-new-privileges:true is set on containers regardless of whether network isolation is enabled
Unit tests in docker-container-manager.test.ts verify SecurityOpt is set on spawn with and without networkName
refreshFirewall continues to successfully re-apply iptables rules to a running container after this change
Existing docker-container-manager and docker-network-manager tests all remain green
A new integration test launches Chromium via Playwright inside a node22-pw container with no-new-privileges set and succeeds
The Playwright integration test is skipped gracefully when Docker is unavailable rather than failing
scripts/check-base-images.sh exits with code 0 against the current four templates/base/Dockerfile.* files
scripts/check-base-images.sh exits with a non-zero code when run against a Dockerfile containing apt-get install sudo
scripts/check-base-images.sh exits with a non-zero code when run against a Dockerfile containing usermod -aG sudo
scripts/check-base-images.sh is invoked as the first step of scripts/validate.sh
docs/proposals/9-nsenter-host-side-firewall.md exists and documents the deferred host-side nsenter firewall approach
docs/proposals/9-nsenter-host-side-firewall.md explains why no-new-privileges is insufficient against kernel-level container-escape CVEs
docs/proposals/9-nsenter-host-side-firewall.md captures the rationale for deferring and the trigger conditions for picking it up
./scripts/validate.sh passes with lint build test and the new base-image check all green
No libcap2-bin is added to any base Dockerfile
No capsh drop is appended to the firewall script in docker-network-manager.ts
Manual post-deployment verification confirms that a setuid-root binary in the container cannot escalate privileges when invoked by the autopod user
