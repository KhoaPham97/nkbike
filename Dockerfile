# Run the existing Node.js backend in Cloudflare Containers.
# Keep Node 22 because package.json declares >=22 <23.
FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001
ENV ENABLE_BACKGROUND_JOBS=true

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .

EXPOSE 3001

CMD ["node", "index.js"]
