# ultravisor container image, built on demand by the lab.
#
# Uses the published `ultravisor` npm module's bin directly (Ultravisor-Run.cjs),
# driven by a JSON config file the lab renders into the mounted data dir.
# No lab-specific startup script is baked into the image -- the only thing
# the lab adds at runtime is the config file + operation library files.
#
# Build args:
#   VERSION -- published `ultravisor` npm version.  Lab resolves from its
#              own package-lock / sibling checkout; defaults to 'latest'.
#
# Runtime:
#   Entrypoint is the ultravisor bin with `start -c /app/data/.ultravisor.json`.
#   The lab bind-mounts data/ultravisors/<id>/ into /app/data/ so the config,
#   the operation library, and the file store all surface inside the container.

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-bookworm-slim

ARG VERSION=latest

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates \
	&& rm -rf /var/lib/apt/lists/* \
	&& npm init -y >/dev/null \
	&& npm install --omit=dev --ignore-scripts "ultravisor@${VERSION}" \
	&& npm cache clean --force

# Runtime state volume -- the lab bind-mounts the ultravisor's data dir here.
# Layout expected inside: .ultravisor.json (config), operations/ (library),
# ultravisor_datastore/ (file store), ultravisor_staging/ (run artifacts).
VOLUME ["/app/data"]

EXPOSE 54321

ENTRYPOINT ["node", "/app/node_modules/ultravisor/source/cli/Ultravisor-Run.cjs"]
CMD ["start", "-c", "/app/data/.ultravisor.json"]
