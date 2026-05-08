# facturaya-agents (Reino B)

Daemon de agentes AI que monitorea logs de `facturasat-backend` (Reino A) en
Render, detecta fallos de portales no soportados, y dispara una cadena de
agentes que exploran el portal nuevo, generan un handler, y lo commitean al
Reino A — sin intervención humana.

## Arquitectura

- **Reino A** (`facturasat-backend`): no se modifica. Ejecuta handlers
  existentes en `services/handlers/`. Logs visibles en Render.
- **Reino B** (este repo): lee logs del Reino A cada 30s, detecta fallos,
  orquesta agentes Scout → Generator → Pusher.

## Componentes

| Archivo | Responsabilidad |
| --- | --- |
| `src/index.js` | Entry point. Arranca el poller. |
| `src/poller.js` | Loop cada 30s. Llama a `renderApi.getRecentLogs()` y pasa los logs al detector. |
| `src/detector.js` | Parsea logs y detecta patrones de fallo. Por ahora solo loguea. |
| `src/lib/renderApi.js` | Cliente HTTP para la Render API (`/v1/services/{id}/logs`). |
| `src/lib/claudeApi.js` | (TODO) Wrapper de Anthropic SDK. |
| `src/agents/scout.js` | (TODO) Explora portal nuevo con Playwright. |
| `src/agents/generator.js` | (TODO) Genera handler nuevo con Claude. |
| `src/agents/pusher.js` | (TODO) Commit + push del handler al Reino A. |

## Variables de entorno

Ver `.env.example`. En producción se inyectan desde Render (Background Worker).

- `RENDER_API_KEY` — token para la Render API.
- `BACKEND_SERVICE_ID` — service ID del Reino A en Render.
- `ANTHROPIC_API_KEY` — para los agentes Generator y Scout.
- `GITHUB_PAT` — para que Pusher haga `git push` al Reino A.

## Estado

- [x] Poller + detector básico (loguean fallos detectados).
- [ ] Scout (Playwright).
- [ ] Generator (Claude API).
- [ ] Pusher (git automation).
- [ ] Despliegue en Render.
