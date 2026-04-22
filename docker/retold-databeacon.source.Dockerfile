# retold-databeacon container image -- source-build variant.
#
# Built on demand by the lab when a beacon's BuildSource = 'source'.  The
# lab runs `npm pack` inside the sibling monorepo checkout of
# retold-databeacon and stages the resulting .tgz + this Dockerfile into a
# per-beacon build context under data/source-build-staging/<id>/.  That
# directory is what `docker build` sees, so COPY only reaches the tarball
# + this file (no stray repo contents leak in).
#
# Build args:
#   SOURCE_TARBALL -- filename of the .tgz relative to the context dir.
#                     Default 'source.tgz' is what the container manager
#                     renames the npm-pack output to.
#   SOURCE_VERSION -- the sibling checkout's package.json version at pack
#                     time.  Only used as metadata (LABEL); the Dockerfile
#                     doesn't otherwise care.
#
# Runtime is identical to the npm-mode image: same ENTRYPOINT, same VOLUME,
# same EXPOSE.  Only the install step changes -- npm install points at the
# local tarball instead of the registry so transitive deps still resolve
# via npm but the top-level module is whatever's on the developer's disk.

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-bookworm-slim

ARG SOURCE_TARBALL=source.tgz
ARG SOURCE_VERSION=source

LABEL org.retold.build-source="source"
LABEL org.retold.source-version="${SOURCE_VERSION}"

ENV NODE_ENV=production
WORKDIR /app

COPY ${SOURCE_TARBALL} /tmp/source.tgz

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates \
	&& rm -rf /var/lib/apt/lists/* \
	&& npm init -y >/dev/null \
	&& npm install --omit=dev /tmp/source.tgz \
	&& npm cache clean --force \
	&& rm -f /tmp/source.tgz

VOLUME ["/app/data"]

EXPOSE 8500

ENTRYPOINT ["node", "/app/node_modules/retold-databeacon/bin/retold-databeacon.js"]
CMD ["serve", "--port", "8500", "--config", "/app/data/config.json"]
