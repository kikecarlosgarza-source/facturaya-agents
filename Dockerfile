FROM mcr.microsoft.com/playwright:v1.59.1-jammy

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

CMD ["npm", "start"]
