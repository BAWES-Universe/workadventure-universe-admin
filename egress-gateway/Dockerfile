# Universe's egress gateway: a small proxy every Brick computer's internet goes through (see lib/egress/gateway.ts and egress-gateway/README.md).
# Built from the repository root:  docker build -f egress-gateway/Dockerfile -t universe-egress .
FROM node:22-alpine
WORKDIR /app
RUN npm install --global --omit=dev tsx@4
COPY lib/egress/policy.ts lib/egress/gateway.ts ./lib/egress/
COPY egress-gateway/main.ts ./egress-gateway/main.ts
ENV NODE_ENV=production EGRESS_PORT=3128
EXPOSE 3128
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:3128/__egress/health || exit 1
CMD ["tsx", "egress-gateway/main.ts"]
