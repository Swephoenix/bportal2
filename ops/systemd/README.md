# Ollama preload

Den här systemd-konfigurationen laddar Ollama-modellen vid boot och ber Ollama behålla den laddad utan timeout (`keep_alive=-1`), oberoende av Bportalen-backenden.

## Installera

Kör på produktionsservern från projektroten:

```bash
sudo mkdir -p /opt/bportal2
sudo cp -r scripts /opt/bportal2/
sudo chmod +x /opt/bportal2/scripts/warm-ollama.sh
sudo cp ops/systemd/bportalen-ollama-warm.service /etc/systemd/system/
sudo cp ops/systemd/bportalen-ollama-warm.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now snap.ollama.listener.service
sudo systemctl enable --now bportalen-ollama-warm.service
sudo systemctl disable --now bportalen-ollama-warm.timer
```

## Kontrollera

```bash
systemctl status snap.ollama.listener.service
systemctl status bportalen-ollama-warm.service
journalctl -u snap.ollama.listener.service -n 50 --no-pager
journalctl -u bportalen-ollama-warm.service -n 50 --no-pager
```

## Konfiguration

Standardvärden finns i `bportalen-ollama-warm.service`:

- `OLLAMA_URL=http://127.0.0.1:11434`
- `OLLAMA_MODEL=granite4.1:3b`
- `OLLAMA_NUM_CTX=7500`
- `OLLAMA_KEEP_ALIVE=-1`

`keep_alive=-1` gör att Ollama behåller modellen laddad tills Ollama-tjänsten startas om eller processen behöver avslutas av systemresursskäl.
