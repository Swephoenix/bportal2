# Bportalen Backend

Backendserver för Bportalen.

## Starta

Se först till att Ollama kör lokalt och att modellen finns installerad:

```bash
ollama pull granite4.1:3b
ollama serve
```

Chatten anropar som standard `http://127.0.0.1:11434/api/chat` med modellen `granite4.1:3b`.
Den använder `num_ctx=7500` och `num_predict=120` som standard.
Modellen skickas med `keep_alive=-1` som standard, så Ollama behåller den laddad utan timeout.
Backenden kör ingen egen warmup-loop som standard. För produktion bör modellen laddas vid boot oberoende av backend med systemd-konfigurationen i `../ops/systemd`.
Det kan ändras med miljövariablerna `OLLAMA_URL`, `OLLAMA_MODEL`, `OLLAMA_NUM_CTX`, `OLLAMA_NUM_PREDICT`, `OLLAMA_KEEP_ALIVE`, `OLLAMA_WARMUP` och `OLLAMA_WARMUP_INTERVAL_MS`.

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
- `POST /api/ai/suggest` skickar chattmeddelanden till Ollama och returnerar svar samt eventuell avdelningsrekommendation.

## Test

```bash
cd backend
npm test
```
