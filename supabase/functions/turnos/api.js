/* =====================================================================
   PELUQUERÍA CARRANZA — API (lógica del servidor, sin E/S)
   manejar(estado, accion, payload) → { db, respuesta }
   • Corre el scheduler (recordatorios, vencimientos) en cada llamada.
   • Valida TODO con el motor antes de modificar.
   • Devuelve al público una "foto" SIN datos personales; al admin (con PIN) la completa.
   • Si una acción falla, se descartan sus cambios parciales.
   Es puro: no toca la red ni la base. index.ts hace la lectura/escritura atómica.
   ===================================================================== */
'use strict';

const MAX_FALLOS_PIN = 5, VENTANA_PIN_MS = 15 * 60 * 1000;

function estadoInicial(pin) {
  const d = globalThis.Motor.seed();
  d.config.pin = String(pin || Math.floor(10000000 + Math.random() * 89999999));
  return d;
}

// ---------- Fotos del estado ----------
function snapshotPublico() {
  const M = globalThis.Motor, D = globalThis.DB, hoy = M.fechaStr(M.ahora());
  const ayer = M.sumarDias(hoy, -1), now = M.ahora();
  const { pin, ...config } = D.config;
  return {
    config,
    servicios: D.servicios,
    staff: D.staff,
    bloqueos: D.bloqueos.filter(b => b.fecha >= ayer),
    // Solo lo necesario para calcular disponibilidad: ni nombres, ni teléfonos, ni códigos
    turnos: D.turnos.filter(t => M.OCUPAN.includes(t.estado) && t.fecha >= ayer)
      .map(t => ({ id: t.id, staffId: t.staffId, fecha: t.fecha, inicio: t.inicio, fin: t.fin, duracion: t.duracion, estado: t.estado })),
    espera: D.espera.filter(e => e.estado === 'ofertada' && new Date(e.oferta.vence) > now)
      .map(e => ({ id: e.id, estado: e.estado, fecha: e.fecha, duracion: e.duracion, oferta: e.oferta })),
    cupones: [], clientes: {}, notificaciones: [], auditoria: [], seq: 0,
    publico: true
  };
}
function snapshotAdmin() {
  const { seguridad, ...resto } = globalThis.DB;
  const { pin, ...config } = resto.config;
  return { ...resto, config, publico: false };
}

// Lo que ve un cliente de SU turno (sin datos de otros)
const turnoCliente = t => ({
  id: t.id, codigo: t.codigo, staffId: t.staffId, fecha: t.fecha, inicio: t.inicio, fin: t.fin, duracion: t.duracion,
  servicioIds: t.servicioIds, servicioNombres: t.servicioNombres, subtotal: t.subtotal, descuento: t.descuento,
  total: t.total, cupon: t.cupon, estado: t.estado, notas: t.notas,
  cliente: { nombre: t.cliente.nombre, telefono: t.cliente.telefono, email: t.cliente.email }
});
const esperaCliente = e => {
  const fila = globalThis.DB.espera.filter(x => x.fecha === e.fecha && x.estado === 'esperando').sort((a, b) => a.creada.localeCompare(b.creada));
  return { id: e.id, fecha: e.fecha, staffId: e.staffId, desde: e.desde, hasta: e.hasta, duracion: e.duracion,
    estado: e.estado, creada: e.creada, oferta: e.oferta, posicion: fila.indexOf(e) + 1 };
};

// ---------- Seguridad ----------
function verificarPin(pin) {
  const D = globalThis.DB, ahoraReal = Date.now();
  D.seguridad ||= { fallos: [] };
  D.seguridad.fallos = D.seguridad.fallos.filter(t => ahoraReal - t < VENTANA_PIN_MS);
  if (D.seguridad.fallos.length >= MAX_FALLOS_PIN) throw new Error('Demasiados intentos fallidos. Esperá 15 minutos.');
  if (typeof pin !== 'string' || pin.length === 0 || pin !== String(D.config.pin)) {
    D.seguridad.fallos.push(ahoraReal);
    throw new Error('PIN incorrecto.');
  }
  D.seguridad.fallos = [];
}
function turnoDelCliente(id, codigo, tel) {
  const M = globalThis.Motor;
  const t = globalThis.DB.turnos.find(x => x.id === id);
  if (!t || String(codigo || '').trim().toUpperCase() !== t.codigo || M.normTel(tel) !== t.cliente.telefono)
    throw new Error('El código o el teléfono no coinciden con el turno.');
  return t;
}
const texto = (v, max) => String(v ?? '').slice(0, max);
function limpiarDatos(d = {}) {
  return {
    serviceIds: Array.isArray(d.serviceIds) ? d.serviceIds.map(String).slice(0, 10) : [],
    staffSel: texto(d.staffSel || 'any', 40), fecha: texto(d.fecha, 10), inicio: Number(d.inicio),
    nombre: texto(d.nombre, 60), telefono: texto(d.telefono, 30), email: texto(d.email, 80),
    notas: texto(d.notas, 200), cupon: texto(d.cupon, 30),
    desde: d.desde == null ? null : Number(d.desde), hasta: d.hasta == null ? null : Number(d.hasta)
  };
}

// ---------- Acciones de administración ----------
function accionAdmin(op, a) {
  const M = globalThis.Motor, D = globalThis.DB;
  switch (op) {
    case 'login': return { ok: true };
    case 'reservar': return { turno: turnoCliente(M.crearTurno(limpiarDatos(a.datos), { origen: 'mostrador' })) };
    case 'reprogramar': return { turno: turnoCliente(M.reprogramarTurno(a.id, limpiarDatos(a.datos), 'admin')) };
    case 'cancelar': M.cancelarTurno(a.id, 'admin', texto(a.motivo, 200)); return {};
    case 'completar': M.cambiarEstadoAdmin(a.id, 'completada'); return {};
    case 'ausente': M.cambiarEstadoAdmin(a.id, 'ausente'); return {};
    case 'bloqueos': {
      const lista = (a.lista || []).slice(0, 50).map(b => ({ fecha: texto(b.fecha, 10), staffId: b.staffId || null,
        desde: b.desde || null, hasta: b.hasta || null, motivo: texto(b.motivo, 80) || 'Bloqueo' }));
      return M.agregarBloqueos(lista, !!a.forzar);
    }
    case 'feriados': return M.agregarBloqueos(M.feriadosArgentina(Number(a.anio)), !!a.forzar);
    case 'bloqueo_borrar': {
      const b = D.bloqueos.find(x => x.id === a.id); if (!b) throw new Error('Bloqueo inexistente.');
      D.bloqueos = D.bloqueos.filter(x => x.id !== a.id);
      M.auditar(`Quitó bloqueo ${b.fecha} ${b.motivo}`); M.procesarListaEspera(b.fecha); return {};
    }
    case 'espera_quitar': {
      const e = M.getEspera(a.id); e.estado = 'cancelada';
      M.auditar('Quitó de espera a ' + e.cliente.nombre); M.procesarListaEspera(e.fecha); return {};
    }
    case 'servicio_crear': {
      const nombre = texto(a.nombre, 40).trim(); if (!nombre) throw new Error('Falta el nombre.');
      const precio = Number(a.precio), duracion = Number(a.duracion);
      if (!(precio >= 0) || !(duracion >= 5)) throw new Error('Precio o duración inválidos.');
      let id = nombre.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'svc';
      if (D.servicios.some(s => s.id === id)) id += '-' + Math.random().toString(36).slice(2, 6);
      D.servicios.push({ id, nombre, precio, duracion, activo: true });
      M.auditar('Creó servicio ' + nombre); return {};
    }
    case 'servicio_editar': {
      const s = D.servicios.find(x => x.id === a.id); if (!s) throw new Error('Servicio inexistente.');
      const precio = Number(a.precio), duracion = Number(a.duracion);
      if (!(precio >= 0) || !(duracion >= 5)) throw new Error('Precio o duración inválidos.');
      Object.assign(s, { nombre: texto(a.nombre, 40).trim() || s.nombre, precio, duracion });
      M.auditar('Editó servicio ' + s.nombre); return {};
    }
    case 'servicio_toggle': {
      const s = D.servicios.find(x => x.id === a.id); if (!s) throw new Error('Servicio inexistente.');
      s.activo = !s.activo; M.auditar(`${s.activo ? 'Activó' : 'Desactivó'} servicio ${s.nombre}`); return {};
    }
    case 'staff_guardar': {
      const x = a.staff || {};
      const datos = { nombre: texto(x.nombre, 40).trim(), dias: (x.dias || []).map(Number).filter(d => d >= 0 && d <= 6),
        desde: texto(x.desde, 5), hasta: texto(x.hasta, 5), servicios: (x.servicios || []).map(String), activo: !!x.activo };
      if (!datos.nombre) throw new Error('Falta el nombre.');
      if (!(M.toMin(datos.desde) < M.toMin(datos.hasta))) throw new Error('El horario de inicio debe ser anterior al de fin.');
      if (!datos.servicios.length) throw new Error('Elegí al menos un servicio.');
      let st;
      if (x.id) { st = D.staff.find(s => s.id === x.id); if (!st) throw new Error('Profesional inexistente.'); Object.assign(st, datos); }
      else { st = { id: 's' + Math.random().toString(36).slice(2, 10), ...datos }; D.staff.push(st); }
      const hoy = M.fechaStr(M.ahora());
      const fuera = D.turnos.filter(t => t.estado === 'confirmada' && t.staffId === st.id && t.fecha >= hoy &&
        (!st.activo || !st.dias.includes(M.diaSemana(t.fecha)) || t.inicio < M.toMin(st.desde) || t.fin > M.toMin(st.hasta)));
      M.auditar((x.id ? 'Editó' : 'Creó') + ' profesional ' + st.nombre);
      return { fuera: fuera.map(t => t.codigo) };
    }
    case 'cupon_crear': {
      const codigo = texto(a.codigo, 30).trim().toUpperCase(); const pct = Number(a.pct);
      if (!codigo) throw new Error('Falta el código.');
      if (!(pct >= 1 && pct <= 100)) throw new Error('Porcentaje inválido.');
      if (D.cupones.some(c => c.codigo === codigo)) throw new Error('Ya existe ese código.');
      const dias = (a.dias || []).map(Number);
      D.cupones.push({ codigo, pct, activo: true, dias: dias.length ? dias : null, usosMax: a.usosMax ? Number(a.usosMax) : null, usos: 0 });
      M.auditar('Creó cupón ' + codigo); return {};
    }
    case 'cupon_toggle': { const c = D.cupones.find(x => x.codigo === a.codigo); if (c) c.activo = !c.activo; return {}; }
    case 'cupon_borrar': { D.cupones = D.cupones.filter(x => x.codigo !== a.codigo); M.auditar('Borró cupón ' + a.codigo); return {}; }
    case 'cliente_toggle': {
      const tel = M.normTel(a.tel), ec = M.estadoCliente(tel);
      D.clientes[tel] = ec.bloqueado ? 'permitido' : 'bloqueado';
      M.auditar(`${ec.bloqueado ? 'Desbloqueó' : 'Bloqueó'} al cliente ${tel}`); return {};
    }
    case 'config': {
      const c = { ...D.config }, n = a.config || {};
      const numeros = ['paso', 'buffer', 'anticipacionMinMin', 'maxDiasAdelanto', 'horasCancelacion', 'horasRecordatorio', 'horasRecordatorio2', 'minutosOferta', 'maxAusencias'];
      for (const k of ['apertura', 'cierre', 'almuerzoDesde', 'almuerzoHasta']) if (k in n) c[k] = texto(n[k], 5);
      for (const k of numeros) if (k in n) c[k] = Math.max(0, Number(n[k]) || 0);
      if ('autoCompletar' in n) c.autoCompletar = !!n.autoCompletar;
      if (Array.isArray(n.diasLaborales)) c.diasLaborales = n.diasLaborales.map(Number).filter(d => d >= 0 && d <= 6);
      if (n.pin) { const p = texto(n.pin, 40).trim(); if (p.length < 6) throw new Error('El PIN nuevo debe tener al menos 6 caracteres.'); c.pin = p; }
      if (!(M.toMin(c.apertura) < M.toMin(c.cierre))) throw new Error('La apertura debe ser antes del cierre.');
      if ((c.almuerzoDesde && !c.almuerzoHasta) || (c.almuerzoDesde && M.toMin(c.almuerzoDesde) >= M.toMin(c.almuerzoHasta))) throw new Error('Revisá el horario de almuerzo.');
      if (c.paso < 5) throw new Error('El intervalo mínimo es 5 minutos.');
      D.config = c;
      const hoy = M.fechaStr(M.ahora());
      const fuera = D.turnos.filter(t => t.estado === 'confirmada' && t.fecha >= hoy &&
        (!c.diasLaborales.includes(M.diaSemana(t.fecha)) || t.inicio < M.toMin(c.apertura) || t.fin > M.toMin(c.cierre)));
      M.auditar('Cambió la configuración' + (n.pin ? ' (incluido el PIN)' : ''));
      return { fuera: fuera.map(t => t.codigo), pinCambiado: !!n.pin };
    }
    case 'reloj': {
      if (a.reset) D.config.relojOffsetMs = 0;
      else if (a.irA) {
        const objetivo = Date.parse(texto(a.irA, 16) + ':00Z');   // "YYYY-MM-DDTHH:MM" en hora de la peluquería
        if (!Number.isFinite(objetivo)) throw new Error('Fecha inválida.');
        D.config.relojOffsetMs = objetivo - M.relojDePared(Date.now(), D.config.zonaHoraria || M.ZONA_DEFECTO);
      } else D.config.relojOffsetMs = (D.config.relojOffsetMs || 0) + Number(a.sumarMs || 0);
      M.auditar('Movió el reloj simulado'); M.tick(); return {};
    }
    case 'demo': return M.generarDemo();
    case 'notif_limpiar': D.notificaciones = []; return {};
    case 'importar': {
      const d = a.datos;
      if (!d || !Array.isArray(d.turnos) || !Array.isArray(d.staff) || !d.config) throw new Error('El archivo no es un respaldo válido.');
      const pin = D.config.pin, seguridad = D.seguridad;
      globalThis.DB = M.migrar(d);
      globalThis.DB.config.pin = pin; globalThis.DB.seguridad = seguridad;  // el respaldo nunca cambia el PIN
      M.auditar('Restauró un respaldo'); return {};
    }
    case 'reset': {
      const pin = D.config.pin;
      globalThis.DB = M.seed(); globalThis.DB.config.pin = pin;
      M.auditar('Reinició todos los datos'); return {};
    }
    default: throw new Error('Operación desconocida.');
  }
}

// ---------- Punto de entrada ----------
function manejar(estado, accion, p) {
  const M = globalThis.Motor;
  p = p && typeof p === 'object' ? p : {};
  globalThis.DB = M.migrar(estado);
  globalThis.__notifsReq = [];
  M.tick();                                     // scheduler "perezoso": corre con cada visita
  const esAdmin = accion === 'admin';
  let respuesta;
  try { if (esAdmin) verificarPin(p.pin); }
  catch (e) { return { db: globalThis.DB, respuesta: { ok: false, error: e.message } }; }

  const respaldo = JSON.stringify(globalThis.DB);  // para deshacer si la acción falla a mitad de camino
  const notifsAntes = globalThis.__notifsReq.length;
  let telCliente = null;
  try {
    let data = null;
    switch (accion) {
      case 'estado': break;
      case 'reservar': {
        const d = limpiarDatos(p.datos); telCliente = M.normTel(d.telefono);
        data = { turno: turnoCliente(M.crearTurno(d, { origen: 'web' })) }; break;
      }
      case 'reprogramar': {
        const t = turnoDelCliente(p.id, p.codigo, p.tel); telCliente = t.cliente.telefono;
        data = { turno: turnoCliente(M.reprogramarTurno(t.id, limpiarDatos(p.datos), 'cliente')) }; break;
      }
      case 'cancelar': {
        const t = turnoDelCliente(p.id, p.codigo, p.tel); telCliente = t.cliente.telefono;
        M.cancelarTurno(t.id, 'cliente', texto(p.motivo, 200)); break;
      }
      case 'verificar_turno': {   // antes de reprogramar: confirma código + teléfono
        const t = turnoDelCliente(p.id, p.codigo, p.tel); M.verificarPolitica(t, 'reprogramar');
        data = { turno: turnoCliente(t) }; break;
      }
      case 'mis_turnos': {
        const tel = M.normTel(p.tel); if (tel.length < 8) throw new Error('Teléfono inválido.');
        const ec = M.estadoCliente(tel);
        data = { turnos: ec.turnos.map(turnoCliente), ausencias: ec.ausencias, bloqueado: ec.bloqueado }; break;
      }
      case 'espera_alta': {
        const d = limpiarDatos(p.datos); telCliente = M.normTel(d.telefono);
        data = { espera: esperaCliente(M.anotarEnEspera(d)) }; break;
      }
      case 'mi_espera': {
        const tel = M.normTel(p.tel); if (tel.length < 8) throw new Error('Teléfono inválido.');
        data = { espera: globalThis.DB.espera.filter(e => e.cliente.telefono === tel).map(esperaCliente) }; break;
      }
      case 'espera_aceptar': telCliente = M.normTel(p.tel); data = { turno: turnoCliente(M.aceptarOferta(p.id, p.tel)) }; break;
      case 'espera_rechazar': telCliente = M.normTel(p.tel); M.rechazarOferta(p.id, p.tel); break;
      case 'cupon': {
        const c = globalThis.DB.cupones.find(x => x.codigo === texto(p.codigo, 30).trim().toUpperCase() && x.activo && !(x.usosMax && x.usos >= x.usosMax));
        data = { cupon: c ? { codigo: c.codigo, pct: c.pct, dias: c.dias, activo: true, usosMax: null, usos: 0 } : null }; break;
      }
      case 'admin': data = accionAdmin(String(p.op || ''), p.args || {}); break;
      default: throw new Error('Acción desconocida.');
    }
    const nuevas = globalThis.__notifsReq.slice(notifsAntes);
    respuesta = { ok: true, data, estado: esAdmin ? snapshotAdmin() : snapshotPublico(),
      // El cliente solo ve las notificaciones dirigidas a él; el admin ve todas las de su acción
      notifs: nuevas.filter(n => esAdmin || (telCliente && n.tel === telCliente)).map(({ tipo, para, mensaje }) => ({ tipo, para: esAdmin ? para : '', mensaje })) };
  } catch (e) {
    globalThis.DB = JSON.parse(respaldo);
    respuesta = { ok: false, error: e && e.message ? e.message : 'Error inesperado.', estado: esAdmin ? snapshotAdmin() : snapshotPublico() };
  }
  globalThis.__notifsReq = null;
  return { db: globalThis.DB, respuesta };
}

globalThis.API = { manejar, estadoInicial };
