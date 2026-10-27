# 実行時の外部ライブラリは不要（Node.js 標準機能のみ）なので、ソースをコピーするだけ
FROM node:22-slim

ENV NODE_ENV=production \
    TZ=Asia/Tokyo \
    DATA_DIR=/data
WORKDIR /app

COPY package.json ./
COPY src ./src

# Railway の Volume は root 所有でマウントされるため、root のまま実行する
RUN mkdir -p /data

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.ts"]
