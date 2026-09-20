# Build context is the repo root (this file sits at the very top of the
# repo, alongside the backend/ and frontend/ folders) -- both are
# available to COPY here regardless of where Buildpacks would or
# wouldn't look for a package.json. This sidesteps the exact conflict
# that broke both previous Back4App attempts:
#   - Root directory = ./backend  -> Buildpacks finds package.json and
#     builds fine, but frontend/ (a sibling folder) never makes it into
#     the container, so server.js can never find it at runtime.
#   - Root directory = blank      -> the whole repo is visible, but
#     Buildpacks can't detect a Node app since package.json is nested
#     inside backend/, not at the root Buildpacks is pointed at.
# A Dockerfile has no such restriction -- it just copies what it's told to.

FROM node:22-slim

WORKDIR /app/backend

# Dependencies first, copied and installed before the rest of the
# source -- Docker only re-runs this (slow) step when package*.json
# actually changes, not on every source edit, so most rebuilds are fast.
COPY backend/package*.json ./
RUN npm ci --omit=dev

# Rest of the backend source.
COPY backend/ ./

# The frontend, placed as a SIBLING of backend inside the image --
# exactly matching what server.js already expects
# (path.resolve(__dirname, '../frontend')), so no code changes needed.
COPY frontend/ /app/frontend/

EXPOSE 5000

CMD ["node", "server.js"]
