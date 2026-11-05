// =====================================================================
// PELUQUERÍA CARRANZA — Edge Function "turnos" (Supabase / Deno)
// Único punto de entrada de la web. Lee el estado de la tabla app_estado,
// ejecuta la acción con el motor (api.js + motor.js) y guarda con control
// de versión optimista: si otra persona guardó en el medio, se reintenta,
// así dos clientes NUNCA pueden quedarse con el mismo horario.
// La tabla tiene RLS sin políticas: solo esta función (service role) la toca.
// =====================================================================
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import './motor.js';
import './api.js';

// deno-lint-ignore no-explicit-any
const API = (globalThis as any).API;

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });

const MAX_BODY = 3_000_000; // 3 MB (alcanza para restaurar un respaldo grande)

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, error: 'Método no permitido' }, 405);

  const raw = await req.text();
  if (raw.length > MAX_BODY) return json({ ok: false, error: 'Pedido demasiado grande' }, 413);
  let body: { accion?: string; payload?: unknown };
  try { body = JSON.parse(raw); } catch { return json({ ok: false, error: 'JSON inválido' }, 400); }
  const accion = String(body.accion || '');

  try {
    for (let intento = 0; intento < 5; intento++) {
      const { data: fila, error } = await supabase.from('app_estado').select('data, version').eq('id', 1).maybeSingle();
      if (error) throw error;

      if (!fila) { // primer arranque: se crea el estado inicial con el PIN del secreto ADMIN_PIN
        const { error: e } = await supabase.from('app_estado')
          .insert({ id: 1, data: API.estadoInicial(Deno.env.get('ADMIN_PIN')), version: 0 });
        if (e && e.code !== '23505') throw e; // 23505 = otro pedido lo creó primero
        continue;
      }

      const original = JSON.stringify(fila.data);
      const { db, respuesta } = API.manejar(fila.data, accion, body.payload);
      const nuevo = JSON.stringify(db);

      if (nuevo !== original) {
        const { data: ok, error: e } = await supabase.from('app_estado')
          .update({ data: db, version: fila.version + 1, updated_at: new Date().toISOString() })
          .eq('id', 1).eq('version', fila.version).select('version');
        if (e) throw e;
        if (!ok || ok.length === 0) { // alguien guardó antes: recalcular con el estado nuevo
          await new Promise((r) => setTimeout(r, 40 + Math.random() * 120));
          continue;
        }
      }
      return json(respuesta);
    }
    return json({ ok: false, error: 'Hay mucha actividad en este momento. Probá de nuevo.' }, 409);
  } catch (err) {
    console.error('turnos:', err);
    return json({ ok: false, error: 'Error del servidor. Probá de nuevo en unos segundos.' }, 500);
  }
});
