# syntax=docker/dockerfile:1

# Build with the full toolchain, ship without it.
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# `tsc` emits .js and nothing else, so the migrations travel separately.
RUN cp -r src/db/migrations dist/db/migrations

# Prune in the build stage: `npm ci --omit=dev` needs the lockfile and a
# toolchain for @node-rs/argon2's optional native package, and doing it here
# keeps both out of the final image.
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Runs unprivileged. The node image already has a `node` user, so this is one line
# rather than a useradd.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node

EXPOSE 3000

# No migrate-on-boot: two containers applying the same migration is a deadlock,
# and a process that migrates as it starts cannot be run twice. The deploy runs
# `node dist/db/migrate.js` as its own step.
CMD ["node", "dist/server.js"]
