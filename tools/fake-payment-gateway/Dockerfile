# A fake payment service for staging tests. Build from this folder:  docker build -t fake-payment-gateway .
# Run:  docker run -p 8080:8080 -e CONTROL_TOKEN=<long random value> -e BASE_URL=https://fake-pay.example.org -e NOTICE_ORIGINS=https://orbit.example.org fake-payment-gateway
FROM node:20-alpine
WORKDIR /app
COPY package.json core.js definition.js notice.js server.js ./
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
USER node
CMD ["node", "server.js"]
