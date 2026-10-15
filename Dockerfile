FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build -w web
ENV NODE_ENV=production
EXPOSE 8787
CMD ["npm", "start", "-w", "server"]
