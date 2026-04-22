# retold-beacon-host-meadow-integration container image.
#
# Built on demand by the lab when a capability-provider beacon of type
# `meadow-integration` is created.  Installs the generic retold-beacon-host
# plus the meadow-integration module (which now ships its own
# CapabilityProvider class alongside the rest of its code) from npm.
#
# Parallel shape to retold-beacon-host-orator-conversion.Dockerfile -- the
# lab passes the same build args for every published capability-provider:
#
# Build args:
#   HOST_VERSION      -- retold-beacon-host npm version to install
#   PROVIDER_PACKAGE  -- 'meadow-integration' (supplied by the lab from
#                        the module's retoldBeacon stanza)
#   PROVIDER_VERSION  -- meadow-integration npm version
#
# Runtime:
#   Entrypoint is retold-beacon-host's bin.  CMD is supplied by the lab's
#   `docker run` at start time (--port / --beacon-name / --ultravisor-url
#   / --provider <package>/<providerPath> / --config /app/data/config.json).

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-bookworm-slim

ARG HOST_VERSION=latest
ARG PROVIDER_PACKAGE
ARG PROVIDER_VERSION=latest

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates \
	&& rm -rf /var/lib/apt/lists/* \
	&& npm init -y >/dev/null \
	&& npm install --omit=dev --ignore-scripts \
		"retold-beacon-host@${HOST_VERSION}" \
		"${PROVIDER_PACKAGE}@${PROVIDER_VERSION}" \
	&& npm cache clean --force

# Runtime state volume -- the lab bind-mounts data/beacons/<id>/ here so
# config.json surfaces at the default /app/data/config.json entrypoint.
VOLUME ["/app/data"]

EXPOSE 54400

ENTRYPOINT ["node", "/app/node_modules/retold-beacon-host/bin/retold-beacon-host.js"]
