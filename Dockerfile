FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

CMD ["npm", "start"]
