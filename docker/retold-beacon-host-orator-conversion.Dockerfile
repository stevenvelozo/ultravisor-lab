# retold-beacon-host-orator-conversion container image, built on demand
# by the lab.  Installs retold-beacon-host + the published orator-conversion
# module from npm, plus the native conversion binaries orator-conversion
# shells out to at runtime (ffmpeg/ffprobe for media, poppler-utils for
# PDF rasterization, imagemagick for fallback image ops; libvips is pulled
# in transitively by sharp's npm install).
#
# Build args:
#   HOST_VERSION      -- retold-beacon-host npm version
#   PROVIDER_PACKAGE  -- 'orator-conversion' (passed by the lab from the
#                        stanza; same build args shape as the generic
#                        published-provider path)
#   PROVIDER_VERSION  -- orator-conversion npm version
#
# Runtime:
#   Entrypoint is retold-beacon-host's bin.  CMD is supplied by the lab
#   at `docker run` time (--port / --beacon-name / --ultravisor-url /
#   --provider <pkg/submodule> / --config /app/data/config.json).

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-bookworm-slim

ARG HOST_VERSION=latest
ARG PROVIDER_PACKAGE
ARG PROVIDER_VERSION=latest

ENV NODE_ENV=production
WORKDIR /app

# Native conversion binaries.  orator-conversion's ImagePng/Jpg/Resize/etc.
# go through sharp (native npm module installed below); PDF rasterization
# uses pdftoppm from poppler-utils; media actions use ffmpeg/ffprobe.
# pdftk-java is NOT included -- install it downstream if your workflow
# needs PDF tool operations orator-conversion exposes via PdftkPath.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		ca-certificates \
		ffmpeg \
		poppler-utils \
	&& rm -rf /var/lib/apt/lists/* \
	&& npm init -y >/dev/null \
	&& npm install --omit=dev --ignore-scripts \
		"retold-beacon-host@${HOST_VERSION}" \
		"${PROVIDER_PACKAGE}@${PROVIDER_VERSION}" \
	&& npm cache clean --force

VOLUME ["/app/data"]

EXPOSE 54500

ENTRYPOINT ["node", "/app/node_modules/retold-beacon-host/bin/retold-beacon-host.js"]
