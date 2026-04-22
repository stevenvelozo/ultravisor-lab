# retold-content-system container image, built on demand by the lab.
#
# Serves a host folder of markdown over HTTP via retold-content-system's
# `serve` subcommand.  The lab bind-mounts the user's chosen host folder
# (from the beacon's ConfigJSON.HostContentPath) into /app/content.
#
# Build arg:
#   VERSION -- retold-content-system npm version (>= 1.0.18 required
#              for the `--beacon <URL>` flag to actually reach the
#              UltravisorBeacon service; 1.0.17 has a bug where the
#              beacon config is silently dropped.  Local source in
#              retold/modules/apps/retold-content-system/ has the fix
#              applied; awaiting republish).
#
# Runtime:
#   Entrypoint is the content-system CLI.  CMD is supplied by the lab at
#   `docker run` time via argTemplate (serve /app/content -p <port>
#   -b <ultravisor-url> --beacon-name <name>).

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-bookworm-slim

ARG VERSION=latest

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates \
	&& rm -rf /var/lib/apt/lists/* \
	&& npm init -y >/dev/null \
	&& npm install --omit=dev --ignore-scripts "retold-content-system@${VERSION}" \
	&& npm cache clean --force

VOLUME ["/app/data", "/app/content"]

EXPOSE 7780

ENTRYPOINT ["node", "/app/node_modules/retold-content-system/source/cli/ContentSystem-CLI-Run.js"]
