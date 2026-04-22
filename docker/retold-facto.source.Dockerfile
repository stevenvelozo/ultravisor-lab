# retold-facto container image -- source-build variant.
#
# Mirrors retold-databeacon.source.Dockerfile: the lab npm-packs the
# sibling monorepo checkout, stages the .tgz into a per-beacon context
# dir, and this Dockerfile installs the tarball instead of the registry
# package.  Transitive deps still come from the registry, so only the
# top-level retold-facto module reflects unpublished developer edits.
#
# python3/make/g++ are needed because better-sqlite3 (pulled in by the
# meadow-connection-sqlite dependency) builds a native addon at install
# time; same shape as the npm-mode Dockerfile.

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
		python3 \
		make \
		g++ \
	&& rm -rf /var/lib/apt/lists/* \
	&& npm init -y >/dev/null \
	&& npm install --omit=dev /tmp/source.tgz "meadow-connection-sqlite@^1.0.18" \
	&& npm cache clean --force \
	&& apt-get purge -y python3 make g++ \
	&& apt-get autoremove -y \
	&& rm -rf /root/.npm \
	&& rm -f /tmp/source.tgz

VOLUME ["/app/data"]

EXPOSE 8386

ENTRYPOINT ["node", "/app/node_modules/retold-facto/bin/retold-facto.js"]
CMD ["serve", "--port", "8386", "--config", "/app/data/config.json"]
