# retold-remote container image -- source-build variant.
#
# See retold-databeacon.source.Dockerfile for the lab-side packing dance.
# Runtime deps (libvips / dcraw / ffmpeg) match the npm-mode image.

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
	&& apt-get install -y --no-install-recommends \
		ca-certificates \
		ffmpeg \
		dcraw \
	&& rm -rf /var/lib/apt/lists/* \
	&& npm init -y >/dev/null \
	&& npm install --omit=dev --ignore-scripts /tmp/source.tgz \
	&& npm cache clean --force \
	&& rm -f /tmp/source.tgz

VOLUME ["/app/data", "/app/content"]

EXPOSE 7777

ENTRYPOINT ["node", "/app/node_modules/retold-remote/source/cli/RetoldRemote-CLI-Run.js"]
