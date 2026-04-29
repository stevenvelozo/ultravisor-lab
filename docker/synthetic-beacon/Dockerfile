# Lab synthetic beacon container image.
#
# Built on demand by LabBeaconContainerManager when a 'lab-synthetic-beacon'
# beacon row is created with Runtime='container'.  Unlike the other beacon
# images in this directory, the synthetic beacon is NOT a published npm
# package -- its source lives inside ultravisor-lab itself, under
# source/synthetic-beacon/.  The container manager's prepare step is
# expected to stage that directory next to this Dockerfile as
# `synthetic-beacon-src/` before invoking docker build.
#
# Wiring note (carve-out): the container manager today assumes either an
# npm-published package or a sibling-repo source tarball.  Lab-bundled
# beacons are a new case; if the existing prepare path doesn't already
# handle Source='lab-local' descriptors, a small extension is needed --
# copy <PackageRoot>/source/synthetic-beacon/ into the build context as
# synthetic-beacon-src/ and proceed.  Until then, child-process mode is
# the supported path for the harness; Docker mode is opt-in.

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-bookworm-slim

ARG ULTRAVISOR_BEACON_VERSION=^0.0.13

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		ca-certificates \
	&& rm -rf /var/lib/apt/lists/* \
	&& npm init -y >/dev/null \
	&& npm install --omit=dev "ultravisor-beacon@${ULTRAVISOR_BEACON_VERSION}" \
	&& npm cache clean --force \
	&& rm -rf /root/.npm

COPY synthetic-beacon-src/ /app/synthetic-beacon/

VOLUME ["/app/data"]

ENTRYPOINT ["node", "/app/synthetic-beacon/bin/synthetic-beacon-runner.js"]
