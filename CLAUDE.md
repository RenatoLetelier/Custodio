# Custodio

Gestor de discos y respaldos para Windows. El diseño está en `docs/SPEC.md`, los criterios de aceptación en `docs/ACCEPTANCE.md` y la guía visual en `docs/UI-GUIDE.md`. Las decisiones cerradas viven en `docs/adr/`.

> `docs/SPEC.md` y las capturas de `docs/ui-reference/` todavía no están en el repositorio. Mientras falten, `docs/ACCEPTANCE.md` y este archivo mandan, y la referencia visual sale del código de LocalProcessor y LocalStreaming (ver `docs/ui-reference/README.md`).

## Mapa del repositorio

```
packages/
  custodio-service/   API /v1, scheduler, lógica y custodio-helper (Node, sin Electron)
    src/core/         dominio: inventory-health, allocation, backup (solo puertos)
    src/adapters/     sim/ (simulados para pruebas) y windows/ (reales, bloqueados en test)
    src/api/          Fastify, rutas /v1, validación Zod, SSE
    src/db/           SQLite (node:sqlite) y migraciones numeradas
    src/helper/       custodio-helper: proceso mínimo y elevado con lista blanca
    test/aNN-*.ts     pruebas por criterio (A1–A20), con harness de reloj y discos simulados
    test/e2e/         pruebas end-to-end del proceso real del servicio (npm run e2e)
  custodio-ui/        aplicación de escritorio (Electron + React + Vite)
    src/main/         proceso principal: ventana, bandeja, notificaciones
    src/preload/      puente mínimo hacia el renderer
    src/ui/           renderer: theme/, i18n/es.json, api/ (único cliente de /v1), sections/
    e2e/              pruebas Playwright U1–U11: cada prueba arranca su propio servicio simulado
    test/             pruebas vitest de la UI (U12 analiza release.yml y compila)
.github/workflows/    release.yml: instalador de Windows en GitHub Releases al crear un tag v*
scripts/              verify.ts y acceptance.ts (conteo de criterios)
openapi.yaml          contrato de la API /v1, generado desde src/api/contract.ts
docs/                 SPEC, ACCEPTANCE, UI-GUIDE, EVENTS, adr/, ui-reference/, ui-evidence/
```

## Comandos

| Comando | Qué hace |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` en la raíz y en ambos paquetes |
| `npm run lint` | ESLint (con reglas de arquitectura y seguridad) |
| `npm test` | Vitest: pruebas unitarias y de integración de todos los paquetes |
| `npm run e2e` | Vitest: pruebas end-to-end del servicio con adaptadores simulados |
| `npm run e2e:ui` | Playwright contra el renderer y el servicio simulado; capturas en `docs/ui-evidence/` |
| `npm run build:ui` | Compila la aplicación de escritorio |
| `npm run contracts` | Regenera `openapi.yaml` y los esquemas de `docs/EVENTS.md` desde el código (las pruebas fallan si quedan desactualizados) |
| `npm run verify` | Corre todo y cuenta criterios: `ACCEPTANCE CORE n/20 PASS` y `ACCEPTANCE UI n/12 PASS` |

`npm run verify` en la raíz evalúa ambos paquetes. Dentro de `packages/custodio-service` evalúa solo CORE y dentro de `packages/custodio-ui` solo UI. Un criterio cuenta como aprobado cuando tiene al menos una prueba cuyo nombre empieza por su id (por ejemplo `A9 reanuda una copia cortada a la mitad`) y ninguna de sus pruebas falla ni está omitida.

## Stack y estructura

- Node 22, TypeScript estricto, Fastify, SQLite con migraciones (`node:sqlite`, sin módulos nativos), Zod, vitest, eslint, pino. Identificadores en inglés; documentación y textos de interfaz en español.
- Monolito modular en el servicio: módulos `inventory-health`, `allocation` y `backup` con puertos/adaptadores. `src/core` no puede mencionar localcloud, blob ni supabase (ESLint lo bloquea y A16 lo prueba). `src/core` tampoco importa adaptadores, `fs`, `child_process` ni Fastify: todo pasa por puertos. La integración con LocalCloud queda fuera de este alcance.
- El copiador es propio (decisión cerrada, [ADR-001](docs/adr/ADR-001-copiador-propio.md)) y va detrás de una interfaz. Es la pieza con más riesgo de pérdida de datos: copia a un archivo temporal en el destino, verifica el hash, renombra de forma atómica, nunca sobrescribe en el sitio y se prueba con inyección de fallos (corte a mitad de copia).
- Contract-first: la primera tarea del Goal 1 es escribir `openapi.yaml` y `docs/EVENTS.md` (definición abierta: decídela siguiendo A13 y A14) y validar las pruebas contra ellos.
  - El contrato vive en `packages/custodio-service/src/api/contract.ts` (Zod) y `src/core/shared/events.ts`; `npm run contracts` genera `openapi.yaml` y la sección de esquemas de `docs/EVENTS.md`. Toda respuesta de las pruebas se valida contra `openapi.yaml` y todo evento contra `docs/EVENTS.md`.
- Distribución: instalador de Windows publicado en GitHub Releases al crear un tag `v*` (electron-builder + GitHub Actions). Los `package.json` llevan `"private": true` y no se publica nada en npm. El instalador registra el servicio y el helper y pide permisos de administrador al instalar.
- Repo con dos paquetes: `custodio-service` (API y lógica) y `custodio-ui` (aplicación de escritorio). El nombre del producto, de la ventana y de la bandeja es **Custodio**.

## Entorno y seguridad

- Desarrollo en macOS arm64. Los adaptadores reales de Windows (smartctl, PowerShell/Get-Volume, chkdsk) se escriben pero no se ejecutan aquí. Todo se prueba con adaptadores simulados y directorios temporales.
  - Si se trabaja desde un equipo Windows rige exactamente lo mismo: los adaptadores reales tampoco se ejecutan, y quedan prohibidos además `diskpart`, `Format-Volume`, `Clear-Disk`, `Initialize-Disk`, `Remove-Partition`, `Repair-Volume` y `mountvol`.
- PROHIBIDO tocar discos reales: nada de `format`, `chkdsk`, `diskutil erase`, `dd` ni comandos sobre `/dev` o `/Volumes`. Los adaptadores reales deben negarse a ejecutarse si `NODE_ENV=test`.
- Comandos externos solo con `execFile` y argumentos en arreglo (ESLint bloquea `exec`, `execSync` y `shell: true`), rutas validadas contra la carpeta asignada, bind a `127.0.0.1`, token de servicio obligatorio.
- Privilegios mínimos: el servicio corre sin privilegios de administrador. Solo `custodio-helper` (proceso mínimo, elevado en Windows) ejecuta smartctl, lecturas de volúmenes y `chkdsk /scan`, con lista blanca de operaciones y argumentos validados; `chkdsk /f` exige una confirmación de un solo uso.
- Borrado: Custodio nunca borra en el origen. Solo borra copias en los destinos cuando el proyecto lo ordena de forma explícita.

## Producto simple y muy user friendly

- El usuario no es técnico. La interfaz usa lenguaje cotidiano en español: "copia de seguridad", "disco sano", "revisa este disco". Términos como SMART, cron, serial o WWN solo aparecen dentro de "Detalles técnicos" o "Avanzado", plegados por defecto.
- Cada pantalla responde tres preguntas: cómo está todo, qué debo hacer ahora y qué pasa si lo hago. Pocas opciones visibles, valores por defecto sensatos, configuración avanzada oculta.
- Las acciones riesgosas siempre muestran antes una previsualización en lenguaje simple ("Se copiarán 1,2 GB y no se borrará nada") y piden confirmación explícita.

## UI y UX

- Aplicación de escritorio Electron + React + TypeScript (Vite, electron-builder), con la misma identidad visual y los mismos patrones que LocalProcessor y LocalStreaming: sidebar izquierdo para navegar y panel derecho de contenido, estilo Docker Desktop.
- La fuente de verdad visual es `docs/ui-reference/`. Colores, tipografía, espaciado, radios, sombras, iconografía y patrones de layout están extraídos en `docs/UI-GUIDE.md` y en `packages/custodio-ui/src/ui/theme`. Si falta una referencia, decide con el mismo lenguaje visual y anótalo en `UI-GUIDE.md`.
- Secciones del sidebar: Resumen, Discos, Proyectos, Respaldos, Actividad y Configuración.
- Tema claro y oscuro según el sistema, navegación por teclado, textos solo desde el catálogo i18n (`src/ui/i18n/es.json`), sin strings de interfaz hardcodeadas (ESLint marca texto literal en JSX). El proceso principal (bandeja, notificaciones, título de ventana) también lee de `es.json`.
- Icono de bandeja con el color del semáforo global y notificaciones nativas.
- Diferencia clave con LocalProcessor: aquí el backend NO va embebido en Electron. El servicio corre por separado (los respaldos de las 3 am no pueden depender de que la UI esté abierta) y la UI es solo un cliente de la API `/v1` por loopback con token. El acceso remoto queda fuera de alcance.
- Tras construir cada pantalla, toma una captura con Playwright, compárala visualmente con `docs/ui-reference` y corrige diferencias de layout, espaciado, color y tipografía. Las capturas de las pruebas quedan en `docs/ui-evidence/` (helper `e2e/evidence.ts`).
  - Las pruebas de UI (`e2e/support/`) arrancan el servicio real con `CUSTODIO_ADAPTERS=sim` en un puerto libre, inyectan el mismo puente que da el preload de Electron y validan axe (sin violaciones graves) y que todo texto visible salga de `es.json`, de un formateador o de los datos del servicio.
  - En modo simulado el servicio expone `/_sim/*` (con token) para mover discos, salud y reloj; nunca existe con adaptadores reales.

## Disciplina

- Comentarios en el código: mínimos, solo los esenciales, legibles para una persona.
- Nunca borres ni debilites pruebas ni criterios para cumplir el objetivo. Si un criterio es inviable tras 3 intentos distintos documentados, escríbelo en `docs/BLOCKERS.md` y detente.
- Trabaja en la rama `feat/core-v1` con commits pequeños.
