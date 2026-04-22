# retold-facto container image, built on demand by the lab.
#
# The lab runs `docker build --build-arg VERSION=<npm-version>` when it
# needs to create a facto beacon.  Parallel shape to the databeacon
# Dockerfile -- just an `npm install` of the published module + a fixed
# ENTRYPOINT that reads its config from the bind-mounted /app/data/.
#
# Build arg:
#   VERSION -- retold-facto npm version to install.  Lab reads this from
#              the stanza (Docker.Version → PackageVersion fallback).

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-bookworm-slim

ARG VERSION=latest

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		ca-certificates \
		python3 \
		make \
		g++ \
	&& rm -rf /var/lib/apt/lists/* \
	&& npm init -y >/dev/null \
	&& npm install --omit=dev \
		"retold-facto@${VERSION}" \
		"meadow-connection-sqlite@^1.0.18" \
	&& npm cache clean --force \
	&& apt-get purge -y python3 make g++ \
	&& apt-get autoremove -y \
	&& rm -rf /root/.npm

# Notes:
#   - `meadow-connection-sqlite` is pinned here because retold-facto <= 0.1.0
#     declared it as a devDependency rather than a runtime dependency.
#     Later facto versions move it to `dependencies` so this explicit
#     install becomes redundant but stays harmless (npm dedupes).
#   - Scripts are NOT disabled (no `--ignore-scripts`) because better-sqlite3
#     needs its postinstall to compile the native addon.  python3/make/g++
#     are installed for that build, then purged after to keep the image lean.

VOLUME ["/app/data"]

EXPOSE 8386

ENTRYPOINT ["node", "/app/node_modules/retold-facto/bin/retold-facto.js"]
CMD ["serve", "--port", "8386", "--config", "/app/data/config.json"]
