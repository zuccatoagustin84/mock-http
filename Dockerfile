# Mock HTTP Output API – image for Render (or any Docker host)
FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN npm install --production

# App and config
COPY server.js config.json ./

# Render sets PORT; server uses process.env.PORT || 3000
ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "start"]
