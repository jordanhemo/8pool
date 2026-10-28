FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

# Manifests first so the dependency layer is cached; every workspace listed in the lockfile needs its package.json.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/client/package.json apps/client/
COPY contracts/package.json contracts/
# tsx runs the TypeScript sources directly, so dev dependencies stay installed.
RUN npm ci --include=dev -w @8pool/server -w @8pool/shared

COPY packages/shared packages/shared
COPY apps/server/src apps/server/src
COPY apps/server/tsconfig.json apps/server/
COPY tsconfig.base.json ./

ENV PORT=8080 RESULTS_FILE=/data/results.json
EXPOSE 8080
CMD ["npx", "tsx", "apps/server/src/index.ts"]
