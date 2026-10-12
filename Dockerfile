FROM node:24.14.1-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
COPY locales ./locales
COPY scripts ./scripts
COPY public ./public
COPY tailwind.config.cjs ./
RUN npm run build

FROM node:24.14.1-bookworm-slim
ENV NODE_ENV=production CONTEXTFIDELITY_MODE=hosted CONTEXTFIDELITY_PORT=8899 CONTEXTFIDELITY_DATA_DIR=/app/data
WORKDIR /app
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/locales ./locales
COPY --from=build --chown=node:node /app/public ./public
COPY --chown=node:node package.json LICENSE ./
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8899
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 CMD node -e "require('node:http').get({host:'127.0.0.1',port:8899,path:'/healthz',headers:{host:new URL(process.env.PUBLIC_ORIGIN || 'http://127.0.0.1:8899').host}},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "src/server.js"]
