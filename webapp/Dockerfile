# Multi-stage build for the web dashboard: build the frontend, build the
# backend, then a slim runtime image with production deps only. Fully
# independent of the bot's own Dockerfile (docker/Dockerfile) -- this one
# never touches the Python source.
#
# Build from the REPO ROOT (needs both webapp/frontend and webapp/backend
# in its context), e.g.:
#   docker build -t police-chief-webapp:latest -f webapp/Dockerfile .

FROM node:22-slim AS frontend-builder
WORKDIR /app/webapp/frontend
COPY webapp/frontend/package*.json ./
RUN npm ci
COPY webapp/frontend/ ./
RUN npm run build

FROM node:22-slim AS backend-builder
WORKDIR /app/webapp/backend
COPY webapp/backend/package*.json ./
# --ignore-scripts: this stage only runs `tsc` to produce dist/ -- it never
# executes the app, so better-sqlite3's compiled native binding (which
# needs a C++ toolchain this slim stage doesn't have) is irrelevant here.
# tsc only needs @types/better-sqlite3's type declarations, which install
# fine without running the native build. The runtime stage below installs
# the toolchain and does a real, executable install separately.
RUN npm ci --ignore-scripts
COPY webapp/backend/ ./
RUN npm run build

FROM node:22-slim AS runtime
LABEL maintainer="police-chief-bot"
LABEL org.opencontainers.image.description="Police Chief Discord bot - web dashboard"

WORKDIR /app/webapp/backend

# better-sqlite3 is a native module -- build it here (same base image as
# the builder stages, so the compiled binding matches this runtime's node
# ABI) rather than copying node_modules from another stage. The
# build toolchain is purged again immediately after so it doesn't linger
# in the final image.
COPY webapp/backend/package*.json ./
RUN apt-get update \
    && apt-get install --no-install-recommends -y python3 make g++ \
    && npm ci --omit=dev \
    && apt-get purge -y python3 make g++ \
    && apt-get -y autoremove && apt-get -y autoclean \
    && rm -rf /var/lib/apt/lists/*

COPY --from=backend-builder /app/webapp/backend/dist ./dist
COPY --from=frontend-builder /app/webapp/frontend/dist /app/webapp/frontend/dist

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "dist/server.js"]
