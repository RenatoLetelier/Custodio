# Guía visual de Custodio

Custodio comparte identidad visual y patrones con LocalProcessor y LocalStreaming: sidebar oscuro a la izquierda, panel de contenido claro u oscuro a la derecha, tarjetas sobrias y estado con color, al estilo Docker Desktop.

- **Fuente de verdad:** `docs/ui-reference/`. Hoy no tiene capturas; los valores de esta guía salen del código de esos proyectos (rutas en `docs/ui-reference/README.md`).
- **En código:** `packages/custodio-ui/src/ui/theme/tokens.ts` es la única fuente de los valores. `themeCss()` los convierte en variables CSS (`--panel-bg`, `--accent`…) con los mismos nombres que usan los proyectos hermanos, así sus estilos se pueden portar tal cual.
- Las decisiones propias de Custodio, donde no había referencia, están marcadas con **Decisión**.

## Color

El sidebar es oscuro en ambos temas. El panel sigue el tema del sistema (`prefers-color-scheme`).

| Token | Claro | Oscuro | Uso |
| --- | --- | --- | --- |
| `--sidebar-bg` | `#1b2028` | `#1b2028` | Fondo del sidebar |
| `--sidebar-fg` | `#d7dbe2` | `#d7dbe2` | Texto del sidebar |
| `--sidebar-fg-muted` | `#8b93a1` | `#8b93a1` | Texto secundario del sidebar |
| `--sidebar-item-hover` | `rgba(255,255,255,.06)` | igual | Ítem en hover |
| `--sidebar-item-active` | `rgba(255,255,255,.12)` | igual | Ítem activo |
| `--sidebar-divider` | `rgba(255,255,255,.08)` | igual | Borde superior del pie del sidebar |
| `--panel-bg` | `#f5f6f8` | `#14171c` | Fondo del panel |
| `--panel-fg` | `#1c2128` | `#e6e8eb` | Texto principal |
| `--panel-fg-muted` | `#5c6470` | `#9aa3b0` | Texto secundario, descripciones |
| `--panel-border` | `#e1e4e8` | `#262b33` | Bordes de tarjetas, tablas, separadores |
| `--card-bg` | `#ffffff` | `#1b1f26` | Tarjetas, modales, botones secundarios |
| `--input-bg` | `#ffffff` | `#14171c` | Campos de texto |
| `--hover-bg` | `#f0f2f5` | `#232830` | Hover de filas y botones |
| `--accent` | `#2563eb` | igual | Acción principal, logo, progreso, foco |
| `--accent-hover` | `#1d4ed8` | igual | Hover del botón principal |
| `--accent-soft` | `rgba(59,130,246,.12)` | igual | Chips, alertas informativas |
| `--accent-text` | `#1d4ed8` | `#93c5fd` | Enlaces y texto de acento |
| `--ok` / `--ok-soft` | `#16a34a` / 12 % | igual | Éxito (puntos y fondos) |
| `--warn` / `--warn-soft` | `#d97706` / 12 % | igual | Advertencia (puntos y fondos) |
| `--error` / `--error-soft` | `#dc2626` / 10 % | igual | Error, acciones destructivas |
| `--ok-text` / `--warn-text` / `--error-text` | `#166534` / `#92400e` / `#b91c1c` | `#4ade80` / `#fbbf24` / `#fca5a5` | Texto de badges y avisos |
| `--muted-soft` | `rgba(92,100,112,.14)` | igual | Badges neutros, fondo de barras de progreso |
| `--backdrop` | `rgba(0,0,0,.45)` | igual | Fondo detrás de modales |

**Decisión (contraste AA):** LocalProcessor usa `#3b82f6` como acento, pero con texto blanco da 3,7:1 y axe lo marca como violación grave. Custodio oscurece el acento a `#2563eb` (5,2:1) y usa tonos `*-text` más oscuros en claro y más claros en oscuro para el texto de badges y avisos. Los puntos de color mantienen los tonos originales.

### Semáforo de salud (Decisión)

Custodio agrega el semáforo sobre los tonos de estado existentes. La salud se comunica siempre con color **y** texto, nunca solo con color.

| Estado | Token | Color | Frase tipo |
| --- | --- | --- | --- |
| Verde | `--semaphore-green` | `#16a34a` (`--ok`) | "Disco sano" |
| Amarillo | `--semaphore-yellow` | `#d97706` (`--warn`) | "Revisa este disco" |
| Rojo | `--semaphore-red` | `#dc2626` (`--error`) | "Este disco está fallando" |
| Desconocido | `--semaphore-unknown` | `#8b93a1` (`--sidebar-fg-muted`) | "Sin información de salud" |

"Desconocido" nunca usa el verde (A2). El icono de bandeja usa estos mismos colores (U10).

## Tipografía

- Familia: `system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif` (Segoe UI en Windows). Monoespaciada: `ui-monospace, Consolas, monospace` a 12 px, solo dentro de "Detalles técnicos".
- Base 14 px, interlineado 1,45, suavizado `antialiased`.
- Títulos con peso 600; el logo y los métodos HTTP con 700.

| Uso | Tamaño | Peso |
| --- | --- | --- |
| Título del panel (`.panel__title`) | 20 px | 600 |
| Título de detalle | 18 px | 600 |
| Título de modal | 16 px | 600 |
| Título de tarjeta, nombre de marca | 14–15 px | 600 |
| Título de sección (`.section-title`) | 14 px, MAYÚSCULAS, `letter-spacing: .4px`, color secundario | 600 |
| Texto base | 14 px | 400 |
| Secundario, badges, tablas (`th`) | 12 px | 400 / 600 |
| Contador del sidebar | 11 px | 600 |

Los números que cambian (porcentajes, tamaños) usan `font-variant-numeric: tabular-nums`.

## Espaciado

Escala de 4 px: 4, 8, 12, 16, 20, 24, 28, 40 (`--space-1` … `--space-10`).

| Elemento | Medidas |
| --- | --- |
| Sidebar | ancho 220 px, padding 16 px × 12 px, separación 16 px entre marca, navegación y pie |
| Ítem del sidebar | padding 8 px × 12 px, separación 2 px |
| Cabecera del panel | padding 20 px 28 px 12 px, borde inferior |
| Contenido del panel | padding 24 px 28 px 40 px |
| Pila de secciones (`.stack`) | separación 20 px |
| Tarjeta | padding 16 px × 18 px; tarjetas apiladas a 12 px |
| Rejilla (`.grid-2`) | columnas de mínimo 320 px, separación 20 px |
| Celdas de tabla | 8 px × 10 px |
| Botón | 7 px × 14 px (pequeño: 4 px × 10 px) |
| Modal | ancho 460 px (ancho: 640 px), padding 20 px × 22 px |

## Radios y sombras

| Token | Valor | Uso |
| --- | --- | --- |
| `--radius-xs` | 4 px | `code`, métodos HTTP |
| `--radius-sm` | 6 px | botones, campos, ítems del sidebar |
| `--radius-logo` | 7 px | marca del sidebar |
| `--radius` | 8 px | tarjetas, alertas, estados vacíos |
| `--radius-modal` | 10 px | modales |
| `--radius-pill` | 999 px | badges, chips, contadores, barras de progreso |
| `--shadow` | `0 1px 2px rgba(0,0,0,.06)` (oscuro `.4`) | tarjetas |
| `--shadow-modal` | `0 20px 40px rgba(0,0,0,.3)` | modales |

## Iconografía

- Iconos de línea propios, sin librería: `viewBox` 24 × 24, `stroke="currentColor"`, `stroke-width` 2, extremos y uniones redondeados, 18 px por defecto, `aria-hidden` (patrón de `icons.tsx` en LocalProcessor-Photos).
- Marca: cuadrado de 28 px con radio 7 px, fondo `--accent`, iniciales blancas a 12 px y peso 700. **Decisión:** Custodio usa "CU", siguiendo "LP" y "LS".
- Los ítems del sidebar son solo texto, como en los proyectos hermanos. **Decisión:** no se agregan iconos al sidebar mientras no haya una referencia que los muestre.
- Puntos de estado: círculos de 8 px (estado de la API, semáforo en línea).

## Layout

```
┌──────────────┬───────────────────────────────────────────────┐
│ [CU] Custodio│  Título del panel                             │
│              │  Descripción breve                            │
│  Resumen     ├───────────────────────────────────────────────┤
│  Discos      │                                               │
│  Proyectos   │  Contenido: secciones con .section-title,     │
│  Respaldos   │  tarjetas, tablas y estados vacíos            │
│  Actividad   │                                               │
│  Configuración                                               │
│              │                                               │
│ ─────────────│                                               │
│ ● Servicio   │                                               │
└──────────────┴───────────────────────────────────────────────┘
```

- `.layout`: rejilla de dos columnas `var(--sidebar-width) 1fr` a toda la altura.
- Sidebar: marca arriba, navegación (`nav aria-label`) al centro y pie con el estado de la conexión (punto verde, ámbar o rojo + texto). El ítem activo usa `--sidebar-item-active` y peso 600; un contador en píldora azul muestra trabajos activos.
- Panel: cabecera con título y descripción de una línea, alerta de conexión opcional debajo y contenido desplazable.
- Ventana: 1280 × 820, mínimo 960 × 640, sin barra de menú, fondo inicial del tema del sistema.
- Secciones de Custodio: **Resumen, Discos, Proyectos, Respaldos, Actividad y Configuración** (U1).

## Componentes y patrones

| Patrón | Referencia | Uso en Custodio |
| --- | --- | --- |
| Tarjeta (`.card`, `.card--row`) | LocalProcessor | Disco, proyecto, respaldo |
| Badge (`.badge--ok/warn/error/accent/muted`) | LocalProcessor | Estado con texto corto |
| Botones (`.btn`, `--primary`, `--danger`, `--danger-outline`, `--link`, `--sm`) | LocalProcessor | Una acción principal por pantalla |
| Alertas (`.alert--info/warn/error`) | LocalProcessor | Errores: qué pasó y qué hacer (U8) |
| Estado vacío (`.empty`: borde punteado, título + sugerencia) | LocalProcessor | Cada pantalla, con la siguiente acción (U8) |
| Modal y `ConfirmDialog` (Escape cierra, foco dentro) | LocalProcessor | Confirmaciones |
| Vista de jobs: "En curso" con barra de progreso, "En cola" en tabla, "Historial" | LocalProcessor `Jobs.tsx` | Respaldos en tiempo real por SSE (U7) |
| Control segmentado (`.segmented`) | LocalProcessor | Presets: "cada día", "días de la semana" (U5) |
| Pantalla de primer uso (`.first-run`, tarjeta centrada de 520 px) | LocalProcessor | Asistente de primer uso (U2) |
| Tabla (`.table`, `--clickable`) | LocalProcessor | Actividad, historial |

### Patrones nuevos (Decisión)

- **Detalles técnicos / Avanzado:** sección plegada por defecto con un botón de texto secundario y chevron (`chevronRight` → `chevronDown`), `aria-expanded` y contenido en `.props` o en monoespaciada. Es el único lugar donde aparecen SMART, cron, serial o WWN (U4).
- **Previsualización de acción riesgosa:** modal ancho con una frase simple arriba ("Se copiarán 1,2 GB y no se borrará nada"), una lista breve de efectos y dos botones: "Cancelar" y la acción concreta ("Retirar disco"), en `.btn--danger` si borra o modifica algo. El botón de confirmar nunca dice solo "Aceptar" (U6).
- **Tarjeta de disco:** punto del semáforo + frase simple, barra de espacio usado/libre (`.progress`), acción sugerida como botón principal y "Detalles técnicos" plegado (U4).

## Accesibilidad e interacción

- Todo es alcanzable con teclado. Foco visible con `outline: 2px solid var(--accent)` y `outline-offset: 2px` en `:focus-visible` (generalizado desde la galería de LocalProcessor-Photos).
- Los modales cierran con Escape y devuelven el foco al botón que los abrió.
- El color nunca es el único indicador: siempre va acompañado de texto.
- Sin violaciones graves de axe (U9).
- La interfaz no permite seleccionar texto (`user-select: none`), salvo campos, bloques de código y textos que el usuario puede querer copiar.

## Textos

- Todo texto visible sale de `src/ui/i18n/es.json` mediante `t('clave')`; ESLint rechaza texto fijo en JSX y en `aria-label`, `title`, `placeholder` y `alt`. El proceso principal (título de ventana, bandeja, notificaciones) usa el mismo catálogo.
- Español cotidiano, en segunda persona y sin jerga: "copia de seguridad", "disco sano", "revisa este disco".
- Números y tamaños con formato `es-CL` (coma decimal: "1,2 GB").

## Bandeja (Decisión)

El icono de bandeja es un círculo del color del semáforo global, generado en tiempo de ejecución (`src/main/tray-icon.ts`); no hay imágenes por color que mantener. El tooltip y las notificaciones salen de `es.json` (`tray.*`).

## Evidencia

Las pruebas de Playwright guardan capturas en `docs/ui-evidence/` con el id del criterio en el nombre (`U3-resumen.png`, `U9-tema-oscuro.png`…). Sin capturas en `docs/ui-reference/`, la comparación visual se hizo contra el código de LocalProcessor y LocalStreaming.

## Pendientes

- Agregar capturas de LocalProcessor y LocalStreaming a `docs/ui-reference/` y contrastar esta guía con ellas.
- Icono de la aplicación (`packages/custodio-ui/build/icon.png`).
