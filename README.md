# Custodio

Gestor de discos y respaldos para Windows: vigila la salud y el espacio de tus discos y hace copias de seguridad programadas, verificadas y sin borrar nada en el origen.

- `packages/custodio-service`: servicio local (API `/v1`, scheduler, respaldos). Corre aunque la aplicación esté cerrada.
- `packages/custodio-ui`: aplicación de escritorio (Electron), cliente del servicio por loopback.

## Desarrollo

Requiere Node 22.13 o superior.

```bash
npm install
npx playwright install chromium
npm run verify
```

Reglas del proyecto en [CLAUDE.md](CLAUDE.md), criterios en [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) y guía visual en [docs/UI-GUIDE.md](docs/UI-GUIDE.md).
