FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DB_PATH=/app/data/mid-east.sqlite KEY_PATH=/app/data/server.key BACKUP_DIR=/app/data/backups BACKUP_SOURCE_ROOT=/app
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node deploy ./deploy
COPY --chown=node:node content ./content
COPY --chown=node:node docs ./docs
COPY --chown=node:node tests ./tests
COPY --chown=node:node .github ./.github
COPY --chown=node:node render.yaml README*.md .dockerignore .gitignore ./
RUN mkdir -p /app/data /app/backups && chown -R node:node /app/data /app/backups
USER node
EXPOSE 3000
CMD ["node", "src/server.mjs"]
