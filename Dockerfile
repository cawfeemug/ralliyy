# Small official Node image on Alpine Linux, pinned to the LTS major version.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# Copy only the dependency manifests first. Docker caches this layer, so
# `npm ci` reruns only when dependencies change, not on every code edit.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY migrations ./migrations
COPY public ./public

# Run as the unprivileged user that the Node image provides, not root.
USER node

EXPOSE 3000
CMD ["node", "src/server.js"]
