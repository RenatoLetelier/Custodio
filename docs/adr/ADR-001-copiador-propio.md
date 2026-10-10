# ADR-001: Copiador propio

- **Estado:** aceptada (decisión cerrada)
- **Contexto completo y alternativas:** `docs/SPEC.md` (pendiente de incorporar al repositorio)

## Decisión

Custodio usa un copiador propio, detrás de una interfaz del núcleo, en lugar de delegar la copia en una herramienta externa.

## Reglas que el copiador debe cumplir

1. Copia a un archivo temporal en el destino.
2. Verifica el hash del temporal contra el origen.
3. Renombra de forma atómica al nombre final.
4. Nunca sobrescribe un archivo en el sitio.

Criterios relacionados: A9 (respaldo incremental), A16 (detrás de una interfaz con implementación simulada) y A20 (límites de I/O).

## Consecuencias

- Es la pieza con más riesgo de pérdida de datos: se prueba con inyección de fallos que corta la copia a mitad y comprueba que el destino nunca queda con un archivo corrupto visible (A9).
- Al ir detrás de una interfaz, las pruebas usan un copiador simulado y directorios temporales; ninguna prueba toca discos reales.
