FROM node:20-alpine
RUN apk add --no-cache openssl

EXPOSE 8080

WORKDIR /app

ENV NODE_ENV=production

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
