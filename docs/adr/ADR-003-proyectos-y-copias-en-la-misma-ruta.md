# ADR-003: Proyectos completos y copias en la misma ruta del original

- **Estado:** aceptada
- **Fecha:** 2026-10-13

## Contexto

Un mismo equipo respalda cosas que no tienen relación entre sí: LocalCloud (`D:\lc\prod` y `D:\LocalProcessor-Photos` en `E:`) y otros proyectos (`C:\proyecto1\dev\fotos` en `D:` y en `E:`). Antes, armar un proyecto exigía varios pasos sueltos (carpetas, roles y una copia programada aparte), y las copias quedaban en una carpeta propia de Custodio (`E:\Copias de Custodio\<carpeta>`).

Lo que se busca es poder reemplazar un disco que falla por su disco de respaldo sin cambiar nada: si el original es `D:\lc\prod`, la copia tiene que estar en `E:\lc\prod`.

## Decisión

1. **Un proyecto es un nombre, sus carpetas de origen, sus discos de respaldo y un horario.** Se crea o se edita con un solo plan (`POST /v1/setups`) que se revisa en palabras simples y se confirma (`POST /v1/plans/{id}/confirm`). Al confirmar se guardan juntos el proyecto, sus carpetas y su única copia programada. Eliminar un proyecto (`POST /v1/projects/{id}/removals`) también pasa por un plan y nunca borra archivos.
2. **Cada copia va en la misma ruta que su original.** Para cada carpeta de origen y cada disco de respaldo, el proyecto tiene una carpeta de copia con la misma ruta relativa (`Assignment.mirrorOf` apunta al origen). `copyRoot` devuelve esa carpeta tal cual, y esa copia recibe solo su origen (`receives`). Las asignaciones sin `mirrorOf`, de proyectos anteriores, siguen con la estructura antigua hasta que se editen.
3. **Cada carpeta pertenece a un solo proyecto.** Una carpeta no puede estar dentro de otra que ya use otro proyecto en el mismo disco (`assertFree`), ni como origen ni como copia. Una copia en el mismo disco que su original se rechaza con el resto de los problemas de la topología (`same_disk`).
4. **Lo que ya está en el destino solo se reconoce si su contenido coincide.** Un archivo con el mismo tamaño y fecha se adopta sin copiarlo si su SHA-256 es igual al del original. Si no coincide, se copia de nuevo y el anterior pasa a `.diskmanager\versions`. Así una réplica anterior (por ejemplo, la de LocalCloud en `E:\lc\prod`) se aprovecha sin arriesgar una copia corrupta.
5. **El espacio se revisa por disco.** Las carpetas de copia de un mismo disco comparten su espacio libre; lo que ya ocupan cuenta como disponible.

## Consecuencias

- Un disco de respaldo puede servir a varios proyectos, y un disco puede ser origen en un proyecto y respaldo en otro, siempre que sus carpetas no se crucen.
- Respaldar un disco entero (carpeta vacía, como hace el asistente) ocupa todo el disco de respaldo: ningún otro proyecto puede usarlo. En modo papelera o espejo, lo que haya en la copia y no esté en el original se trata como borrado del original, con el mismo límite de seguridad (`maxDeletePercent`).
- Al editar un proyecto antiguo, sus copias pasan a la misma ruta del original. La carpeta antigua no se borra: el plan avisa que Custodio deja de copiar en ella y que lo que ya está ahí se queda.
- En la interfaz, Proyectos es el único lugar donde se decide qué se copia, dónde y cuándo; Respaldos muestra cada copia programada con Ejecutar ahora y Pausar.

Criterios relacionados: A5 (sin cambios hasta confirmar), A6 (topología), A7 (planes), A9 (copia incremental), A17 (recuperación desde los discos) y A18 (borrado solo en destinos).
