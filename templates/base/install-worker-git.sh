#!/bin/sh
set -eu

# Software-only image build, never a worker repair or a repository setup command.
# Git v2.56.0 is the signed upstream release tag; the archive checksum is from
# https://www.kernel.org/pub/software/scm/git/sha256sums.asc.
version=2.56.0
sha256=826817fd3671b8565586d6d49f688298de8354ab11db829c02720e5c74b9b39f

if [ "$(id -u)" -ne 0 ]; then
  echo 'Install worker Git only as root while building the base image.' >&2
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
curl --fail --silent --show-error --location --retry 1 \
  --connect-timeout 15 --max-time 120 \
  "https://www.kernel.org/pub/software/scm/git/git-$version.tar.gz" \
  --output "$work/git.tar.gz"
printf '%s  %s\n' "$sha256" "$work/git.tar.gz" | sha256sum -c -
tar -xzf "$work/git.tar.gz" -C "$work"
# Keep HTTP(S) transports; only GUI and translation tooling are unnecessary.
make -C "$work/git-$version" -j2 prefix=/usr/local NO_TCLTK=YesPlease NO_GETTEXT=YesPlease all
make -C "$work/git-$version" prefix=/usr/local NO_TCLTK=YesPlease NO_GETTEXT=YesPlease install
/usr/local/bin/git --version | grep -Fx "git version $version"
test -x /usr/local/libexec/git-core/git-remote-http
test -x /usr/local/libexec/git-core/git-remote-https
