# pictocity server + editor. Build: docker build -t pictocity .   Run: docker run -p 4100:4100 -v pictocity-data:/app/data pictocity
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/mcp/package.json packages/mcp/
COPY packages/editor/package.json packages/editor/
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PICTOCITY_PORT=4100 PICTOCITY_DATA=/app/data
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/packages/core/package.json packages/core/
COPY --from=build /app/packages/server/package.json packages/server/
COPY --from=build /app/packages/mcp/package.json packages/mcp/
COPY --from=build /app/packages/editor/package.json packages/editor/
RUN npm ci --omit=dev
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/mcp/dist packages/mcp/dist
COPY --from=build /app/packages/editor/dist packages/editor/dist
COPY fonts fonts
VOLUME ["/app/data"]
EXPOSE 4100
CMD ["node", "packages/server/dist/index.js"]
