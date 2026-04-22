# retold-beacon-host-meadow-integration container image.
#
# Built on demand by the lab when a capability-provider beacon of type
# `meadow-integration` is created.  Pulls the published `retold-beacon-host`
# from npm and COPYs the lab-local provider source in from the build
# context (`docker/providers/meadow-integration/`).
#
# Build args:
#   HOST_VERSION  -- retold-beacon-host npm version to install.  Resolved
#                    by the lab from the lab's own package.json / sibling
#                    checkout; defaults to 'latest' when neither is known.
#
# Context dir:
#   docker/providers/meadow-integration/
#   (contains package.json + Retold-Beacon-Provider-MeadowIntegration.js;
#    `npm install` inside the image resolves its meadow-integration dep
#    from the npm registry.)
#
# Runtime:
#   Entrypoint is retold-beacon-host's bin.  CMD is supplied by the lab's
#   `docker run` at start time (--port / --beacon-name / --ultravisor-url
#   / --provider /app/provider / --config /app/data/config.json).

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-bookworm-slim

ARG HOST_VERSION=latest

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates \
	&& rm -rf /var/lib/apt/lists/* \
	&& npm init -y >/dev/null \
	&& npm install --omit=dev "retold-beacon-host@${HOST_VERSION}" \
	&& npm cache clean --force

# Lab-local provider package.  `COPY .` pulls this directory's contents
# (package.json + the provider JS) into /app/provider/.  The subsequent
# `npm install` inside resolves `meadow-integration` from npm.
COPY . /app/provider/
RUN cd /app/provider \
	&& npm install --omit=dev \
	&& npm cache clean --force

# Runtime state volume -- the lab bind-mounts data/beacons/<id>/ here so
# config.json surfaces at the default /app/data/config.json entrypoint.
VOLUME ["/app/data"]

EXPOSE 54400

ENTRYPOINT ["node", "/app/node_modules/retold-beacon-host/bin/retold-beacon-host.js"]
