# Eventos de Custodio

Los eventos avisan de cambios importantes: un disco nuevo, un disco que empeora, poco espacio, copias que terminan, fallan o se atrasan. Los usa la aplicación de escritorio (bandeja y notificaciones) y cualquier programa local con el token del servicio.

## Sobre de cada evento

```json
{
  "seq": 42,
  "id": "6f0c1c9e-5a3b-4f43-9a4e-0d7c2f1f9b10",
  "type": "backup.completed",
  "occurredAt": "2026-10-10T06:00:12.345Z",
  "payload": { "...": "según el tipo" }
}
```

| Campo | Significado |
| --- | --- |
| `seq` | Posición en el registro, creciente y sin huecos de orden. Es el cursor. |
| `id` | Identificador único (UUID). Sirve para descartar duplicados. |
| `type` | Uno de los tipos de abajo. |
| `occurredAt` | Momento del cambio, en UTC (ISO 8601). |
| `payload` | Datos del evento; su forma depende del tipo (esquemas al final). |

## Entrega

- **Outbox persistente.** Cada evento se guarda en SQLite en la misma transacción que el cambio que lo provoca. Si el cambio se deshace, el evento no existe; si el servicio se cae después, el evento sigue ahí.
- **Al menos una vez.** Un consumidor puede recibir el mismo evento más de una vez (por ejemplo, si se cae antes de guardar su cursor, o si combina el stream con la consulta por cursor). Nunca se pierde uno ya guardado.
- **Consumo idempotente.** El consumidor procesa cada `id` una sola vez: guarda los `id` ya vistos (o el último `seq` aplicado) y descarta repetidos.

## Leer por cursor

`GET /v1/events?after=<seq>&limit=<n>&types=<tipo,tipo>` devuelve los eventos con `seq` mayor que `after`, en orden, y `nextCursor` (el `seq` del último devuelto, o el mismo `after` si no hay nuevos).

1. Empieza con `after=0`.
2. Procesa los eventos (descartando `id` repetidos).
3. Guarda `nextCursor` y vuelve a pedir con `after=nextCursor`.

Pedir dos veces el mismo cursor devuelve los mismos eventos.

## En vivo (Server-Sent Events)

`GET /v1/events/stream` mantiene la conexión abierta (`text/event-stream`):

- Primero envía los eventos guardados después de `?after=` o de la cabecera `Last-Event-ID`, y luego los nuevos al momento.
- Cada evento guardado llega con `id: <seq>`, `event: <type>` y `data: <sobre JSON>`, así `EventSource` retoma solo tras una desconexión.
- Además llegan mensajes `event: job.updated` con el estado y el progreso de los trabajos en curso. No tienen `id`, no se guardan y no se repiten: sirven para mostrar avance en tiempo real.
- Cada 15 segundos llega un comentario (`: ping`) para mantener viva la conexión.

## Tipos

| Tipo | Cuándo se emite |
| --- | --- |
| `disk.detected` | Aparece un disco que Custodio no conocía. Queda "sin asignar" hasta que alguien decida. |
| `disk.health_changed` | El semáforo de un disco cambia (verde, amarillo, rojo o desconocido). `reasons` trae los códigos que lo explican. |
| `capacity.low` | El espacio libre de un disco baja del 10 %. Se vuelve a avisar solo después de que se recupere por encima del 15 %. |
| `backup.completed` | Una copia programada o manual termina bien. |
| `backup.failed` | Una copia falla: preflight rechazado, archivos que no se pudieron copiar, borrado sobre el límite o error inesperado. `code` dice cuál. |
| `backup.overdue` | Una copia lleva más de dos veces su intervalo sin terminar bien. Se avisa una vez hasta el próximo éxito. |
| `backup.corruption_detected` | La verificación periódica por hash encontró una copia dañada o desaparecida. |

## Esquemas

Generados desde `packages/custodio-service/src/core/shared/events.ts` con `npm run contracts`. Las pruebas comprueban que esta sección coincide con el código y validan contra ella cada evento que emiten.

<!-- schemas:start -->

### disk.detected

```json
{
  "type": "object",
  "properties": {
    "diskId": {
      "type": "string"
    },
    "serial": {
      "type": [
        "string",
        "null"
      ]
    },
    "wwn": {
      "type": [
        "string",
        "null"
      ]
    },
    "model": {
      "type": "string"
    },
    "sizeBytes": {
      "type": "integer",
      "minimum": 0
    },
    "mountPath": {
      "type": [
        "string",
        "null"
      ]
    }
  },
  "required": [
    "diskId",
    "serial",
    "wwn",
    "model",
    "sizeBytes",
    "mountPath"
  ],
  "additionalProperties": false
}
```

### disk.health_changed

```json
{
  "type": "object",
  "properties": {
    "diskId": {
      "type": "string"
    },
    "previous": {
      "type": "string",
      "enum": [
        "green",
        "yellow",
        "red",
        "unknown"
      ]
    },
    "current": {
      "type": "string",
      "enum": [
        "green",
        "yellow",
        "red",
        "unknown"
      ]
    },
    "reasons": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  },
  "required": [
    "diskId",
    "previous",
    "current",
    "reasons"
  ],
  "additionalProperties": false
}
```

### capacity.low

```json
{
  "type": "object",
  "properties": {
    "diskId": {
      "type": "string"
    },
    "totalBytes": {
      "type": "integer",
      "minimum": 0
    },
    "freeBytes": {
      "type": "integer",
      "minimum": 0
    },
    "freePercent": {
      "type": "number"
    },
    "daysUntilFull": {
      "type": [
        "number",
        "null"
      ]
    }
  },
  "required": [
    "diskId",
    "totalBytes",
    "freeBytes",
    "freePercent",
    "daysUntilFull"
  ],
  "additionalProperties": false
}
```

### backup.completed

```json
{
  "type": "object",
  "properties": {
    "jobId": {
      "type": "string"
    },
    "policyId": {
      "type": "string"
    },
    "projectId": {
      "type": "string"
    },
    "filesCopied": {
      "type": "integer",
      "minimum": 0
    },
    "bytesCopied": {
      "type": "integer",
      "minimum": 0
    },
    "filesSkipped": {
      "type": "integer",
      "minimum": 0
    },
    "filesDeleted": {
      "type": "integer",
      "minimum": 0
    },
    "durationMs": {
      "type": "integer",
      "minimum": 0
    }
  },
  "required": [
    "jobId",
    "policyId",
    "projectId",
    "filesCopied",
    "bytesCopied",
    "filesSkipped",
    "filesDeleted",
    "durationMs"
  ],
  "additionalProperties": false
}
```

### backup.failed

```json
{
  "type": "object",
  "properties": {
    "jobId": {
      "type": "string"
    },
    "policyId": {
      "type": "string"
    },
    "projectId": {
      "type": "string"
    },
    "code": {
      "type": "string"
    },
    "message": {
      "type": "string"
    }
  },
  "required": [
    "jobId",
    "policyId",
    "projectId",
    "code",
    "message"
  ],
  "additionalProperties": false
}
```

### backup.overdue

```json
{
  "type": "object",
  "properties": {
    "policyId": {
      "type": "string"
    },
    "projectId": {
      "type": "string"
    },
    "lastSuccessAt": {
      "anyOf": [
        {
          "type": "string",
          "format": "date-time"
        },
        {
          "type": "null"
        }
      ]
    },
    "expectedIntervalMs": {
      "type": "integer",
      "exclusiveMinimum": 0
    },
    "overdueSince": {
      "type": "string",
      "format": "date-time"
    }
  },
  "required": [
    "policyId",
    "projectId",
    "lastSuccessAt",
    "expectedIntervalMs",
    "overdueSince"
  ],
  "additionalProperties": false
}
```

### backup.corruption_detected

```json
{
  "type": "object",
  "properties": {
    "jobId": {
      "type": "string"
    },
    "policyId": {
      "type": "string"
    },
    "projectId": {
      "type": "string"
    },
    "destinationId": {
      "type": "string"
    },
    "diskId": {
      "type": "string"
    },
    "path": {
      "type": "string"
    },
    "expectedSha256": {
      "type": "string"
    },
    "actualSha256": {
      "type": [
        "string",
        "null"
      ]
    }
  },
  "required": [
    "jobId",
    "policyId",
    "projectId",
    "destinationId",
    "diskId",
    "path",
    "expectedSha256",
    "actualSha256"
  ],
  "additionalProperties": false
}
```

<!-- schemas:end -->
