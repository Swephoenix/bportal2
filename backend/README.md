# Bportalen Backend

Backendserver för Bportalen.

## Starta

```bash
cd backend
npm start
```

Öppna sedan:

```text
http://localhost:3001
```

## API

- `GET /api/health` kontrollerar att servern kör.
- `POST /api/login` tar `{ "username": "...", "password": "..." }`.
- `GET /api/orders` listar alla beställningar.
- `GET /api/orders?dept=Grafiska%20produktionsgruppen` filtrerar på avdelning.
- `POST /api/orders` skapar en beställning.

## Test

```bash
cd backend
npm test
```
