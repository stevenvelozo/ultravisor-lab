# retold-beacon-host-meadow-integration container image -- source-build variant.
#
# Built on demand by the lab when a capability-provider beacon's BuildSource
# is 'source'.  Shape mirrors retold-databeacon.source.Dockerfile, but with
# an extra `retold-beacon-host` install step (the host always comes from
# npm; only the provider module is packed from the sibling monorepo
# checkout).
#
# Build args:
#   SOURCE_TARBALL  -- filename of the `npm pack` output the lab stages
#                      alongside this Dockerfile (default 'source.tgz')
#   SOURCE_VERSION  -- sibling package version at pack time (metadata only)
#   HOST_VERSION    -- retold-beacon-host npm version to install
#
# Transitive dependencies of the packed provider still resolve from npm, so
# only the top-level meadow-integration module reflects unpublished edits.
# If you need to debug retold-beacon-host changes too, npm-link it into
# the sibling checkout before switching this beacon to source mode.

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-bookworm-slim

ARG SOURCE_TARBALL=source.tgz
ARG SOURCE_VERSION=source
ARG HOST_VERSION=latest

LABEL org.retold.build-source="source"
LABEL org.retold.source-version="${SOURCE_VERSION}"

ENV NODE_ENV=production
WORKDIR /app

COPY ${SOURCE_TARBALL} /tmp/source.tgz

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates \
	&& rm -rf /var/lib/apt/lists/* \
	&& npm init -y >/dev/null \
	&& npm install --omit=dev --ignore-scripts \
		"retold-beacon-host@${HOST_VERSION}" \
		/tmp/source.tgz \
	&& npm cache clean --force \
	&& rm -f /tmp/source.tgz

VOLUME ["/app/data"]

EXPOSE 54400

ENTRYPOINT ["node", "/app/node_modules/retold-beacon-host/bin/retold-beacon-host.js"]
