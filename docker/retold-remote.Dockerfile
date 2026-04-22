# retold-remote container image, built on demand by the lab.
#
# Serves a host folder of media over HTTP via retold-remote's `serve`
# subcommand.  The lab bind-mounts the user's chosen host folder (from
# the beacon's ConfigJSON.HostContentPath) into /app/content; the CLI
# serves from there.
#
# Build arg:
#   VERSION -- retold-remote npm version
#
# Runtime:
#   Entrypoint is the retold-remote CLI.  CMD is supplied by the lab at
#   `docker run` time via argTemplate (serve /app/content -p <port>
#   -u <ultravisor-url>).

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-bookworm-slim

ARG VERSION=latest

ENV NODE_ENV=production
WORKDIR /app

# Runtime deps:
#   libvips  -- sharp native image-processing binary (npm installs its own
#               prebuilds on glibc so libvips isn't strictly required, but
#               keeping it avoids the fallback rebuild path entirely)
#   dcraw    -- RAW image decoding fallback (retold-remote uses it)
#   ffmpeg   -- video thumbnailing / probing for media listings
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		ca-certificates \
		ffmpeg \
		dcraw \
	&& rm -rf /var/lib/apt/lists/* \
	&& npm init -y >/dev/null \
	&& npm install --omit=dev --ignore-scripts "retold-remote@${VERSION}" \
	&& npm cache clean --force

VOLUME ["/app/data", "/app/content"]

EXPOSE 7777

ENTRYPOINT ["node", "/app/node_modules/retold-remote/source/cli/RetoldRemote-CLI-Run.js"]
