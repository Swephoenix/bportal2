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
- `GET /api/orders?dept=Grafikgruppen` filtrerar på avdelning.
- `POST /api/orders` skapar en beställning.
- `GET /api/departments` listar valbara avdelningar och kopplade mejladresser.
- `PUT /api/departments` ersätter avdelningslistan med nya namn och mejladresser.

## Test

```bash
cd backend
npm test
```
