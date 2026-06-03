# Bygg applikationer mot AmbCentral API

Det här dokumentet beskriver hur en extern applikation autentiserar och hämtar data från AmbCentral. Tänkt för utvecklare som vill bygga klienter mot AmbCentral.

---

## Innehåll

1. [Koncept](#koncept)
2. [API-referens](#api-referens)
3. [Autentiseringsflöde](#autentiseringsflode)
4. [Viktiga detaljer](#viktiga-detaljer)
5. [Felkoder](#felkoder)
6. [Konfiguration](#konfiguration)
7. [Exempel: bygg en egen klient](#exempel-bygg-en-egen-klient)
8. [Säkerhet](#sakerhet)
9. [Exempel: Staff Portal](#exempel-staff-portal)

---

## Koncept

AmbCentral är en central användar- och behörighetsdatabas för Ambition Sveriges ekosystem. Den innehåller:

- Medlemmar (Cogworks-speglade profiler)
- Personal med roller (administratörer, valarbetare, granskare etc.)
- Autentisering via e-postverifikation (passwordless)

**Viktigt:** AmbCentral har inga API-nycklar eller långlivade tokens. All autentisering sker via short-lived bearer tokens (12h) som fås genom ett e-postverifikationsflöde. Inget lösenord eller pre-shared secret delas mellan system.

## API-referens

Bas-URL: `http://<ambcentral-host>:5033`

### Authentication

#### POST /api/auth/login — multipurpose

Denna endpoint beter sig olika beroende på payload.

**Läge 1: Begär verifikationskod**

```json
{"email": "anna@ambitionsverige.se"}
```

| Status | Svar |
|--------|------|
| `202` | `{"challenge_id": "...", "expires_in": 600}` |
| `403` | Domän ej tillåten, eller användaren har inte staff-roll |
| `404` | Ingen medlem med den e-postadressen |
| `423` | Kontot är tillfälligt låst |
| `500` | `AUTH_ALLOWED_EMAIL_DOMAINS` ej konfigurerat |
| `503` | SMTP-fel — kunde inte skicka e-post |

**Läge 2: Verifiera kod**

```json
{
  "email": "anna@ambitionsverige.se",
  "challenge_id": "abc123...",
  "code": "482916"
}
```

| Status | Svar |
|--------|------|
| `200` | `{"access_token": "eyJ...", "expires_in": 43200, "user": {...}}` |
| `400` | Saknas fält |
| `401` | Fel kod |
| `429` | För många felaktiga försök |
| `403` | Användaren har inte längre staff-roll |

**Läge 3: System admin** (endast för nödsituationer)

```json
{"username": "ADMIN", "password": "hemligt"}
```

| Status | Svar |
|--------|------|
| `200` | `access_token` returneras |
| `401` | Fel credentials |
| `500` | System admin ej konfigurerat |

#### POST /api/auth/login/request-code

Alias — samma som läge 1 ovan.

#### POST /api/auth/login/verify-code

Alias — samma som läge 2 ovan.

#### GET /api/auth/verify

Validera token och få tillbaka användarinfo.

| Header | Värde |
|--------|-------|
| `Authorization` | `Bearer <access_token>` |

```json
{
  "authenticated": true,
  "user": {"id": 1, "ref": "U10001", "full_name": "Anna Andersson", "role": "administrator"}
}
```

| Status | Betydelse |
|--------|-----------|
| `200` | Token giltig |
| `401` | Token ogiltig eller expired |

### Staff directory

#### GET /api/staff/directory

Returnerar alla aktiva staff-användare.

| Header | Värde |
|--------|-------|
| `Authorization` | `Bearer <access_token>` |

```json
{
  "users": [
    {
      "id": 1,
      "ref": "U10001",
      "full_name": "Anna Andersson",
      "email": "anna@ambitionsverige.se",
      "phone_number": "0701111111",
      "phone_type": "mobile",
      "role": "administrator",
      "kommun": {"id": 3, "name": "Stockholm", "code": "0180"},
      "membership_status": "active"
    }
  ],
  "total": 5
}
```

| Status | Betydelse |
|--------|-----------|
| `200` | OK |
| `401` | Token saknas, ogiltig eller expired |
| `403` | Användaren har inte staff-roll |

### Medlemmar

#### GET /api/members

Lista/sök/filtrera medlemmar. Kräver token.

Parametrar (query string):

| Parameter | Typ | Beskrivning |
|-----------|-----|-------------|
| `status` | string | `active`, `inactive`, `ended` |
| `role` | string | Enskild roll eller kommaseparerad lista |
| `search` | string | Sök i namn, ref, email, postnummer |
| `kommun_id` | int | Filter per kommun |
| `gender` | string | `M` eller `F` |
| `age_min` / `age_max` | int | Åldersintervall |
| `page` | int | Sidnummer (default 1) |
| `per_page` | int | Per sida (default 50, `-1` = alla) |

```json
{
  "users": [...],
  "total": 142,
  "page": 1,
  "per_page": 50
}
```

#### GET /api/members/<id>

Enskild medlem via databas-ID.

#### GET /api/members/ref/<ref>

Enskild medlem via referensnummer, t.ex. `U12345`.

#### GET /api/members/stats

Medlemsstatistik:

```json
{
  "total": 500,
  "active": 312,
  "gender": {"M": 210, "F": 290},
  "average_age": 47.2,
  "by_kommun": {...}
}
```

### Personal/Admin

#### GET /api/staff/directory

Lista alla staff-användare (se ovan).

#### GET /api/stats/dashboard

Dashboard-statistik (aktiva medlemmar per kommun, tillväxt, demografi).

#### GET /api/auth/admins

Lista alla administratörer. Kräver `globaladmin`.

### Geografi (publika, ingen token krävs)

| Metod | Path |
|-------|------|
| `GET` | `/api/lan` |
| `GET` | `/api/lan/<id>` |
| `GET` | `/api/kommuner` |
| `GET` | `/api/kommuner/<id>` |
| `GET` | `/api/valregioner` |
| `GET` | `/api/valdistrikt` |
| `GET` | `/api/postnummer` |

### Övrigt

| Metod | Path | Kräver token |
|-------|------|:---:|
| `GET` | `/health` | Nej |
| `POST` | `/api/field-chat` | Ja |
| `GET` | `/api/events` | Nej |

---

## Autentiseringsflode

All autentisering är **passwordless** och bygger på e-postverifikation.

### Sekvensdiagram

```
App/klient              AmbCentral                     Användarens e-post
    │                        │                              │
    │  POST /api/auth/login  │                              │
    │  {"email": "a@b.se"}   │                              │
    │───────────────────────>│                              │
    │                        │  Skickar kod via SMTP        │
    │                        │─────────────────────────────>│
    │  202 {challenge_id}    │                              │
    │<───────────────────────│                              │
    │                        │                              │
    │                        │            Användaren läser  │
    │                        │            koden ur mejlen   │
    │                        │<─────────────────────────────│
    │                        │                              │
    │  POST /api/auth/login  │                              │
    │  {email, challenge_id, │                              │
    │   code: "482916"}      │                              │
    │───────────────────────>│                              │
    │                        │  Verifierar HMAC-digest      │
    │  200 {access_token,    │                              │
    │       expires_in,      │                              │
    │       user}            │                              │
    │<───────────────────────│                              │
    │                        │                              │
    │  GET /api/staff/directory                             │
    │  Authorization: Bearer eyJ...                         │
    │───────────────────────>│                              │
    │  200 {users: [...]}    │                              │
    │<───────────────────────│                              │
```

### Steg för steg

**Steg 1 — klienten anropar med enbart e-post:**

```bash
curl -X POST https://ambcentral.example.com:5033/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "anna@ambitionsverige.se"}'
```

AmbCentral slår upp mejlet, skapar en challenge, skickar en 6-siffrig kod via SMTP och returnerar `challenge_id`.

**Steg 2 — klienten anropar med e-post + challenge_id + kod:**

```bash
curl -X POST https://ambcentral.example.com:5033/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "anna@ambitionsverige.se", "challenge_id": "abc...", "code": "482916"}'
```

Vid rätt kod returneras `access_token` och användardata. Klienten sparar token (minne, session, local storage — efter behov).

**Steg 3 — klienten anropar skyddade endpoints:**

```bash
curl https://ambcentral.example.com:5033/api/staff/directory \
  -H "Authorization: Bearer eyJ..."
```

Token är giltig i 12h (`AUTH_TOKEN_MAX_AGE_SECONDS`). När den går ut måste användaren logga in igen.

### Token-format

Token är en HMAC-SHA1-signerad `itsdangerous.URLSafeTimedSerializer` — inte JWT. Den innehåller:

```json
{"member_id": 5, "role": "globaladmin"}
```

Signeras med AmbCentrals `SECRET_KEY`. Klienten ska inte parsa eller validera token själv — skicka den bara som `Authorization: Bearer ...` i headers. Validering sker på serversidan.

---

## Viktiga detaljer

### CORS

AmbCentral har CORS öppet för alla originer (`CORS(app)` utan restriktioner). Det fungerar direkt för browser-baserade klienter (fetch, AJAX). Inga extra CORS-inställningar krävs.

### Logout är client-side only

`POST /api/auth/logout` returnerar `200 OK` men gör ingenting på servern. Token fortsätter vara giltig tills den går ut. Klienten måste själv sluta använda/kasta bort token. Det finns ingen blacklist eller revocation.

### Token kan inte förnyas

Det finns ingen refresh token eller endpoint för att förlänga en token. När token går ut (efter `AUTH_TOKEN_MAX_AGE_SECONDS`, default 12h) måste användaren logga in igen — ange e-post, få en ny kod via mejl, verifiera.

### role=admin i /api/members expanderas

Vid anrop till `GET /api/members?role=admin` expanderas rollen `admin` automatiskt till `["administrator", "admin", "valarbetare"]`. Detta är praktiskt för att fånga alla varianter av admin/personal-roller.

### System admin-läget är bara för nödfall

System admin (username + password) är tänkt som en **break glass**-funktion när e-postverifikation inte fungerar. Det är ingen ersättning för det vanliga flödet. `SYSTEM_ADMIN_USER` och `SYSTEM_ADMIN_PASS` måste vara konfigurerade i miljövariabler för att fungera. Svaret innehåller en token med `role: globaladmin`.

---

## Felkoder

Alla fel returneras i samma format:

```json
{
  "error": "error_code_string",
  "message": "Human readable description"
}
```

### Login

| error_code | Status | Orsak |
|------------|:------:|-------|
| `missing_email` | 400 | Ingen e-post i requesten |
| `missing_code` | 400 | Email, challenge_id eller code saknas |
| `domain_not_allowed` | 403 | Domänen finns inte i `AUTH_ALLOWED_EMAIL_DOMAINS` |
| `access_denied` | 403 | Användaren har inte staff-roll |
| `not_found` | 404 | Ingen medlem med den e-postadressen |
| `account_locked` | 423 | Kontot låst efter för många misslyckade försök |
| `too_many_attempts` | 429 | För många felaktiga koder på denna challenge |
| `login_domain_not_configured` | 500 | Inga domäner konfigurerade |
| `email_delivery_failed` | 503 | SMTP kunde inte skicka |

### Kodverifiering

| error_code | Status | Orsak |
|------------|:------:|-------|
| `invalid_code` | 401 | Fel kod |
| `code_expired` | 401 | Koden har gått ut (10 min) |
| `invalid_token` | 401 | Token ogiltig eller användaren har tappat sin roll |
| `token_expired` | 401 | Token har gått ut (12h) |
| `missing_token` | 401 | Ingen Authorization-header |

### Staff directory

| error_code | Status | Orsak |
|------------|:------:|-------|
| `missing_token` | 401 | Ingen Bearer-token |
| `token_expired` | 401 | Token har gått ut |
| `invalid_token` | 401 | Signaturfel — manipulerad token |
| `forbidden` | 403 | Användarens roll är inte staff |

### Generellt

| Status | Betydelse |
|:------:|-----------|
| 200 | Success |
| 202 | Accepterad (kod skickad) |
| 400 | Bad request |
| 401 | Unauthorized |
| 403 | Forbidden |
| 404 | Not found |
| 423 | Locked |
| 429 | Too many attempts |
| 500 | Internal error |
| 503 | Service unavailable |

---

## Konfiguration

### AmbCentral (värdens ansvar)

```env
# Krävs för att skicka verifikationskoder
SMTP_ENABLED=true
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=username
SMTP_PASS=secret
SMTP_FROM=no-reply@ambitionsverige.se

# Domäner som tillåts logga in
AUTH_ALLOWED_EMAIL_DOMAINS=ambitionsverige.se

# Token-livslängd (default 12h)
AUTH_TOKEN_MAX_AGE_SECONDS=43200

# Verifikationskod (default 6 siffror, 10 min)
AUTH_LOGIN_CODE_LENGTH=6
AUTH_LOGIN_CODE_TTL_SECONDS=600

# Rate limiting
AUTH_LOGIN_CODE_MAX_ATTEMPTS=5

# Krävs för tokensignering
SECRET_KEY=generate-a-strong-random-secret
```

### Din klient

Enda inställningen som krävs är URL:en till AmbCentral:

```env
AMBCENTRAL_API_URL=https://ambcentral.example.com:5033
```

Om din applikation använder sessionscookies, använd en egen `SECRET_KEY` för sessionskryptering — inget som delas med AmbCentral.

---

## Exempel: bygg en egen klient

### Python

```python
import requests

API = "https://ambcentral.example.com:5033"

# Steg 1: begär kod
r = requests.post(f"{API}/api/auth/login", json={"email": "anna@ambitionsverige.se"})
data = r.json()  # {"challenge_id": "...", "expires_in": 600}

# Användaren får koden via e-post och anger den i din UI

# Steg 2: verifiera kod
r = requests.post(f"{API}/api/auth/login", json={
    "email": "anna@ambitionsverige.se",
    "challenge_id": data["challenge_id"],
    "code": "482916",
})
login = r.json()
token = login["access_token"]  # spara denna

# Steg 3: hämta staff directory
r = requests.get(
    f"{API}/api/staff/directory",
    headers={"Authorization": f"Bearer {token}"},
)
staff = r.json()["users"]
```

### JavaScript / fetch

```javascript
const API = "https://ambcentral.example.com:5033";

// Steg 1: begär kod
const res1 = await fetch(`${API}/api/auth/login`, {
  method: "POST",
  headers: {"Content-Type": "application/json"},
  body: JSON.stringify({email: "anna@ambitionsverige.se"}),
});
const {challenge_id} = await res1.json();

// Användaren anger koden från mejlen

// Steg 2: verifiera
const res2 = await fetch(`${API}/api/auth/login`, {
  method: "POST",
  headers: {"Content-Type": "application/json"},
  body: JSON.stringify({email: "anna@ambitionsverige.se", challenge_id, code: "482916"}),
});
const {access_token} = await res2.json();

// Steg 3: hämta data
const res3 = await fetch(`${API}/api/staff/directory`, {
  headers: {"Authorization": `Bearer ${access_token}`},
});
const {users} = await res3.json();
```

### curl

```bash
API="https://ambcentral.example.com:5033"

# Steg 1
curl -s $API/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"anna@ambitionsverige.se"}'

# Steg 2 (använd challenge_id från steg 1)
curl -s $API/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"anna@ambitionsverige.se","challenge_id":"abc...","code":"482916"}'

# Steg 3
TOKEN="eyJ..."
curl -s $API/api/staff/directory \
  -H "Authorization: Bearer $TOKEN"
```

---

## Sakerhet

- **Inga API-nycklar** — autentisering sker per användare via e-postverifikation
- **Short-lived tokens** (12h default) — begränsar skada vid läckage
- **Domänvalidering** — endast tillåtna e-postdomäner kan logga in
- **Rate limiting** — max 5 kodförsök per challenge
- **HMAC-signerade tokens** — kan inte förfalskas utan `SECRET_KEY`
- **Koden skickas via e-post** — kräver tillgång till användarens brevlåda

**Undvik att:**
- Lagra token i klartext i databas eller loggar
- Parsa eller lita på token-claims i klienten (validering sker på servern)
- Använda system admin-kontot i vanliga flöden (endast för krisåtkomst)
- Dela AmbCentrals `SECRET_KEY` med någon klient

---

## Exempel: Staff Portal

[Staff Portal](../staff-portal) är en fristående Flask-app som implementerar detta flöde:

1. Användaren anger sin e-post på en login-sida
2. Appen anropar AmbCentral som skickar en kod via e-post
3. Användaren anger koden på en verify-sida
4. Appen får en token och anropar `/api/staff/directory`
5. Personalregistret visas i en dashboard

Källkoden finns i `staff-portal/` — app.py, templates och tester.
Se `staff-portal/ARCHITECTURE.md` för en detaljerad beskrivning av just den implementationen.
