FROM oven/bun:1

WORKDIR /app
COPY package.json package-lock.json ./
RUN bun install --no-save
COPY . .

EXPOSE 3000
CMD ["bun", "src/main.ts"]
