# Instalar Custodio en Windows

Custodio tiene tres piezas y el instalador deja las tres listas:

- **La aplicación** (ventana e icono en la bandeja). Arranca al iniciar sesión, directo a la bandeja.
- **El servicio** (`custodio-service`). Hace los respaldos y vigila los discos aunque la aplicación esté cerrada. Corre con tu cuenta, sin privilegios de administrador.
- **El helper** (`custodio-helper`). Es el único proceso con privilegios: lee la lista de discos, su salud (SMART) y el espacio libre, y repara un disco solo si lo confirmas.

El servicio y el helper quedan como tareas programadas que arrancan con Windows ([ADR-002](adr/ADR-002-servicio-y-helper-como-tareas.md)).

## Antes de instalar

- Windows 10 u 11 de 64 bits y una cuenta con permisos de administrador. El instalador los pide una vez.
- **Recomendado: smartmontools**, para conocer la salud de los discos. Sin él, Custodio funciona igual, pero los discos aparecen con salud "desconocida". Para instalarlo, abre PowerShell y ejecuta:

  ```powershell
  winget install --id smartmontools.smartmontools
  ```

  El helper lo busca en `C:\Program Files\smartmontools\bin\smartctl.exe`, la carpeta que usa su instalador.

## 1. Conseguir el instalador

**Opción A: construirlo en tu PC.** Necesitas Node 22.13 o superior. Desde la raíz del repositorio:

```powershell
npm ci
npm run dist:win
```

El instalador queda en `packages\custodio-ui\dist\Custodio-0.1.0-win-x64.exe`.

**Opción B: desde GitHub Releases.** Al subir un tag `v*` (por ejemplo `git tag v0.1.0` y `git push origin v0.1.0`), GitHub Actions construye el instalador y lo publica en la página de Releases del repositorio. El repositorio es público, así que el release también lo es.

## 2. Instalar

1. Haz doble clic en `Custodio-0.1.0-win-x64.exe`.
2. El instalador no está firmado, así que Windows puede mostrar "Windows protegió su PC". Pulsa **Más información** y luego **Ejecutar de todas formas**.
3. Elige la carpeta (la de siempre es `C:\Program Files\Custodio`) y acepta el aviso de permisos de administrador.
4. Al terminar, deja marcada la opción de abrir Custodio.

Durante la instalación se registran las dos tareas y se crean `C:\ProgramData\Custodio\service-token` y `helper-secret`. Solo los pueden leer SYSTEM, Administradores y tu cuenta.

## 3. Comprobar que quedó funcionando

- Abajo en la barra lateral de Custodio aparece **"Custodio está funcionando"**.
- En el **Programador de tareas**, en la carpeta **Biblioteca > Custodio**, aparecen `custodio-helper` y `custodio-service` en estado **En ejecución**. También puedes verlo desde PowerShell:

  ```powershell
  Get-ScheduledTask -TaskPath '\Custodio\'
  ```

- Los registros están en `C:\ProgramData\Custodio\logs\` (`custodio-service.log` y `custodio-helper.log`).

## 4. Primer uso: empieza con algo de prueba

Esta es la primera vez que Custodio lee discos reales: las pruebas automáticas usan siempre discos simulados. Antes de confiarle tus archivos importantes:

1. En **Discos**, pulsa **Buscar discos** y revisa que estén todos con su nombre, tamaño y espacio libre.
2. Crea un proyecto de prueba: una carpeta con pocos archivos en un disco ("Guardar archivos") y un disco o pendrive de sobra como "Copia de seguridad".
3. En **Respaldos**, usa **Ejecutar ahora** y revisa que la copia aparezca en el disco de destino.
4. Cuando todo cuadre, agrega tus carpetas reales.

Custodio nunca borra en el origen. Solo borra copias en los destinos si lo ordenas tú, después de una vista previa (modo espejo, retención o "Borrar de las copias").

## Actualizar

Ejecuta el instalador de la versión nueva. Detiene el servicio y el helper, reemplaza los archivos y los vuelve a registrar. Tus proyectos, copias programadas e historial se mantienen.

## Desinstalar

Ve a **Configuración de Windows > Aplicaciones > Custodio > Desinstalar**. Se detienen y eliminan las tareas.

Se conservan:

- `C:\ProgramData\Custodio` (base de datos, configuración e historial), por si vuelves a instalar. Para empezar desde cero, borra esa carpeta después de desinstalar.
- Las copias en tus discos, con sus carpetas `.diskmanager`.

## Si algo falla

| Qué ves | Qué hacer |
| --- | --- |
| "No pudimos conectar con Custodio" | Revisa que la tarea `custodio-service` esté en ejecución. Para iniciarla: `Start-ScheduledTask -TaskPath '\Custodio\' -TaskName custodio-service`. Si se detiene sola, mira `custodio-service.log`. |
| No aparece ningún disco | El helper no responde. Revisa la tarea `custodio-helper` y `custodio-helper.log`, y pulsa **Buscar discos**. Al iniciar Windows, el servicio reintenta solo al minuto. |
| Salud "desconocida" | Falta smartmontools, o el disco está en una caja USB que no deja leer SMART. Instala smartmontools y pulsa **Buscar discos**. No hace falta reiniciar. |
| El instalador avisó que no pudo registrar el servicio | Vuelve a ejecutarlo como administrador. Si se repite, ejecuta a mano `C:\Program Files\Custodio\resources\service\install-tasks.ps1 -ServiceDir "C:\Program Files\Custodio\resources\service"` desde un PowerShell de administrador y revisa el error. |
| Otra cuenta de Windows abre Custodio y no conecta | Es esperado: el servicio pertenece a la cuenta que instaló y solo esa cuenta puede leer su token. |

La salud se vuelve a revisar sola cada seis horas, y también cuando pulsas **Buscar discos**. Cada revisión puede despertar los discos que estén en reposo; por eso no es más frecuente.
