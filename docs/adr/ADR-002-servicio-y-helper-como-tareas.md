# ADR-002: El servicio y el helper se registran como tareas programadas de Windows

- **Estado:** aceptada
- **Fecha:** 2026-10-10

## Contexto

El servicio debe correr aunque la aplicación esté cerrada (los respaldos de las 3 am no dependen de la UI) y sin privilegios de administrador. Solo `custodio-helper` corre elevado. El instalador tiene que registrar ambos procesos.

Un servicio de Windows de verdad necesita un ejecutable que hable con el administrador de servicios (SCM). `node.exe` no lo hace, así que haría falta un envoltorio de terceros (WinSW, NSSM) o un módulo nativo. El proyecto no usa módulos nativos y prefiere no distribuir binarios ajenos.

## Decisión

El instalador registra dos tareas programadas en la carpeta `\Custodio\` del Programador de tareas. Lo hace `deploy/windows/install-tasks.ps1`, invocado desde `build/installer.nsh`:

| Tarea | Cuenta | Nivel | Arranque |
| --- | --- | --- | --- |
| `custodio-helper` | SYSTEM | elevado | al iniciar Windows |
| `custodio-service` | el usuario que instala, sin guardar su contraseña (S4U) | sin elevar | al iniciar Windows, haya o no sesión iniciada |

- Ambas tareas tienen además un disparador cada cinco minutos y la regla "si ya está corriendo, no iniciar otra". Si un proceso se cae, vuelve a levantarse en menos de cinco minutos. Ninguna tiene límite de tiempo de ejecución.
- Ambas corren con el `node.exe` que viene en el instalador (`resources/service`), el mismo con el que se construyó y se probó el paquete. El servicio no corre dentro de Electron.
- `production.env` fija `CUSTODIO_ADAPTERS=windows`. Sin instalar, el valor por defecto sigue siendo `sim`.
- El instalador crea `C:\ProgramData\Custodio\service-token` y `helper-secret`. Solo los pueden leer SYSTEM, Administradores y el usuario del servicio.
- El canal del helper (`\\.\pipe\custodio-helper`) acepta conexiones de cualquier usuario local, porque el servicio no está elevado. Cada petición sigue exigiendo el secreto y una operación de la lista blanca.
- Si la cuenta no puede usar S4U (por ejemplo, una cuenta de dominio sin el derecho "Iniciar sesión como proceso por lotes"), el servicio queda registrado para arrancar al iniciar sesión.

## Consecuencias

- No hay binarios de terceros ni módulos nativos. El paquete crece unos 80 MB por `node.exe`.
- El servicio corre como el usuario. Lee sus carpetas sin privilegios extra y no puede hacer nada que ese usuario no pueda.
- Con S4U el servicio no tiene credenciales de red. Las unidades de red mapeadas quedan fuera, lo que ya era el caso por alcance.
- El servicio arranca en paralelo con el helper. Si el primer escaneo falla porque el helper aún no responde, se reintenta al minuto (`InventoryWatch`). Después se revisa cada seis horas.
- Desinstalar (y actualizar) detiene y elimina las tareas con `uninstall-tasks.ps1`. Conserva `C:\ProgramData\Custodio` (base de datos, configuración e historial).
