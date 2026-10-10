# Criterios de aceptación

Cada criterio debe tener al menos una prueba cuyo nombre empiece por su id (por ejemplo `A9 reanuda una copia cortada a la mitad`). `npm run verify` lee los resultados de vitest y Playwright y cuenta un criterio como aprobado solo si tiene pruebas, todas pasan y ninguna está omitida. Imprime:

```
ACCEPTANCE CORE n/20 PASS
ACCEPTANCE UI n/12 PASS
```

## Núcleo (service)

- **A1** Identidad por serial/WWN: si la letra de unidad cambia entre lecturas, el disco conserva su id.
- **A2** Salud: semáforo verde/amarillo/rojo con atributos SMART (5, 197, 198, temperatura, horas). El atributo 199 avisa de cable/USB y no marca el disco como fallando. Sin SMART el estado es "desconocido", nunca verde.
- **A3** Capacidad: usado, libre y días hasta llenarse (tendencia lineal sobre lecturas históricas).
- **A4** Un disco nuevo aparece "sin asignar" y nunca se asigna solo.
- **A5** Un proyecto asigna carpeta + rol (almacenamiento|respaldo) a discos; todo persiste tras reiniciar el servicio.
- **A6** Topologías: se aceptan 1→1, 1→2, 1→3, 2→2 y N→M. Se rechazan origen y destino en el mismo disco físico, destino sin capacidad para la suma de sus orígenes, origen sin rol almacenamiento o destino sin rol respaldo, cadenas y ciclos. Un disco con rol respaldo y sin política muestra el aviso "sin origen".
- **A7** Cambiar roles o agregar un disco no mueve datos: devuelve un plan que exige confirmación explícita.
- **A8** Política con cron + zona horaria IANA: dispara con reloj simulado, registra la ejecución y hace catch-up tras una caída. Un lock evita solapar ejecuciones de la misma política y las políticas fallan de forma independiente.
- **A9** Respaldo incremental append-only: copia solo lo faltante o modificado, verifica por hash, no borra nada en el destino, es reanudable (interrumpido a mitad, al reintentar los hashes coinciden) y omite archivos incompletos (temporal .part + ventana de quietud de 10 minutos). Copia a un archivo temporal, verifica el hash y renombra de forma atómica; nunca sobrescribe en el sitio. Una prueba de inyección de fallos corta la copia a mitad y comprueba que el destino nunca queda con un archivo corrupto visible.
- **A10** Preflight: se niega a correr si origen o destino están en rojo, si el serial no coincide, si falta .diskmanager/volume.json o si no hay espacio.
- **A11** Modos con borrado: retención (conserva borrados N días) y espejo (flag explícito + dry-run previo). Ambos abortan si borrarían más de un porcentaje configurable.
- **A12** La verificación periódica por hash muestreado detecta un archivo corrupto en el destino y emite evento.
- **A13** Eventos: outbox persistente, entrega al menos una vez, cursor (GET /v1/events?after=), consumo idempotente, y stream en vivo (SSE) para la UI. Tipos: disk.detected, disk.health_changed, capacity.low, backup.completed, backup.failed, backup.overdue (sin éxito en 2x el intervalo).
- **A14** API /v1 con OpenAPI generado y validado en pruebas, operaciones largas con 202 + job id consultable y cancelable, idempotency key y error uniforme.
- **A15** Seguridad: token de servicio obligatorio, bind a 127.0.0.1 por defecto, execFile con args (prueba con nombres de carpeta maliciosos), validación de rutas, operaciones destructivas con confirmación y auditoría de quién las pidió.
- **A16** Arquitectura: src/core sin referencias a localcloud/blob/supabase; disco, SMART, volúmenes, copiador y reloj detrás de interfaces con implementación simulada; adaptadores reales de Windows presentes pero bloqueados en test.
- **A17** Autodescripción: cada carpeta asignada contiene .diskmanager/volume.json y una prueba reconstruye la configuración de un proyecto solo desde los discos.
- **A18** Borrado explícito: Custodio nunca borra en el origen. La orden de borrado del proyecto se aplica a todas las copias indicadas, queda pendiente y se reintenta si un disco está desconectado hasta confirmarse, y queda en la auditoría.
- **A19** Privilegios: el servicio no requiere privilegios de administrador; solo custodio-helper ejecuta lo elevado, con lista blanca de operaciones. El helper rechaza operaciones fuera de la lista y argumentos inválidos, y chkdsk /f exige confirmación de un solo uso.
- **A20** Límites de I/O: la copia respeta un límite de MB/s y una ventana horaria configurables (pruebas con reloj y medidor simulados).

## Interfaz y distribución (ui)

U1–U11 se prueban con Playwright contra el renderer y el servicio con adaptadores simulados; U12 con una prueba que analiza el workflow.

- **U1** Layout: sidebar izquierdo con Resumen, Discos, Proyectos, Respaldos, Actividad y Configuración, y panel derecho de contenido, siguiendo docs/UI-GUIDE.md.
- **U2** Primer uso: asistente que detecta los discos y deja decidir para cada uno entre "Guardar archivos", "Copia de seguridad" y "No usar", con presets de topología (un disco + una copia, un disco + dos copias, personalizado). Sin términos técnicos. Termina con un resumen y confirmación.
- **U3** Resumen: en una sola vista muestra el estado global (semáforo), espacio total y libre, último respaldo y próximo respaldo.
- **U4** Disco: tarjeta con semáforo, una frase en lenguaje simple, espacio usado y libre, y la acción sugerida. Los atributos SMART solo aparecen en "Detalles técnicos", plegado por defecto.
- **U5** Respaldos: se crea una copia programada sin escribir cron ("cada día a las 3:00", días de la semana). Muestra la próxima ejecución y permite "Ejecutar ahora" y "Pausar".
- **U6** Acciones riesgosas (retirar disco, reparar, espejo, borrar): primero muestran una previsualización en lenguaje simple y exigen confirmación explícita.
- **U7** Tiempo real: el job activo y la cola muestran progreso sin recargar (SSE), como la vista de jobs de LocalProcessor.
- **U8** Estados vacíos y errores: cada pantalla tiene un estado vacío que sugiere la siguiente acción, y los errores dicen qué pasó y qué hacer, sin códigos crudos.
- **U9** Accesibilidad y apariencia: tema claro/oscuro según el sistema, navegación por teclado, sin violaciones graves de axe, y todos los textos desde es.json.
- **U10** Bandeja y notificaciones: el icono de bandeja toma el color del semáforo global y se dispara una notificación nativa cuando un disco cambia de estado o falla un respaldo (probado con mocks de la shell de Electron).
- **U11** Independencia: detener la UI no detiene el scheduler; la UI solo usa la API /v1 por loopback con token.
- **U12** Distribución: .github/workflows/release.yml se dispara con tags v*, construye con electron-builder el instalador de Windows y lo publica en GitHub Releases; todos los package.json tienen private: true; una prueba parsea el YAML y verifica el trigger y los pasos; npm run build:ui termina con exit code 0.
