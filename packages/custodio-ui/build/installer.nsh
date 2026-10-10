; electron-builder includes this file in the NSIS installer.
; After copying the files it registers custodio-service and custodio-helper; before uninstalling (and before an
; update) it stops and removes them. The scripts live in custodio-service/deploy/windows.

!macro customInstall
  DetailPrint "Custodio: registrando el servicio y el helper"
  ${DisableX64FSRedirection}
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\service\install-tasks.ps1" -ServiceDir "$INSTDIR\resources\service"'
  Pop $0
  ${EnableX64FSRedirection}
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "Custodio se instalo, pero no se pudo registrar su servicio (error $0). Vuelve a ejecutar el instalador; si se repite, revisa docs/INSTALL.md." /SD IDOK
  ${EndIf}
!macroend

!macro customUnInstall
  DetailPrint "Custodio: deteniendo el servicio y el helper"
  ${DisableX64FSRedirection}
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\service\uninstall-tasks.ps1"'
  Pop $0
  ${EnableX64FSRedirection}
!macroend
