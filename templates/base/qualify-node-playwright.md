# Disposable Node Playwright image qualification

From the repository root, on a Docker-capable machine, build each template with
a temporary local tag, then run the runtime-user Python probe. These commands
build locally only; they do not publish images or update image digests.

```sh
for template in node22-pw node22-pw-pg node24-pw node24-pw-pg; do
  docker build -f "templates/base/Dockerfile.$template" -t "autopod-qualification-$template:local" . || exit 1
  docker run --rm "autopod-qualification-$template:local" sh -c 'set -eu; python3 -m venv /tmp/qualification-venv; /tmp/qualification-venv/bin/python -c "import ensurepip, pip"' || exit 1
  docker image rm "autopod-qualification-$template:local" || exit 1
done
```

The Dockerfile also checks that the globally installed Playwright browser can
launch. Neither probe qualifies a repository's Python modules or its own
Playwright browser revision. Those are prepared and verified by the repository.
