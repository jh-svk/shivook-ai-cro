FROM node:20-alpine
# openssl for Prisma; chromium + deps for the visual (geometry) variant validator.
# We use Alpine's system Chromium and point Playwright at it (Playwright's own
# downloaded browsers are glibc-built and won't run on Alpine/musl).
RUN apk add --no-cache \
  openssl \
  chromium \
  nss \
  freetype \
  harfbuzz \
  ttf-freefont \
  font-noto-emoji
# Tell Playwright to use the system Chromium and skip its own download.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Copy root and workspace package manifests so npm can resolve workspaces
# before the full source tree is present (avoids ENOWORKSPACE errors).
COPY package.json package-lock.json* ./
COPY extensions/cro-pixel/package.json extensions/cro-pixel/package.json

RUN npm ci --omit=dev && npm cache clean --force

# Copy the rest of the source (schema, routes, jobs, lib, etc.)
COPY . .

# Generate Prisma client against the real schema now that it exists.
# docker-start also runs this at startup, but doing it here speeds up
# cold-start and ensures the build step below has typed DB access.
RUN npx prisma generate

RUN npm run build

# On container start: apply any pending migrations then serve.
CMD ["npm", "run", "docker-start"]
