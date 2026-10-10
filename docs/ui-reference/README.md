# Referencia visual

Esta carpeta es la fuente de verdad visual de Custodio. Debe contener capturas de LocalProcessor y LocalStreaming (claro y oscuro) de, al menos: el layout con sidebar, una vista con tarjetas, la vista de jobs, un modal de confirmación, un estado vacío y la pantalla de primer uso.

**Estado:** todavía no hay capturas. `docs/UI-GUIDE.md` y `packages/custodio-ui/src/ui/theme` se extrajeron del código fuente de esos proyectos:

| Qué | Ruta (relativa a la carpeta `Programacion`) |
| --- | --- |
| Colores, tipografía, espaciado, componentes | `LocalProcessor-Movies/src/renderer/src/styles/global.css` |
| Variantes (galería, sidebar con subtítulo) | `LocalProcessor-Photos/src/renderer/src/styles/global.css`, `LocalStreaming/src/renderer/src/styles/global.css` |
| Layout y sidebar | `LocalProcessor-Movies/src/renderer/src/App.tsx`, `.../components/Sidebar.tsx`, `LocalStreaming/src/renderer/src/components/Sidebar.tsx` |
| Modal, confirmación, estado vacío, progreso | `LocalProcessor-Movies/src/renderer/src/components/ui.tsx` |
| Vista de jobs en tiempo real | `LocalProcessor-Movies/src/renderer/src/sections/Jobs.tsx` |
| Iconos de línea | `LocalProcessor-Photos/src/renderer/src/components/icons.tsx` |
| Ventana de Electron | `LocalProcessor-Movies/src/main/window.ts` |

Cuando se agreguen capturas, nómbralas `<proyecto>-<pantalla>-<tema>.png` (por ejemplo `localprocessor-jobs-oscuro.png`) y contrasta `UI-GUIDE.md` con ellas.
