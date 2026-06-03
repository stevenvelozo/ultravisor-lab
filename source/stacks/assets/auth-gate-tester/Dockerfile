# Auth-gate tester for the ultravisor-lab "auth-gate-test" stack.
#
# A one-shot container that runs an assertion suite against a live, secured
# (non-promiscuous) Ultravisor + ultravisor-auth-beacon and exits 0 (all
# checks passed) or 1 (something regressed). View results with:
#   docker logs <project>-auth-gate-tester-1
#
# node:22-bookworm-slim matches Ultravisor's own runtime base.
FROM node:22-bookworm-slim

WORKDIR /app

# Install deps first for layer caching (only `ws`; everything else is built-in).
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY auth-gate-test.js ./

CMD ["node", "auth-gate-test.js"]
