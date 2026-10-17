# TimeTrack

Tracker de tiempos y facturas en una sola página, con respaldo local y sincronización en Google Drive.

## Usarlo en varias computadoras

1. Abre la misma dirección web de TimeTrack en cada computadora.
2. Pulsa **Conectar Google Drive** y elige **la misma cuenta de Google** en todas.
3. La app recupera los datos existentes y combina los registros locales pendientes antes de guardar. El archivo compartido es `TimeTrack/timetrack-data.json`.
4. Antes de cambiar de equipo, espera el estado **Sincronizado con Drive**. Si el cronómetro está activo, continuará calculando el tiempo desde su hora de inicio en el otro equipo.

Los cambios se envían después de guardarlos y se consultan cada 15 segundos mientras la página está visible. También puedes pulsar **Sincronizar ahora**. Sin internet, los cambios quedan en ese navegador y se sincronizan al recuperar la conexión, siempre que la sesión de Google siga activa.

La sesión de Google se mantiene en memoria. Después de recargar la página o cuando venza, vuelve a conectar Drive. El botón **Cambiar cuenta** mantiene separados los respaldos locales de las cuentas ya conectadas. La primera cuenta conectada recibe los registros locales anteriores a esta actualización.

Los registros tienen versiones y las eliminaciones se conservan para evitar que otra computadora los restaure. Si se modifica el mismo registro en varios equipos, prevalece su versión más reciente según el reloj de los equipos. Drive no reemplaza una base de datos transaccional para edición simultánea; se recomienda usar un solo cronómetro a la vez y mantener los relojes de los equipos sincronizados.

Los archivos duplicados de versiones anteriores se leen y combinan en el archivo más antiguo; no se borran automáticamente. Los botones **JSON** permiten descargar o restaurar un respaldo manual.

Antes de la primera sincronización se conserva una copia local de los registros anteriores por cuenta. El botón **Respaldo previo** permite descargarla desde la computadora donde estaban los datos. Antes de modificar por primera vez un archivo antiguo de Drive, también se crea una copia separada en la carpeta TimeTrack, con nombre `timetrack-respaldo-<id>.json`; si ese respaldo falla, no se actualiza el original. Los respaldos previos se conservan y no se reemplazan en cada sincronización.

## Funciones revisadas

- Cronómetro con restauración al recargar y protección de entradas activas durante la edición y facturación.
- Proyectos y entradas manuales con validación de horas, minutos, tarifas y fechas. La edición conserva los segundos.
- Fechas del calendario local; la semana comienza el lunes y las estadísticas no incluyen registros futuros.
- Totales separados por moneda. Una factura solo admite entradas de un mismo cliente y moneda.
- Historial de nuevas facturas con instantáneas de sus conceptos, reapertura, descarga PDF, impresión y anulación. Anular devuelve los conceptos existentes a pendientes y conserva la factura en el historial.
- Las entradas de facturas emitidas se protegen contra edición y eliminación hasta anular su factura. Las facturas anteriores a esta función no se pueden reconstruir automáticamente porque sus datos de emisión no se guardaban.
- Sincronización de nuevas facturas con Drive y combinación de cambios entre pestañas del mismo navegador. Cambiar de cuenta en una pestaña pausa las demás hasta recargarlas, para evitar mezclar cuentas.
- Controles de Drive y respaldo accesibles también en móvil.
- Avisos de errores de almacenamiento y descarga de los bytes originales si no se pueden leer los datos locales. La importación de un JSON válido permite recuperar el uso de la app; los datos ilegibles no se sobrescriben automáticamente.
- Nombres, tareas y datos de facturas se muestran como texto, incluso si contienen comillas o etiquetas HTML.

El PDF usa las bibliotecas externas ya existentes, jsPDF y html2canvas. Si no cargan, la app muestra el error y permite usar la impresión del navegador.

## Publicación y conexión con Google

Publica el `index.html` actualizado en el alojamiento de la dirección web que ya utilizas. Esta modificación local no publica automáticamente la aplicación.

La web actual es `https://lipehuaman.github.io/time-tracker/` y GitHub Pages la publica desde la raíz de la rama `main`. Su origen OAuth es `https://lipehuaman.github.io`.

La app conserva el OAuth Client ID existente y el permiso `drive.file`. En el proyecto correspondiente de Google Cloud:

- Habilita la API de Google Drive.
- Configura el cliente OAuth como aplicación web y registra el origen de la web en **Authorized JavaScript origins** (protocolo, dominio y puerto; sin la ruta).
- Si el consentimiento está en modo de prueba, agrega las cuentas que van a usar la app como usuarios de prueba.

No se necesita un Client Secret dentro del HTML. No abras el archivo mediante `file://` para autorizar Google.

Referencias: [búsqueda de archivos de Drive](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list), [autorización y vencimiento de tokens](https://developers.google.com/identity/oauth2/web/guides/use-token-model).

## Desarrollo y comprobación

```sh
python3 -m http.server 8000
node --test tests/sync.test.cjs
# Recorridos completos con un perfil temporal de Google Chrome (macOS):
node --test tests/browser.test.cjs
```

Abre `http://localhost:8000` y registra ese origen en el cliente OAuth si quieres comprobar la conexión real localmente.

Las pruebas de sincronización simulan navegadores independientes y la API de Drive: recuperación en otro equipo, primera subida, archivos duplicados, cambios pendientes, eliminaciones, cronómetro, cambios durante una descarga, cuentas separadas y errores HTTP. Para validar los permisos y el cliente OAuth hace falta probar con una cuenta real desde el dominio publicado.

Las pruebas de Chrome comprueban los recorridos reales de proyectos, cronómetro, edición, validación, facturas, PDF de una o varias páginas, impresión, importación/exportación JSON, móvil, pestañas y errores de almacenamiento. Usan perfiles y archivos temporales, sin leer datos personales del navegador.
