# Peluquería Carranza — Sistema de turnos

Todo el sistema está en un solo archivo, **`index.html`**: HTML, CSS y JavaScript sin frameworks ni backend. Para usarlo, abrí el archivo en el navegador. Los datos se guardan en el `localStorage` del navegador.

- **Panel de administración (oculto):** agregá `#admin` a la URL o hacé doble clic en "© Peluquería Carranza", en el pie de página. El PIN inicial es **1234**.
- **Para probar rápido:** Admin → *Datos y respaldo* → **Generar turnos de prueba**. Con el **Reloj simulado** podés adelantar el tiempo y ver cómo salen los recordatorios y cómo vencen las ofertas.

---

## 1. Funciones implementadas y qué problema resuelven

### Funciones pedidas

| Función | Qué hace | Problema que resuelve |
|---|---|---|
| **Turnos inteligentes** | Muestra solo los horarios donde entra el servicio completo. Descarta horarios pasados, los que están a menos de 60 min, los días cerrados, el almuerzo, los bloqueos y los turnos ya tomados. | No se puede reservar un horario imposible, y la reserva funciona sin que nadie atienda el teléfono. |
| **Agenda por profesional** | Cada profesional tiene sus días, su horario y los servicios que realiza. Con "Cualquiera disponible" se juntan las agendas de todos y el turno se asigna a quien tenga **menos carga** ese día. | Cada estilista tiene su agenda y el trabajo se reparte de forma pareja. |
| **Precios y tiempos** | Cada servicio tiene precio y duración. Si elegís varios, se suman: Color (90) + Corte (30) bloquea **120 min**. | Un color ya no se pisa con el turno siguiente, y el cliente ve el precio antes de reservar. |
| **Notificaciones simuladas** | Confirmación, recordatorio **24 h antes**, recordatorio **2 h antes**, cancelación, reprogramación y avisos de la lista de espera. Salen por `console.log`, como toast en pantalla, en el registro del admin y, si lo activás, como `alert()` o notificación nativa del navegador. | Menos clientes que se olvidan del turno. La lógica ya queda preparada para conectar WhatsApp o email reales. |
| **Panel admin** | Historial con filtros, cancelar, completar, marcar "no vino", feriados y bloqueos, y **ganancias estimadas del día**. | Los dueños controlan el negocio desde la misma página. |
| **Lista de espera activa** | Te anotás para un día (con rango horario opcional). Cuando se libera un lugar, se le ofrece **al primero de la fila** y queda **retenido** 30 min a su nombre. | Los huecos de las cancelaciones no quedan vacíos. |

### Extras que agregué

1. **Reprogramar turnos.** Lo pueden hacer el cliente o el admin. Se calcula con su propio lugar liberado, así que puede correrse 15 min sin chocar consigo mismo.
2. **"Mis turnos" (autogestión).** El cliente busca por teléfono, cancela (tiene que escribir el **código del turno** para confirmar), reprograma, descarga un **.ics** con alarma de 24 h y comparte por WhatsApp.
3. **Política de cancelación.** El cliente solo puede cancelar o reprogramar online hasta X horas antes (se configura). El admin no tiene ese límite.
4. **Primer turno libre.** Busca el hueco más cercano en los próximos 60 días.
5. **Margen entre turnos (buffer).** Deja 5 min de limpieza entre cliente y cliente.
6. **Choque del mismo cliente.** No deja que una persona tenga dos turnos superpuestos, aunque sean con profesionales distintos.
7. **Cupones de descuento.** Por porcentaje, con límite de usos y restricción por día (por ejemplo `MARTES20`). Vienen cargados `BIENVENIDA10` y `MARTES20`.
8. **Control de ausencias.** Con 3 "no vino" se bloquea la reserva online de ese teléfono. El admin puede bloquear o desbloquear a mano.
9. **Ficha de clientes.** Visitas, cancelaciones, ausencias, gasto total y último turno.
10. **Feriados automáticos de Argentina.** Los fijos, más Carnaval y Viernes Santo, calculados con el algoritmo de Pascua. Los feriados trasladables se cargan a mano.
11. **Bloqueos parciales.** Por ejemplo, "Lucía no atiende de 15 a 17". Si el bloqueo pisa turnos, el sistema pregunta si cancelarlos y avisar a los clientes.
12. **Agenda visual del día.** Una grilla de hora × profesional con turnos, almuerzo, bloqueos y lugares retenidos.
13. **Estadísticas de 30 días.** Facturación, ticket promedio, tasa de cancelación y de ausentismo, ranking de servicios, ventas por profesional, día de la semana y hora pico.
14. **Ocupación por profesional.** Porcentaje de la jornada reservado y tiempo libre que queda.
15. **CRUD completo.** Servicios, profesionales, cupones y configuración general, sin tocar código.
16. **Reloj simulado.** Sirve para probar recordatorios y vencimientos sin esperar 24 h.
17. **Auditoría.** Registro de cada acción del admin.
18. **Respaldo.** Exportar e importar en JSON, exportar el historial a CSV (con BOM para que Excel muestre bien los acentos) y reiniciar los datos.
19. **Sincronización entre pestañas.** Si reservás en una pestaña, las otras se actualizan solas (evento `storage`).
20. **Diseño profesional.** Sistema de diseño con variables CSS, modo oscuro automático, tipografía Fraunces + Inter, tarjetas de servicio, horarios agrupados por mañana, tarde y noche, resumen fijo al costado, toasts, KPIs, badges de estado, animaciones suaves (se desactivan con `prefers-reduced-motion`) y diseño responsive sin scroll horizontal en el celular.

---

## 2. Cómo funciona la lógica por dentro

### 2.1 Modelo de datos (`DB`)
Toda la información vive en un único objeto `DB`, que se guarda como JSON en `localStorage['carranza_turnos_v1']`:

```
config        horarios, almuerzo, paso, buffer, políticas, PIN, desfase del reloj
servicios[]   {id, nombre, precio, duracion, activo}
staff[]       {id, nombre, dias[0-6], desde, hasta, servicios[], activo}
turnos[]      {id, codigo, staffId, fecha, inicio, fin (minutos desde 00:00), duracion,
               servicioIds, servicioNombres, subtotal, descuento, total, cupon,
               cliente{nombre,telefono,email}, estado, recordatorios{largo,corto}, historial[]}
bloqueos[]    {fecha, staffId|null (=todo el local), desde|null (=día completo), hasta, motivo}
espera[]      {fecha, staffId|'any', serviceIds, duracion, desde, hasta, cliente, estado, oferta{staffId,inicio,vence}}
cupones[], clientes{tel: 'bloqueado'|'permitido'}, notificaciones[], auditoria[], seq
```

Las horas se guardan como **minutos desde medianoche** (por ejemplo 10:30 → 630). Así detectar choques es pura aritmética. El precio y los nombres de los servicios se **copian dentro del turno** al reservarlo: si mañana sube el precio del corte, los turnos ya tomados y el historial de ganancias no cambian.

### 2.2 Estados de un turno
```
             ┌──────────── cancelar (cliente con política / admin) ───► cancelada
confirmada ──┼──────────── reprogramar ───► confirmada (nueva fecha/hora)
             ├──────────── admin "Completado" o fin del turno (auto) ───► completada
             └──────────── admin "No vino" (solo si ya pasó la hora) ───► ausente
completada ─────────────── admin "No vino" ───► ausente
```
Solo `confirmada` y `completada` **ocupan lugar** en la agenda (constante `OCUPAN`). Los turnos cancelados o ausentes liberan el hueco y cuentan como "perdido" en las ganancias.

Lista de espera: `esperando → ofertada → aceptada` (se crea el turno). Desde `ofertada` también puede pasar a `rechazada` o `expirada`; en ese caso el lugar se ofrece al siguiente. Si la fecha ya pasó, la entrada queda `expirada`.

### 2.3 Cómo se calculan los horarios libres y se evitan los choques
`slotsStaff(fecha, profesional, duracion)`:
1. `motivoDiaCerrado` revisa en orden: fecha pasada, demasiado adelante, día que no abre el local, feriado del local, día que no trabaja el profesional y bloqueo de día completo del profesional. Si alguna se cumple, devuelve el motivo y no hay horarios.
2. La ventana de trabajo es `max(apertura, entrada del profesional)` a `min(cierre, salida del profesional)`.
3. `ocupaciones()` arma la lista de intervalos ocupados: almuerzo, bloqueos parciales, turnos `OCUPAN` y **lugares retenidos** por ofertas de lista de espera vigentes.
4. Se recorre la ventana cada `paso` minutos (15 por defecto). Un horario `t` sirve si `t + duración ≤ fin` y no se superpone con ningún intervalo ocupado:
   `solapa(a1,a2,b1,b2) = a1 < b2 && b1 < a2`.
   Contra otros turnos se suma el `buffer` a ambos lados.
5. Si es hoy, se descartan los horarios antes de `ahora + anticipación mínima`.

Con **"Cualquiera"**, `slotsCualquiera` junta las grillas de todos los profesionales que hacen *todos* los servicios elegidos. Un horario está libre si al menos uno está disponible, y `elegirBalanceado` asigna al que tenga menos minutos reservados ese día.

**Doble verificación anti doble reserva:** al confirmar, primero se llama a `recargar()` para leer la última versión desde LocalStorage, porque otra pestaña pudo haber reservado. Después `resolverHorario()` vuelve a calcular la grilla y verifica que el horario elegido siga libre. Si no, sale el error *"Ese horario ya no está disponible"* y la pantalla se actualiza. Por último, `verificarChoqueCliente` evita que el mismo teléfono tenga dos turnos superpuestos.

### 2.4 Lista de espera
- `anotarEnEspera` guarda el pedido con su duración y su rango, y enseguida llama a `procesarListaEspera(fecha)` por si ya hay un hueco que le sirva.
- Cualquier evento que libere lugar (cancelación, reprogramación, quitar un bloqueo, oferta vencida o rechazada) vuelve a llamar a `procesarListaEspera`. Además, el *tick* la reintenta cada 15 s.
- `procesarListaEspera` recorre la fila en **orden de llegada (FIFO)**. Al primero que le entra un hueco se le marca `ofertada` y ese hueco aparece como **`retenido`** en `ocupaciones()`. Por eso nadie más lo ve libre y tampoco se le ofrece al segundo de la fila.
- Al aceptar, se llama a `crearTurno` con `excl.ofertaId`, de modo que la persona puede tomar el lugar que se le retuvo.

### 2.5 Recordatorios (scheduler)
`tick()` se ejecuta al cargar la página, cada 15 s y cada vez que movés el reloj simulado:
- Para cada turno `confirmada`, calcula `diff = inicio − ahora`. Si `0 < diff ≤ 24 h` y no se envió el recordatorio largo, lo envía y lo marca (`recordatorios.largo = true`). Con 2 h hace lo mismo para el corto. Las marcas evitan enviar dos veces.
- Si el turno se reservó con menos de 24 h, el recordatorio largo se marca como enviado al crearlo, porque la confirmación ya cumple esa función.
- Vencen las ofertas cuya hora límite ya pasó, expiran las esperas de días pasados y se completan solos los turnos terminados (`autoCompletar`).

Todas las funciones usan `ahora()` = `Date.now() + config.relojOffsetMs`, no `new Date()`. Gracias a eso el **reloj simulado** mueve el sistema entero.

`notificar()` es el único punto de salida: escribe en el registro, en la consola, en un toast, y opcionalmente en `alert()` o en la Notification API. Para conectar WhatsApp, SMS o email reales alcanza con reemplazar esa función por una llamada a la API correspondiente.

### 2.6 Persistencia
- `load()` lee `localStorage` y pasa por `migrar()`, que completa los campos nuevos si los datos guardados son de una versión anterior. Si no hay nada guardado, usa `seed()` con los datos iniciales.
- `save()` se llama después de **cada** cambio, así nada se pierde al recargar.
- El evento `storage` sincroniza todas las pestañas abiertas.
- `try/catch` alrededor del almacenamiento: en modo privado o con el almacenamiento lleno, la app sigue funcionando en memoria.

### 2.7 Límites (porque es una app sin servidor)
- El PIN de admin **no es seguridad real**: cualquiera puede leer el código fuente. Para producción hace falta un backend con autenticación.
- Los datos viven en **un solo navegador**. Para que los clientes reserven desde sus celulares y el local lo vea, hay que mover `DB` a un servidor (Supabase, Firebase o una API propia). La lógica de agenda se puede reutilizar tal cual.
- La verificación anti choques entre pestañas es optimista. Entre usuarios reales, la garantía la tiene que dar el servidor (con una transacción o una restricción única).
