FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY config ./config
COPY db ./db
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
# yt-dlp for server-side YouTube caption fetching (admin ingest)
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip \
  && pip install --break-system-packages --no-cache-dir yt-dlp \
  && apt-get clean && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/config ./config
COPY --from=build /app/db ./db
ENV PORT=3000
EXPOSE 3000
CMD ["node", "dist/index.js"]
