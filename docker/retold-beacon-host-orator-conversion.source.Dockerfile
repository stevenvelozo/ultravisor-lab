# retold-beacon-host-orator-conversion container image -- source-build variant.
#
# Same shape as retold-beacon-host-meadow-integration.source.Dockerfile:
# retold-beacon-host comes from npm (at HOST_VERSION), the orator-conversion
# provider comes from a packed sibling monorepo checkout.  Native conversion
# binaries (ffmpeg, poppler-utils) match the npm-mode image so behavior is
# identical at runtime -- only the provider's JS changes.

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
	&& apt-get install -y --no-install-recommends \
		ca-certificates \
		ffmpeg \
		poppler-utils \
	&& rm -rf /var/lib/apt/lists/* \
	&& npm init -y >/dev/null \
	&& npm install --omit=dev --ignore-scripts \
		"retold-beacon-host@${HOST_VERSION}" \
		/tmp/source.tgz \
	&& npm cache clean --force \
	&& rm -f /tmp/source.tgz

VOLUME ["/app/data"]

EXPOSE 54500

ENTRYPOINT ["node", "/app/node_modules/retold-beacon-host/bin/retold-beacon-host.js"]
