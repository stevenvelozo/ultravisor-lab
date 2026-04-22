# retold-databeacon container image, built on demand by the lab.
#
# The lab runs `docker build --build-arg VERSION=<npm-version> -t
# ultravisor-lab/retold-databeacon:<version> -f this-file .` when it needs
# to create a databeacon container and the image isn't already present in
# the local docker daemon.  The build argument pins the npm tarball
# resolved from the public registry, so provenance matches what `npm
# install retold-databeacon@<version>` on a developer box would fetch.
#
# Nothing in this image references files outside the image -- it's safe
# to build from any working directory.

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-bookworm-slim

# Build-time pin of the retold-databeacon package.  Exact version is set
# by the lab from the resolved retoldBeacon.docker.version or package.json
# `version` field.
ARG VERSION

ENV NODE_ENV=production
WORKDIR /app

# Install only retold-databeacon; its dependency tree brings in the
# meadow providers and orator stack.  `--omit=dev` skips test tooling.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates \
	&& rm -rf /var/lib/apt/lists/* \
	&& npm init -y >/dev/null \
	&& npm install --omit=dev "retold-databeacon@${VERSION}" \
	&& npm cache clean --force

# Per-beacon runtime state lives here; the lab bind/volume-mounts this
# path so config.json and databeacon.sqlite survive container restarts.
VOLUME ["/app/data"]

EXPOSE 8500

# The `serve` subcommand reads /app/data/config.json which the lab writes
# into the container before first start via `docker cp`.
ENTRYPOINT ["node", "/app/node_modules/retold-databeacon/bin/retold-databeacon.js"]
CMD ["serve", "--port", "8500", "--config", "/app/data/config.json"]
