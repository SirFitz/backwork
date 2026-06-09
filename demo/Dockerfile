FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY tracing.js server.js ./
ENV NODE_ENV=production
EXPOSE 9100
CMD ["node", "--require", "./tracing.js", "server.js"]
