/* =====================================================================
   PELUQUERÍA CARRANZA — MOTOR DE AGENDA (compartido)
   Este mismo archivo lo usan:
     • el navegador (index.html) para MOSTRAR horarios libres al instante, y
     • la Edge Function de Supabase (index.ts) para VALIDAR y GUARDAR.
   El navegador nunca decide: el servidor vuelve a calcular todo antes de guardar.
   Es JavaScript "neutro": funciona como <script> clásico y como módulo de Deno.
   Las funciones leen/escriben el estado global `DB` (lo define quien lo usa).
   ===================================================================== */
'use strict';
/* ============ 1. UTILIDADES ============ */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const pad = n => String(n).padStart(2, '0');
const toMin = hhmm => { if (!hhmm) return null; const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const toHHMM = m => pad(Math.floor(m / 60)) + ':' + pad(m % 60);
const money = n => '$' + Math.round(n || 0).toLocaleString('es-AR');
const DIAS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const OCUPAN = ['confirmada', 'completada'];          // estados que ocupan lugar en la agenda
const solapa = (a1, a2, b1, b2) => a1 < b2 && b1 < a2;  // intervalos [a1,a2) y [b1,b2)
const normTel = t => String(t || '').replace(/\D/g, '');

// ---------------------------------------------------------------------------
// HORA "DE PARED": el servidor corre en UTC y el celular del cliente en su zona.
// Para que todos calculen igual, se representa la hora local de la peluquería
// (America/Argentina/Buenos_Aires) DENTRO de los campos UTC de un Date y se usan
// siempre getters UTC. Así "10:30 en Buenos Aires" es getUTCHours() === 10 en
// cualquier máquina del mundo.
// ---------------------------------------------------------------------------
const ZONA_DEFECTO = 'America/Argentina/Buenos_Aires';
const _fmtCache = {};
function relojDePared(ms, zona) {
  const f = _fmtCache[zona] ||= new Intl.DateTimeFormat('en-US', { timeZone: zona, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = {}; for (const x of f.formatToParts(new Date(ms))) p[x.type] = Number(x.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
}
// Reloj simulable: todo el sistema usa ahora() en vez de new Date()
const ahora = () => new Date(relojDePared(Date.now(), DB.config.zonaHoraria || ZONA_DEFECTO) + (DB.config.relojOffsetMs || 0));
const fechaStr = d => d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
const parseFecha = s => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const sumarDias = (s, n) => { const d = parseFecha(s); d.setUTCDate(d.getUTCDate() + n); return fechaStr(d); };
const diaSemana = s => parseFecha(s).getUTCDay();
const minutosDelDia = d => d.getUTCHours() * 60 + d.getUTCMinutes();
const turnoDate = t => { const d = parseFecha(t.fecha); d.setUTCMinutes(t.inicio); return d; };
const fechaLarga = s => parseFecha(s).toLocaleDateString('es-AR', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fechaCorta = s => parseFecha(s).toLocaleDateString('es-AR', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
const fechaHora = iso => new Date(iso).toLocaleString('es-AR', { timeZone: 'UTC', dateStyle: 'short', timeStyle: 'short' });
const ahoraTexto = () => ahora().toLocaleString('es-AR', { timeZone: 'UTC', dateStyle: 'full', timeStyle: 'short' });
const staffNombre = id => (DB.staff.find(s => s.id === id) || { nombre: '(eliminado)' }).nombre;
const getTurno = id => { const t = DB.turnos.find(x => x.id === id); if (!t) throw new Error('Turno inexistente'); return t; };

// Completa campos que falten si el esquema creció (versiones viejas guardadas)
function migrar(d) {
  const s = seed();
  for (const k of Object.keys(s)) if (d[k] === undefined) d[k] = s[k];
  d.config = { ...s.config, ...d.config };
  d.seguridad ||= { fallos: [] };
  d.turnos.forEach(t => { t.recordatorios ||= { largo: false, corto: false }; t.historial ||= []; });
  return d;
}
function save() { /* la persistencia la hace el servidor (index.ts) */ }

function auditar(accion) {
  DB.auditoria.unshift({ en: ahora().toISOString(), accion });
  DB.auditoria.length = Math.min(DB.auditoria.length, 300);
}

/* ============ 3. DATOS INICIALES ============ */
function seed() {
  return {
    version: 1,
    seq: 1000,
    config: {
      apertura: '09:00', cierre: '20:00',
      almuerzoDesde: '13:00', almuerzoHasta: '14:00',
      diasLaborales: [1, 2, 3, 4, 5, 6],
      paso: 15,                  // cada cuántos minutos arranca un turno posible
      buffer: 5,                 // minutos de limpieza entre turnos del mismo profesional
      anticipacionMinMin: 60,    // no se puede reservar con menos de 60 min
      maxDiasAdelanto: 60,
      horasCancelacion: 2,       // el cliente puede cancelar/reprogramar hasta 2 h antes
      horasRecordatorio: 24,     // recordatorio largo
      horasRecordatorio2: 2,     // recordatorio corto
      minutosOferta: 30,         // tiempo para aceptar un lugar liberado de la lista de espera
      maxAusencias: 3,           // con 3 "no vino" se bloquea la reserva online
      zonaHoraria: ZONA_DEFECTO,
      autoCompletar: true,
      pin: '1234',
      relojOffsetMs: 0
    },
    servicios: [
      { id: 'corte',    nombre: 'Corte',           precio: 8000,  duracion: 30,  activo: true },
      { id: 'barba',    nombre: 'Barba',           precio: 4000,  duracion: 20,  activo: true },
      { id: 'lavado',   nombre: 'Lavado',          precio: 2500,  duracion: 15,  activo: true },
      { id: 'color',    nombre: 'Color',           precio: 25000, duracion: 90,  activo: true },
      { id: 'mechas',   nombre: 'Mechas',          precio: 35000, duracion: 120, activo: true },
      { id: 'peinado',  nombre: 'Peinado',         precio: 9000,  duracion: 45,  activo: true },
      { id: 'alisado',  nombre: 'Alisado',         precio: 40000, duracion: 150, activo: true },
      { id: 'infantil', nombre: 'Corte infantil',  precio: 6000,  duracion: 25,  activo: true }
    ],
    staff: [
      { id: 's1', nombre: 'Jorge', dias: [1, 2, 3, 4, 5, 6], desde: '09:00', hasta: '18:00',
        servicios: ['corte', 'barba', 'lavado', 'infantil'], activo: true },
      { id: 's2', nombre: 'Lucía', dias: [2, 3, 4, 5, 6], desde: '10:00', hasta: '20:00',
        servicios: ['corte', 'lavado', 'color', 'mechas', 'peinado', 'alisado'], activo: true },
      { id: 's3', nombre: 'Matías', dias: [1, 3, 5, 6], desde: '09:00', hasta: '17:00',
        servicios: ['corte', 'barba', 'lavado', 'color', 'infantil'], activo: true }
    ],
    turnos: [],
    bloqueos: [],        // {id, fecha, staffId|null, desde|null, hasta|null, motivo}
    espera: [],          // lista de espera
    cupones: [
      { codigo: 'BIENVENIDA10', pct: 10, activo: true, dias: null, usosMax: null, usos: 0 },
      { codigo: 'MARTES20', pct: 20, activo: true, dias: [2], usosMax: null, usos: 0 }
    ],
    clientes: {},        // overrides manuales: { tel: 'bloqueado' | 'permitido' }
    notificaciones: [],
    auditoria: [],
    seguridad: { fallos: [] }   // intentos fallidos de PIN (nunca se envía al navegador)
  };
}

/* ============ 4. MOTOR DE AGENDA ============ */
function staffCapaz(st, ids) { return st.activo && ids.length > 0 && ids.every(id => st.servicios.includes(id)); }

function calcular(ids, cupon, fecha) {
  const sv = ids.map(id => DB.servicios.find(s => s.id === id)).filter(Boolean);
  const duracion = sv.reduce((a, s) => a + Number(s.duracion), 0);
  const subtotal = sv.reduce((a, s) => a + Number(s.precio), 0);
  const cup = validarCupon(cupon, fecha);
  const descuento = cup && cup.ok ? Math.round(subtotal * cup.pct / 100) : 0;
  return { servicios: sv, duracion, subtotal, descuento, total: subtotal - descuento, cupon: cup };
}

function validarCupon(codigo, fecha) {
  codigo = String(codigo || '').trim().toUpperCase();
  if (!codigo) return null;
  const c = DB.cupones.find(x => x.codigo === codigo);
  if (!c || !c.activo) return { ok: false, msg: 'Cupón inválido o inactivo' };
  if (c.usosMax && c.usos >= c.usosMax) return { ok: false, msg: 'Cupón agotado' };
  if (c.dias && c.dias.length && fecha && !c.dias.includes(diaSemana(fecha)))
    return { ok: false, msg: 'Cupón válido solo los ' + c.dias.map(d => DIAS[d]).join(', ') };
  return { ok: true, codigo: c.codigo, pct: c.pct };
}

// ¿El día está cerrado para el local o para ese profesional? Devuelve el motivo o null.
function motivoDiaCerrado(fecha, st, ignorarRango) {
  const hoy = fechaStr(ahora());
  if (!ignorarRango) {
    if (fecha < hoy) return 'Esa fecha ya pasó.';
    if (fecha > sumarDias(hoy, DB.config.maxDiasAdelanto)) return `Solo se reserva hasta ${DB.config.maxDiasAdelanto} días adelante.`;
  }
  const dw = diaSemana(fecha);
  if (!DB.config.diasLaborales.includes(dw)) return 'La peluquería no abre los ' + DIAS[dw] + '.';
  const fer = DB.bloqueos.find(b => b.fecha === fecha && !b.staffId && b.desde == null);
  if (fer) return 'Cerrado: ' + fer.motivo;
  if (st) {
    if (!st.dias.includes(dw)) return st.nombre + ' no trabaja los ' + DIAS[dw] + '.';
    const b = DB.bloqueos.find(b => b.fecha === fecha && b.staffId === st.id && b.desde == null);
    if (b) return st.nombre + ' no atiende ese día: ' + b.motivo;
  }
  return null;
}

// Intervalos ocupados de un profesional en un día: [inicio, fin, motivo]
// excl.turnoId: ignora ese turno (para reprogramar); excl.ofertaId: ignora esa retención de lista de espera
function ocupaciones(fecha, staffId, excl = {}) {
  const c = DB.config, out = [];
  if (c.almuerzoDesde && c.almuerzoHasta) out.push([toMin(c.almuerzoDesde), toMin(c.almuerzoHasta), 'almuerzo']);
  DB.bloqueos.filter(b => b.fecha === fecha && b.desde != null && (!b.staffId || b.staffId === staffId))
    .forEach(b => out.push([toMin(b.desde), toMin(b.hasta), 'bloqueado']));
  DB.turnos.filter(t => t.fecha === fecha && t.staffId === staffId && OCUPAN.includes(t.estado) && t.id !== excl.turnoId)
    .forEach(t => out.push([t.inicio, t.fin, 'reservado']));
  const now = ahora();
  DB.espera.filter(e => e.estado === 'ofertada' && e.fecha === fecha && e.oferta.staffId === staffId &&
                        e.id !== excl.ofertaId && new Date(e.oferta.vence) > now)
    .forEach(e => out.push([e.oferta.inicio, e.oferta.inicio + e.duracion, 'retenido']));
  return out;
}

// Grilla de horarios de UN profesional para una duración dada
function slotsStaff(fecha, st, dur, excl = {}) {
  const cerrado = motivoDiaCerrado(fecha, st);
  if (cerrado) return { cerrado, slots: [] };
  const c = DB.config;
  const ini = Math.max(toMin(c.apertura), toMin(st.desde));
  const fin = Math.min(toMin(c.cierre), toMin(st.hasta));
  const occ = ocupaciones(fecha, st.id, excl);
  const now = ahora();
  const limite = fecha === fechaStr(now) ? minutosDelDia(now) + Number(c.anticipacionMinMin) : -1;
  const buf = Number(c.buffer) || 0;
  const slots = [];
  for (let t = ini; t + dur <= fin; t += Number(c.paso)) {
    let motivo = null;
    if (t < limite) motivo = 'pasado';
    else for (const [a, b, m] of occ) {
      // contra otros turnos se exige además el margen de limpieza (buffer) a ambos lados
      const extra = (m === 'reservado' || m === 'retenido') ? buf : 0;
      if (solapa(t, t + dur + extra, a, b + extra)) { motivo = m; break; }
    }
    slots.push({ t, libre: !motivo, motivo });
  }
  return { cerrado: null, slots };
}

// "Cualquier profesional": une las grillas de todos los que pueden hacer esos servicios
function slotsCualquiera(fecha, ids, dur, excl) {
  const capaces = DB.staff.filter(s => staffCapaz(s, ids));
  if (!capaces.length) return { cerrado: 'Ningún profesional realiza esa combinación de servicios.', slots: [] };
  const mapa = new Map(); let primerMotivo = null;
  for (const st of capaces) {
    const r = slotsStaff(fecha, st, dur, excl);
    if (r.cerrado) { primerMotivo ||= r.cerrado; continue; }
    for (const s of r.slots) {
      if (!mapa.has(s.t)) mapa.set(s.t, { t: s.t, opciones: [], motivos: [] });
      const e = mapa.get(s.t);
      s.libre ? e.opciones.push(st.id) : e.motivos.push(s.motivo);
    }
  }
  if (!mapa.size) return { cerrado: primerMotivo || 'Sin disponibilidad.', slots: [] };
  const slots = [...mapa.values()].sort((a, b) => a.t - b.t).map(e => ({
    t: e.t, opciones: e.opciones, libre: e.opciones.length > 0,
    motivo: e.opciones.length ? null : (e.motivos.some(m => m === 'reservado' || m === 'retenido') ? 'reservado' : e.motivos[0])
  }));
  return { cerrado: null, slots };
}

function calcularSlots(fecha, ids, staffSel, excl = {}) {
  const dur = calcular(ids).duracion;
  if (staffSel === 'any') return slotsCualquiera(fecha, ids, dur, excl);
  const st = DB.staff.find(s => s.id === staffSel);
  if (!st || !staffCapaz(st, ids)) return { cerrado: 'Ese profesional no realiza todos los servicios elegidos.', slots: [] };
  const r = slotsStaff(fecha, st, dur, excl);
  r.slots.forEach(s => s.opciones = s.libre ? [st.id] : []);
  return r;
}

// Balanceo de carga: con "cualquiera" se asigna al profesional con menos minutos reservados ese día
function elegirBalanceado(fecha, opciones) {
  const carga = id => DB.turnos.filter(t => t.fecha === fecha && t.staffId === id && OCUPAN.includes(t.estado))
                               .reduce((a, t) => a + t.duracion, 0);
  return [...opciones].sort((a, b) => carga(a) - carga(b))[0];
}

function primerTurnoLibre(ids, staffSel, excl) {
  const hoy = fechaStr(ahora());
  for (let d = 0; d <= DB.config.maxDiasAdelanto; d++) {
    const f = sumarDias(hoy, d);
    const r = calcularSlots(f, ids, staffSel, excl);
    const s = r.slots.find(x => x.libre);
    if (s) return { fecha: f, t: s.t };
  }
  return null;
}

/* ============ 5. TURNOS ============ */
function validarCliente(nombre, telefono, email) {
  nombre = String(nombre || '').trim();
  const tel = normTel(telefono);
  if (nombre.length < 2) throw new Error('Ingresá tu nombre.');
  if (tel.length < 8 || tel.length > 15) throw new Error('Teléfono inválido (de 8 a 15 dígitos).');
  email = String(email || '').trim();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Email inválido.');
  return { nombre, telefono: tel, email };
}

function estadoCliente(tel) {
  const ts = DB.turnos.filter(t => t.cliente.telefono === tel);
  const ausencias = ts.filter(t => t.estado === 'ausente').length;
  const override = DB.clientes[tel];
  const bloqueado = override === 'bloqueado' || (override !== 'permitido' && ausencias >= DB.config.maxAusencias);
  return { ausencias, bloqueado, override, turnos: ts };
}

// Un mismo cliente no puede tener dos turnos superpuestos (aunque sea con distintos profesionales)
function verificarChoqueCliente(tel, fecha, ini, fin, excluirId) {
  const ch = DB.turnos.find(t => t.cliente.telefono === tel && t.estado === 'confirmada' && t.fecha === fecha &&
                                 t.id !== excluirId && solapa(ini, fin, t.inicio, t.fin));
  if (ch) throw new Error(`Ya tenés otro turno que se superpone (${ch.codigo} a las ${toHHMM(ch.inicio)}).`);
}

// Revalida el horario contra el estado actual y devuelve el profesional asignado (o lanza error)
function resolverHorario(d, excl) {
  if (!d.serviceIds || !d.serviceIds.length) throw new Error('Elegí al menos un servicio.');
  if (!d.fecha) throw new Error('Elegí una fecha.');
  if (!Number.isFinite(d.inicio)) throw new Error('Elegí un horario.');
  const r = calcularSlots(d.fecha, d.serviceIds, d.staffSel, excl);
  if (r.cerrado) throw new Error(r.cerrado);
  const s = r.slots.find(x => x.t === d.inicio);
  if (!s || !s.libre) throw new Error('Ese horario ya no está disponible (alguien lo tomó o quedó bloqueado). Elegí otro o anotate en la lista de espera.');
  return d.staffSel === 'any' ? elegirBalanceado(d.fecha, s.opciones) : s.opciones[0];
}

function marcarRecordatoriosIniciales(t) {
  // Si se reserva con menos de 24 h, la confirmación ya cumple la función del recordatorio largo
  const diff = turnoDate(t) - ahora();
  t.recordatorios = {
    largo: diff <= DB.config.horasRecordatorio * 36e5,
    corto: diff <= DB.config.horasRecordatorio2 * 36e5
  };
}

function datosTurnoTexto(t) {
  return `${fechaLarga(t.fecha)} a las ${toHHMM(t.inicio)} con ${staffNombre(t.staffId)} ` +
         `(${t.servicioNombres.join(' + ')}, ${t.duracion} min, ${money(t.total)}). Código ${t.codigo}.`;
}

function crearTurno(d, opts = {}) {
  const cli = validarCliente(d.nombre, d.telefono, d.email);
  const ec = estadoCliente(cli.telefono);
  if (ec.bloqueado) throw new Error(`No podemos tomar reservas online para este teléfono (${ec.ausencias} ausencias). Comunicate con el local.`);
  const calc = calcular(d.serviceIds, d.cupon, d.fecha);
  if (calc.cupon && !calc.cupon.ok) throw new Error(calc.cupon.msg);
  const staffId = resolverHorario(d, { ofertaId: opts.ofertaId });
  verificarChoqueCliente(cli.telefono, d.fecha, d.inicio, d.inicio + calc.duracion, null);

  const t = {
    id: uid(),
    codigo: 'PC-' + (++DB.seq),
    staffId,
    fecha: d.fecha,
    inicio: d.inicio,
    fin: d.inicio + calc.duracion,
    duracion: calc.duracion,
    servicioIds: calc.servicios.map(s => s.id),
    servicioNombres: calc.servicios.map(s => s.nombre),  // "foto" del momento: si cambian precios, el turno no cambia
    subtotal: calc.subtotal,
    descuento: calc.descuento,
    total: calc.total,
    cupon: calc.cupon && calc.cupon.ok ? calc.cupon.codigo : null,
    cliente: cli,
    notas: String(d.notas || '').trim(),
    estado: 'confirmada',
    origen: opts.origen || 'web',
    creado: ahora().toISOString(),
    recordatorios: { largo: false, corto: false },
    historial: [{ en: ahora().toISOString(), accion: 'Creado (' + (opts.origen || 'web') + ')' }]
  };
  marcarRecordatoriosIniciales(t);
  DB.turnos.push(t);
  if (t.cupon) { const c = DB.cupones.find(x => x.codigo === t.cupon); c.usos = (c.usos || 0) + 1; }
  save();
  notificar('confirmacion', t.cliente, `¡Hola ${cli.nombre}! Tu turno quedó CONFIRMADO: ${datosTurnoTexto(t)}`);
  return t;
}

function verificarPolitica(t, accion) {
  const h = (turnoDate(t) - ahora()) / 36e5;
  if (h < DB.config.horasCancelacion)
    throw new Error(`Solo se puede ${accion} online con al menos ${DB.config.horasCancelacion} h de anticipación. Llamá al local.`);
}

function cancelarTurno(id, por, motivo) {
  const t = getTurno(id);
  if (t.estado !== 'confirmada') throw new Error('Solo se pueden cancelar turnos confirmados.');
  if (por === 'cliente') verificarPolitica(t, 'cancelar');
  t.estado = 'cancelada';
  t.cancelacion = { por, motivo: motivo || '', en: ahora().toISOString() };
  t.historial.push({ en: ahora().toISOString(), accion: `Cancelado por ${por}${motivo ? ': ' + motivo : ''}` });
  if (por === 'admin') auditar(`Canceló ${t.codigo} (${motivo || 'sin motivo'})`);
  save();
  notificar('cancelacion', t.cliente, `Tu turno ${t.codigo} del ${fechaLarga(t.fecha)} ${toHHMM(t.inicio)} fue CANCELADO${motivo ? ' (' + motivo + ')' : ''}.`);
  if (por === 'cliente') notificar('aviso_local', { nombre: 'Peluquería', telefono: 'local' }, `El cliente ${t.cliente.nombre} canceló ${t.codigo} (${toHHMM(t.inicio)} con ${staffNombre(t.staffId)}).`);
  procesarListaEspera(t.fecha);   // ¡se liberó un lugar!
  return t;
}

function reprogramarTurno(id, d, por) {
  const t = getTurno(id);
  if (t.estado !== 'confirmada') throw new Error('Solo se pueden reprogramar turnos confirmados.');
  if (por === 'cliente') verificarPolitica(t, 'reprogramar');
  const calc = calcular(d.serviceIds, t.cupon, d.fecha);
  const staffId = resolverHorario(d, { turnoId: t.id });   // ignora su propio lugar actual
  verificarChoqueCliente(t.cliente.telefono, d.fecha, d.inicio, d.inicio + calc.duracion, t.id);
  const antes = `${t.fecha} ${toHHMM(t.inicio)} ${staffNombre(t.staffId)}`;
  const fechaAnterior = t.fecha;
  Object.assign(t, {
    staffId, fecha: d.fecha, inicio: d.inicio, fin: d.inicio + calc.duracion, duracion: calc.duracion,
    servicioIds: calc.servicios.map(s => s.id), servicioNombres: calc.servicios.map(s => s.nombre),
    subtotal: calc.subtotal, descuento: calc.cupon && calc.cupon.ok ? calc.descuento : 0
  });
  t.total = t.subtotal - t.descuento;
  marcarRecordatoriosIniciales(t);
  t.historial.push({ en: ahora().toISOString(), accion: `Reprogramado por ${por}. Antes: ${antes}` });
  if (por === 'admin') auditar(`Reprogramó ${t.codigo}`);
  save();
  notificar('reprogramacion', t.cliente, `Tu turno fue REPROGRAMADO: ${datosTurnoTexto(t)}`);
  procesarListaEspera(fechaAnterior);
  if (fechaAnterior !== t.fecha) procesarListaEspera(t.fecha);
  return t;
}

function cambiarEstadoAdmin(id, estado) {
  const t = getTurno(id);
  if (estado === 'completada' && t.estado !== 'confirmada') throw new Error('Solo un turno confirmado puede completarse.');
  if (estado === 'ausente') {
    if (!['confirmada', 'completada'].includes(t.estado)) throw new Error('Estado inválido para marcar ausencia.');
    if (turnoDate(t) > ahora()) throw new Error('Todavía no llegó la hora del turno.');
  }
  t.estado = estado;
  t.historial.push({ en: ahora().toISOString(), accion: 'Marcado como ' + estado + ' (admin)' });
  auditar(`Marcó ${t.codigo} como ${estado}`);
  save();
  const ec = estadoCliente(t.cliente.telefono);
  if (estado === 'ausente' && ec.bloqueado)
    notificar('aviso_local', { nombre: 'Peluquería', telefono: 'local' }, `${t.cliente.nombre} (${t.cliente.telefono}) quedó BLOQUEADO para reservas online por ${ec.ausencias} ausencias.`);
}

function generarICS(t) {
  const d = turnoDate(t), f = new Date(d.getTime() + t.duracion * 60000);
  const fmt = x => `${x.getUTCFullYear()}${pad(x.getUTCMonth() + 1)}${pad(x.getUTCDate())}T${pad(x.getUTCHours())}${pad(x.getUTCMinutes())}00`;
  const utc = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Peluqueria Carranza//Turnos//ES', 'BEGIN:VEVENT',
    `UID:${t.id}@peluqueria-carranza`, `DTSTAMP:${utc}`, `DTSTART:${fmt(d)}`, `DTEND:${fmt(f)}`,
    `SUMMARY:Peluquería Carranza - ${t.servicioNombres.join(' + ')}`,
    `DESCRIPTION:Código ${t.codigo} con ${staffNombre(t.staffId)}. Total ${money(t.total)}`,
    'BEGIN:VALARM', 'TRIGGER:-PT24H', 'ACTION:DISPLAY', 'DESCRIPTION:Turno mañana en Peluquería Carranza', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}
const linkWhatsApp = t => 'https://wa.me/?text=' + encodeURIComponent('Mi turno en Peluquería Carranza: ' + datosTurnoTexto(t));

/* ============ 6. LISTA DE ESPERA ============ */
function anotarEnEspera(d) {
  const cli = validarCliente(d.nombre, d.telefono, d.email);
  if (!d.serviceIds.length) throw new Error('Elegí servicios primero.');
  if (!d.fecha) throw new Error('Elegí una fecha.');
  const cerrado = d.staffSel === 'any' ? null : motivoDiaCerrado(d.fecha, DB.staff.find(s => s.id === d.staffSel));
  if (cerrado) throw new Error(cerrado);
  if (estadoCliente(cli.telefono).bloqueado) throw new Error('Este teléfono no puede reservar online. Comunicate con el local.');
  if (DB.espera.some(e => e.cliente.telefono === cli.telefono && e.fecha === d.fecha && ['esperando', 'ofertada'].includes(e.estado)))
    throw new Error('Ya estás en la lista de espera para ese día.');
  const dur = calcular(d.serviceIds).duracion;
  if (d.desde != null && d.hasta != null && d.hasta - d.desde < dur) throw new Error(`El rango debe abarcar al menos ${dur} min.`);
  const e = {
    id: uid(), fecha: d.fecha, staffId: d.staffSel, serviceIds: d.serviceIds, duracion: dur,
    desde: d.desde, hasta: d.hasta, cliente: cli, estado: 'esperando', creada: ahora().toISOString(), oferta: null
  };
  DB.espera.push(e);
  const pos = DB.espera.filter(x => x.fecha === d.fecha && x.estado === 'esperando').length;
  save();
  notificar('espera_alta', cli, `Quedaste en la lista de espera del ${fechaLarga(d.fecha)} (posición ${pos}). Te avisamos si se libera un lugar.`);
  procesarListaEspera(d.fecha);   // por si justo hay un hueco que le sirve
  return e;
}

function buscarHuecoEspera(e) {
  const cand = DB.staff.filter(s => (e.staffId === 'any' || s.id === e.staffId) && staffCapaz(s, e.serviceIds));
  for (const st of cand) {
    const r = slotsStaff(e.fecha, st, e.duracion);
    if (r.cerrado) continue;
    const s = r.slots.find(s => s.libre && (e.desde == null || s.t >= e.desde) && (e.hasta == null || s.t + e.duracion <= e.hasta));
    if (s) return { staffId: st.id, t: s.t };
  }
  return null;
}

// Recorre la lista en orden de llegada (FIFO); a quien le sirva un hueco se le ofrece y se le RETIENE
function procesarListaEspera(fecha) {
  const pend = DB.espera.filter(e => e.fecha === fecha && e.estado === 'esperando')
                        .sort((a, b) => a.creada.localeCompare(b.creada));
  let n = 0;
  for (const e of pend) {
    const h = buscarHuecoEspera(e);
    if (!h) continue;
    e.estado = 'ofertada';
    e.oferta = { staffId: h.staffId, inicio: h.t, vence: new Date(ahora().getTime() + DB.config.minutosOferta * 60000).toISOString() };
    n++;
    notificar('espera_oferta', e.cliente, `¡Se liberó un lugar, ${e.cliente.nombre}! ${fechaLarga(e.fecha)} a las ${toHHMM(h.t)} con ${staffNombre(h.staffId)}. ` +
      `Te lo guardamos ${DB.config.minutosOferta} min: aceptalo en "Lista de espera".`);
  }
  if (n) save();
  return n;
}

function getEspera(id, tel) {
  const e = DB.espera.find(x => x.id === id);
  if (!e || (tel != null && normTel(tel) !== e.cliente.telefono)) throw new Error('Registro de espera no encontrado.');
  return e;
}

function aceptarOferta(id, tel) {
  const e = getEspera(id, tel);
  if (e.estado !== 'ofertada') throw new Error('No hay una oferta vigente.');
  if (new Date(e.oferta.vence) <= ahora()) { e.estado = 'expirada'; save(); throw new Error('La oferta venció.'); }
  const t = crearTurno({ serviceIds: e.serviceIds, staffSel: e.oferta.staffId, fecha: e.fecha, inicio: e.oferta.inicio,
    nombre: e.cliente.nombre, telefono: e.cliente.telefono, email: e.cliente.email, notas: 'Desde lista de espera', cupon: '' },
    { ofertaId: e.id, origen: 'lista de espera' });
  e.estado = 'aceptada'; e.turnoId = t.id;
  save();
  return t;
}

function rechazarOferta(id, tel) {
  const e = getEspera(id, tel);
  e.estado = e.estado === 'ofertada' ? 'rechazada' : 'cancelada';
  save();
  procesarListaEspera(e.fecha);   // pasa al siguiente en la fila
}

/* ============ 7. NOTIFICACIONES + SCHEDULER ============ */
// Único punto de salida de notificaciones. Se registran en DB.notificaciones y,
// para mostrarlas en pantalla a quien hizo la acción, en globalThis.__notifsReq.
// Para enviar WhatsApp/SMS/email reales: reemplazar el cuerpo por la llamada a la API.
function notificar(tipo, para, mensaje) {
  if (globalThis.SILENCIO) return;
  const canal = para.email ? 'WhatsApp/SMS + Email' : 'WhatsApp/SMS';
  const n = { en: ahora().toISOString(), tipo, tel: para.telefono, para: `${para.nombre} <${para.telefono}${para.email ? ' / ' + para.email : ''}>`, canal, mensaje };
  DB.notificaciones.unshift(n);
  DB.notificaciones.length = Math.min(DB.notificaciones.length, 500);
  if (globalThis.__notifsReq) globalThis.__notifsReq.push(n);
  console.log(`[${tipo.toUpperCase()}] -> ${n.para} via ${canal}: ${mensaje}`);
}

// Se ejecuta cada 15 s y cada vez que se mueve el reloj simulado
function tick() {
  const now = ahora(), c = DB.config;
  let cambio = false;
  for (const t of DB.turnos) {
    if (t.estado !== 'confirmada') continue;
    const diff = turnoDate(t) - now;
    if (!t.recordatorios.largo && diff > 0 && diff <= c.horasRecordatorio * 36e5) {
      t.recordatorios.largo = true; cambio = true;
      notificar('recordatorio_' + c.horasRecordatorio + 'h', t.cliente, `Recordatorio: tenés turno ${datosTurnoTexto(t)} Si no podés venir, cancelá desde "Mis turnos".`);
    }
    if (!t.recordatorios.corto && diff > 0 && diff <= c.horasRecordatorio2 * 36e5) {
      t.recordatorios.corto = true; cambio = true;
      notificar('recordatorio_' + c.horasRecordatorio2 + 'h', t.cliente, `¡Te esperamos hoy a las ${toHHMM(t.inicio)} con ${staffNombre(t.staffId)}! (${t.codigo})`);
    }
    if (c.autoCompletar && diff + t.duracion * 60000 <= 0) {
      t.estado = 'completada'; cambio = true;
      t.historial.push({ en: now.toISOString(), accion: 'Completado automáticamente' });
    }
  }
  const hoy = fechaStr(now);
  for (const e of DB.espera) {
    if (['esperando', 'ofertada'].includes(e.estado) && e.fecha < hoy) { e.estado = 'expirada'; cambio = true; continue; }
    if (e.estado === 'ofertada' && new Date(e.oferta.vence) <= now) {
      e.estado = 'expirada'; cambio = true;
      notificar('espera_expirada', e.cliente, `Venció el lugar que te reservamos (${toHHMM(e.oferta.inicio)}). Lo ofrecemos al siguiente de la lista.`);
    }
  }
  // Reintentar todas las fechas con gente esperando (por si algo se liberó por cualquier vía)
  new Set(DB.espera.filter(e => e.estado === 'esperando').map(e => e.fecha))
    .forEach(f => { if (procesarListaEspera(f)) cambio = true; });
  if (cambio) save();
  return cambio;
}

/* ============ 8. ADMIN: bloqueos, feriados, stats ============ */
function turnosAfectados(b) {
  return DB.turnos.filter(t => t.estado === 'confirmada' && t.fecha === b.fecha && (!b.staffId || t.staffId === b.staffId) &&
                               (b.desde == null || solapa(t.inicio, t.fin, toMin(b.desde), toMin(b.hasta))));
}

// Agrega bloqueos. Si pisan turnos confirmados y no se pidió `forzar`, devuelve los
// afectados para que el admin confirme; con `forzar` los cancela y avisa a los clientes.
function agregarBloqueos(lista, forzar) {
  lista = lista.filter(b => !DB.bloqueos.some(x => x.fecha === b.fecha && x.staffId === b.staffId && x.desde === b.desde && x.hasta === b.hasta));
  if (!lista.length) throw new Error('Esos bloqueos ya existían.');
  const afectados = [...new Set(lista.flatMap(turnosAfectados))];
  if (afectados.length && !forzar)
    return { requiereConfirmacion: true, afectados: afectados.map(t => `${t.codigo} ${t.fecha} ${toHHMM(t.inicio)} ${t.cliente.nombre}`) };
  lista.forEach(b => { b.id = uid(); DB.bloqueos.push(b); });
  afectados.forEach(t => cancelarTurno(t.id, 'admin', 'Cierre: ' + lista[0].motivo));
  auditar(`Agregó ${lista.length} bloqueo(s): ${lista[0].motivo}`);
  save();
  return { agregados: lista.length };
}

function pascua(y) {   // algoritmo de Meeus/Jones/Butcher
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4,
    f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30,
    i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451),
    mes = Math.floor((h + l - 7 * m + 114) / 31), dia = ((h + l - 7 * m + 114) % 31) + 1;
  return fechaStr(new Date(Date.UTC(y, mes - 1, dia)));
}
function feriadosArgentina(y) {
  const fijos = [['01-01', 'Año Nuevo'], ['03-24', 'Día de la Memoria'], ['04-02', 'Malvinas'], ['05-01', 'Día del Trabajador'],
    ['05-25', 'Revolución de Mayo'], ['06-20', 'Día de la Bandera'], ['07-09', 'Independencia'],
    ['12-08', 'Inmaculada Concepción'], ['12-25', 'Navidad']];
  const p = pascua(y);
  return [...fijos.map(([md, m]) => ({ fecha: `${y}-${md}`, motivo: m })),
    { fecha: sumarDias(p, -48), motivo: 'Carnaval' }, { fecha: sumarDias(p, -47), motivo: 'Carnaval' },
    { fecha: sumarDias(p, -2), motivo: 'Viernes Santo' }]
    .map(f => ({ ...f, staffId: null, desde: null, hasta: null }));
}

function minutosDisponibles(fecha, st) {
  if (motivoDiaCerrado(fecha, st, true)) return 0;
  const c = DB.config;
  const ini = Math.max(toMin(c.apertura), toMin(st.desde)), fin = Math.min(toMin(c.cierre), toMin(st.hasta));
  let total = Math.max(0, fin - ini);
  const resta = (a, b) => { total -= Math.max(0, Math.min(b, fin) - Math.max(a, ini)); };
  if (c.almuerzoDesde && c.almuerzoHasta) resta(toMin(c.almuerzoDesde), toMin(c.almuerzoHasta));
  DB.bloqueos.filter(b => b.fecha === fecha && b.desde != null && (!b.staffId || b.staffId === st.id)).forEach(b => resta(toMin(b.desde), toMin(b.hasta)));
  return Math.max(0, total);
}

function generarDemo() {
  const clientes = ['Ana Gómez', 'Bruno Díaz', 'Carla Ruiz', 'Diego Sosa', 'Elena Paz', 'Facundo Ríos',
    'Gabriela Luna', 'Hernán Vega', 'Inés Molina', 'Julián Castro'].map((n, i) => ({ nombre: n, telefono: '11' + (40000000 + i * 1111111) }));
  const rnd = a => a[Math.floor(Math.random() * a.length)];
  const combo = st => { const base = rnd(st.servicios); const extra = Math.random() < .35 ? rnd(st.servicios) : null;
    return [...new Set([base, extra].filter(Boolean))].filter(id => DB.servicios.find(s => s.id === id && s.activo)); };
  const hoy = fechaStr(ahora());
  let fut = 0, pas = 0;
  globalThis.SILENCIO = true;
  try {
    for (let d = 0; d < 7; d++) {
      const f = sumarDias(hoy, d);
      for (const st of DB.staff.filter(s => s.activo)) for (let k = 0; k < 5; k++) {
        const ids = combo(st); if (!ids.length) continue;
        const libres = slotsStaff(f, st, calcular(ids).duracion).slots.filter(s => s.libre);
        if (!libres.length) break;
        const c = rnd(clientes);
        try { crearTurno({ serviceIds: ids, staffSel: st.id, fecha: f, inicio: rnd(libres).t, ...c, email: '', notas: '', cupon: '' }, { origen: 'demo' }); fut++; } catch (e) { /* choque: se saltea */ }
      }
    }
    // Pasado (para estadísticas): se insertan directo, sin validaciones de fecha
    for (let d = 1; d <= 25; d++) {
      const f = sumarDias(hoy, -d);
      if (!DB.config.diasLaborales.includes(diaSemana(f))) continue;
      for (const st of DB.staff.filter(s => s.activo && s.dias.includes(diaSemana(f)))) {
        let cur = toMin(st.desde);
        while (true) {
          const ids = combo(st); const calc = calcular(ids);
          cur += Math.round(Math.random() * 4) * DB.config.paso;
          if (DB.config.almuerzoDesde && solapa(cur, cur + calc.duracion, toMin(DB.config.almuerzoDesde), toMin(DB.config.almuerzoHasta))) cur = toMin(DB.config.almuerzoHasta);
          if (cur + calc.duracion > toMin(st.hasta)) break;
          const r = Math.random(), c = rnd(clientes);
          DB.turnos.push({ id: uid(), codigo: 'PC-' + (++DB.seq), staffId: st.id, fecha: f, inicio: cur, fin: cur + calc.duracion,
            duracion: calc.duracion, servicioIds: ids, servicioNombres: calc.servicios.map(s => s.nombre), subtotal: calc.subtotal,
            descuento: 0, total: calc.total, cupon: null, cliente: { ...c, email: '' }, notas: '', origen: 'demo',
            estado: r < .8 ? 'completada' : r < .88 ? 'ausente' : 'cancelada', creado: new Date(parseFecha(f).getTime() - 3 * 864e5).toISOString(),
            recordatorios: { largo: true, corto: true }, historial: [{ en: ahora().toISOString(), accion: 'Generado (demo)' }] });
          pas++;
          cur += calc.duracion + DB.config.buffer;
        }
      }
    }
  } finally { globalThis.SILENCIO = false; }
  auditar(`Generó datos demo (${fut} futuros, ${pas} pasados)`);
  save();
  return { fut, pas };
}


/* ============ EXPORTACIÓN ============ */
globalThis.Motor = {
  seed, migrar, tick, ahora, fechaStr, sumarDias, parseFecha, diaSemana, toMin, toHHMM, normTel, relojDePared, ZONA_DEFECTO,
  calcular, validarCupon, calcularSlots, slotsStaff, primerTurnoLibre, estadoCliente, getTurno, getEspera,
  crearTurno, cancelarTurno, reprogramarTurno, cambiarEstadoAdmin, verificarPolitica,
  anotarEnEspera, aceptarOferta, rechazarOferta, procesarListaEspera,
  agregarBloqueos, feriadosArgentina, generarDemo, auditar, OCUPAN
};
