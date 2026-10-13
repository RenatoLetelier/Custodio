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

**Opción A: descargarlo de GitHub.** En [github.com/RenatoLetelier/Custodio/releases/latest](https://github.com/RenatoLetelier/Custodio/releases/latest), descarga `Custodio-<versión>-win-x64.exe` desde **Assets**. Cada tag `v*` que se sube (por ejemplo `git tag v0.1.0` y `git push origin v0.1.0`) hace que GitHub Actions construya y publique uno nuevo. El repositorio es público, así que los releases también lo son.

**Opción B: construirlo tú.** Necesitas Node 22.13 o superior. Desde la raíz del repositorio:

```powershell
npm ci
npm run dist:win
```

El instalador queda en `packages\custodio-ui\dist\Custodio-0.1.0-win-x64.exe`.

**En otro equipo** (por ejemplo, un mini PC que guarda los discos), instálalo en ese equipo. Custodio solo atiende en `127.0.0.1`: la ventana se abre ahí mismo, con monitor o por Escritorio remoto, y no se puede manejar desde otro PC de la red. El servicio corre aunque nadie haya iniciado sesión.

## 2. Instalar

1. Haz doble clic en `Custodio-0.1.0-win-x64.exe`.
2. El instalador no está firmado. Al descargarlo, el navegador puede avisar que el archivo no se descarga con frecuencia: elige **Conservar**. Al abrirlo, Windows puede mostrar "Windows protegió su PC": pulsa **Más información** y luego **Ejecutar de todas formas**.
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
2. En **Proyectos**, pulsa **Nuevo proyecto** y arma uno de prueba: una carpeta con pocos archivos en **Qué respaldar** y un disco o pendrive de sobra en **Dónde guardar las copias**. **Revisar y guardar** muestra lo que va a pasar antes de guardarlo.
3. En **Respaldos**, usa **Ejecutar ahora** y revisa que la copia aparezca en el disco de respaldo, en la misma ruta que el original.
4. Cuando todo cuadre, crea tus proyectos reales.

**Proyectos.** Cada proyecto es un nombre, una o más carpetas, uno o más discos de respaldo y un horario. Por ejemplo, «Localcloud» respalda `D:\lc\prod` en `E:`, y «Proyecto 1» respalda `C:\proyecto1\dev\fotos` en `D:` y en `E:`. Cada copia queda en la misma ruta que su original (`D:\lc\prod` → `E:\lc\prod`), así que si un disco falla, el de respaldo lo reemplaza sin cambiar nada. Una carpeta solo puede estar en un proyecto. Todo se cambia desde **Editar** en la tarjeta del proyecto, y **Eliminar proyecto** solo hace que Custodio deje de respaldarlo: no borra ningún archivo.

Custodio nunca borra en el origen. Solo borra copias en los destinos si lo ordenas tú: con el modo espejo, con "Borrar de las copias" (ambos con vista previa) o con la papelera.

**Lo que se borra del original.** Por defecto se queda en la copia para siempre, así que la copia solo crece. Si en el disco de origen se borra mucho (por ejemplo, el de LocalCloud, que descarta los originales de las películas y purga lo que ya nadie usa), elige **Pasa a la papelera de la copia y se elimina después de unos días**. Está en **Avanzado**, dentro de **Editar** del proyecto. La papelera y el espejo tratan como borrado todo lo que esté dentro de la carpeta de copia y no en el original, así que no guardes otras cosas ahí. El **límite** (10 % por defecto) detiene una copia que fuera a quitar de una vez más archivos que eso, sin borrar nada. Si te pasa con algo que sí borraste a propósito, súbelo en ese mismo lugar y vuelve a ejecutarla.

**Discos en una caja USB.** Si la caja no deja leer la salud con el modo normal, Custodio lo reintenta con el modo SAT, el que usan la mayoría de las cajas. Dos discos de la misma caja que reportan el mismo número de serie se distinguen por su posición en la caja. Una vez usados en un proyecto, también por el índice que Custodio deja en cada uno (`.diskmanager\index.json`), aunque la caja los numere distinto después de reiniciar.

## Actualizar

Ejecuta el instalador de la versión nueva. Detiene el servicio y el helper, reemplaza los archivos y los vuelve a registrar. Tus proyectos, copias programadas e historial se mantienen.

**De 0.2 a 0.3.** Los proyectos creados antes siguen copiando donde lo hacían (por ejemplo, `E:\Copias de Custodio`). Al guardarlos con **Editar**, sus copias pasan a la misma ruta que el original. La carpeta antigua no se borra: el plan lo avisa, y la puedes borrar tú cuando la primera copia nueva termine bien. Lo que ya esté en la ruta nueva con el mismo contenido se reconoce sin copiarlo de nuevo.

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
| El asistente dice que el disco de la copia «no tiene espacio» | El mensaje dice cuánto hace falta y cuánto hay. Libera espacio en ese disco (por ejemplo, una copia vieja hecha por otro programa) y vuelve a **Confirmar y empezar**: el asistente retoma lo que quedó hecho, sin duplicar nada. |
| Otra cuenta de Windows abre Custodio y no conecta | Es esperado: el servicio pertenece a la cuenta que instaló y solo esa cuenta puede leer su token. |

La salud se vuelve a revisar sola cada seis horas, y también cuando pulsas **Buscar discos**. Cada revisión puede despertar los discos que estén en reposo; por eso no es más frecuente.
