FROM node:20

WORKDIR /app

COPY backend/package*.json ./backend/
RUN cd backend && npm ci --omit=dev

COPY backend/ ./backend/
COPY assets/ ./assets/
COPY index.html lagret.html ui-helpers.js tailwind.config.cjs package*.json ./

EXPOSE 3001

VOLUME /app/backend/data

CMD ["node", "backend/server.js"]
