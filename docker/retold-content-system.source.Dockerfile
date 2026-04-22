# retold-content-system container image -- source-build variant.
#
# See retold-databeacon.source.Dockerfile for the lab-side packing dance.
# Same runtime layout as the npm-mode image -- only the install source
# changes from the registry to the staged tarball.

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
	&& npm install --omit=dev --ignore-scripts /tmp/source.tgz \
	&& npm cache clean --force \
	&& rm -f /tmp/source.tgz

VOLUME ["/app/data", "/app/content"]

EXPOSE 7780

ENTRYPOINT ["node", "/app/node_modules/retold-content-system/source/cli/ContentSystem-CLI-Run.js"]
