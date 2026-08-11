// ---------------------------------------------------------------------------
// Check Service — Backend de cobro con QR fijo de Mercado Pago
// ---------------------------------------------------------------------------
// Qué hace:
//  1) Cuando Check Service Suite pide "cobrar $X", este servidor le dice a
//     Mercado Pago que el QR fijo de tu caja vale $X (endpoint oficial de
//     "QR con monto dinámico" — el mismo cartel de siempre, monto que cambia).
//  2) Cuando el cliente paga, Mercado Pago le avisa a este servidor por el
//     webhook, y acá queda guardado el estado del cobro.
//  3) Check Service Suite pregunta cada 2-3 segundos "¿ya pagaron?" hasta
//     que este servidor le confirma que sí.
//
// El Access Token vive SOLO acá (en el .env), nunca en el HTML del navegador.
// ---------------------------------------------------------------------------

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const {
  MP_ACCESS_TOKEN,
  MP_EXTERNAL_POS_ID,
  MP_NOTIFICATION_URL,
  PORT = 4000
} = process.env;

if (!MP_ACCESS_TOKEN || !MP_EXTERNAL_POS_ID) {
  console.error('\n[ERROR] Faltan variables en tu archivo .env (MP_ACCESS_TOKEN y/o MP_EXTERNAL_POS_ID).');
  console.error('Copiá .env.example a .env y completalo antes de arrancar el servidor.\n');
  process.exit(1);
}

const app = express();
app.use(cors()); // Permite que Check Service Suite (abierto en el navegador) le hable a este servidor
app.use(express.json());

// Guardamos el estado de cada cobro en memoria: { referencia: { estado, monto, fecha, mpPaymentId } }
// Simple y suficiente para un solo mostrador. Si el servidor se reinicia,
// se pierde (los cobros ya en Caja siguen intactos en la base del navegador,
// esto es solo el "puente" temporal mientras se espera el pago).
const cobros = new Map();

let mpUserId = null; // se obtiene una sola vez al arrancar, con GET /users/me

async function obtenerUserId() {
  const resp = await fetch('https://api.mercadopago.com/users/me', {
    headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` }
  });
  if (!resp.ok) {
    throw new Error(`No se pudo obtener el user_id de Mercado Pago (HTTP ${resp.status}). Revisá que el Access Token sea correcto y de producción.`);
  }
  const data = await resp.json();
  return data.id;
}

// -----------------------------------------------------------------------
// POST /api/mp/cobrar
// Body: { monto: number, referencia: string, descripcion?: string }
// Le asigna el monto al QR fijo de tu caja.
// -----------------------------------------------------------------------
app.post('/api/mp/cobrar', async (req, res) => {
  try {
    const { monto, referencia, descripcion } = req.body || {};
    if (!monto || monto <= 0) return res.status(400).json({ error: 'Falta un monto válido.' });
    if (!referencia) return res.status(400).json({ error: 'Falta la referencia del cobro.' });

    const url = `https://api.mercadopago.com/instore/orders/qr/seller/collectors/${mpUserId}/pos/${encodeURIComponent(MP_EXTERNAL_POS_ID)}/qrs`;
    const body = {
      external_reference: referencia,
      title: 'Check Service',
      description: descripcion || 'Cobro Check Service',
      notification_url: `${MP_NOTIFICATION_URL}`,
      total_amount: Number(monto),
      items: [
        {
          sku_number: referencia,
          category: 'services',
          title: descripcion || 'Servicio',
          description: descripcion || 'Servicio',
          unit_price: Number(monto),
          quantity: 1,
          unit_measure: 'unit',
          total_amount: Number(monto)
        }
      ]
    };

    const resp = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${MP_ACCESS_TOKEN}`
      },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const textoError = await resp.text();
      console.error('Error de Mercado Pago al asociar el monto al QR:', resp.status, textoError);
      return res.status(502).json({ error: 'Mercado Pago rechazó la solicitud.', detalle: textoError });
    }

    cobros.set(referencia, { estado: 'pendiente', monto: Number(monto), fecha: new Date().toISOString() });
    res.json({ ok: true, referencia, estado: 'pendiente' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno al generar el cobro.' });
  }
});

// -----------------------------------------------------------------------
// GET /api/mp/estado/:referencia
// Tu app hace polling acá hasta que el estado pase a "pagado".
// -----------------------------------------------------------------------
app.get('/api/mp/estado/:referencia', (req, res) => {
  const cobro = cobros.get(req.params.referencia);
  if (!cobro) return res.status(404).json({ error: 'No se encontró ese cobro.' });
  res.json(cobro);
});

// -----------------------------------------------------------------------
// POST /api/mp/webhook
// Mercado Pago llama acá solo cuando cambia el estado de un pago.
// -----------------------------------------------------------------------
app.post('/api/mp/webhook', async (req, res) => {
  // Respondemos 200 inmediatamente: Mercado Pago solo necesita saber que
  // recibimos el aviso, el resto lo procesamos después.
  res.sendStatus(200);

  try {
    const { topic, type, data } = req.body || {};
    const esNotificacionDePago = topic === 'payment' || type === 'payment';
    if (!esNotificacionDePago || !data || !data.id) return;

    const resp = await fetch(`https://api.mercadopago.com/v1/payments/${data.id}`, {
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` }
    });
    if (!resp.ok) return;
    const pago = await resp.json();

    const referencia = pago.external_reference;
    if (!referencia) return;

    if (pago.status === 'approved') {
      cobros.set(referencia, {
        estado: 'pagado',
        monto: pago.transaction_amount,
        fecha: new Date().toISOString(),
        mpPaymentId: pago.id,
        medioPago: pago.payment_type_id
      });
      console.log(`✅ Cobro confirmado — referencia ${referencia} — $${pago.transaction_amount}`);
    } else if (['rejected', 'cancelled'].includes(pago.status)) {
      cobros.set(referencia, { estado: 'rechazado', fecha: new Date().toISOString() });
    }
  } catch (err) {
    console.error('Error procesando webhook:', err);
  }
});

// -----------------------------------------------------------------------
// GET /api/mp/debug/pos
// Diagnóstico: lista tus cajas reales en Mercado Pago, con su external_id
// verdadero (el que hay que cargar en MP_EXTERNAL_POS_ID). Visitá esta URL
// desde el navegador para verlo.
// -----------------------------------------------------------------------
app.get('/api/mp/debug/pos', async (_req, res) => {
  try {
    const resp = await fetch('https://api.mercadopago.com/pos', {
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` }
    });
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'No se pudo consultar Mercado Pago.', detalle: err.message });
  }
});

// -----------------------------------------------------------------------
// GET /api/mp/debug/fijar-external-id
// Uso único: le asigna un external_id de texto a tu caja "QR #1" (id
// interno 132981842), porque las cajas creadas desde el panel no traen
// uno por defecto. Después de ejecutar esto UNA vez, se puede borrar.
// -----------------------------------------------------------------------
app.get('/api/mp/debug/fijar-external-id', async (_req, res) => {
  try {
    const resp = await fetch('https://api.mercadopago.com/pos/132981842', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${MP_ACCESS_TOKEN}`
      },
      body: JSON.stringify({ external_id: 'checkservicemostrador' })
    });
    const data = await resp.json();
    res.json({ status: resp.status, data });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo actualizar la caja.', detalle: err.message });
  }
});

// -----------------------------------------------------------------------
// POST /api/mp/cancelar
// Body: { referencia: string }
// Le avisa a Mercado Pago que borre el monto pendiente del QR fijo, para
// que si alguien lo escanea después no le siga apareciendo el monto viejo.
// -----------------------------------------------------------------------
app.post('/api/mp/cancelar', async (req, res) => {
  try {
    const { referencia } = req.body || {};
    const url = `https://api.mercadopago.com/instore/qr/seller/collectors/${mpUserId}/pos/${encodeURIComponent(MP_EXTERNAL_POS_ID)}/orders`;
    const resp = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` }
    });
    // 204 = se borró bien. 404 puede pasar si ya no había nada pendiente
    // (por ejemplo, si el cliente ya había pagado justo antes de cancelar)
    // — no lo tratamos como error real.
    if(referencia) cobros.delete(referencia);
    res.json({ ok: resp.status === 204 || resp.status === 404, status: resp.status });
  } catch (err) {
    console.error('Error al cancelar el cobro QR:', err);
    res.status(500).json({ error: 'No se pudo cancelar en Mercado Pago.' });
  }
});

// -----------------------------------------------------------------------
app.get('/', (_req, res) => res.send('Check Service — backend de Mercado Pago funcionando.'));

(async () => {
  try {
    mpUserId = await obtenerUserId();
    app.listen(PORT, () => {
      console.log(`\n✅ Backend de Mercado Pago corriendo en http://localhost:${PORT}`);
      console.log(`   user_id detectado: ${mpUserId}`);
      console.log(`   caja (external_pos_id): ${MP_EXTERNAL_POS_ID}\n`);
    });
  } catch (err) {
    console.error('\n[ERROR al iniciar]', err.message, '\n');
    process.exit(1);
  }
})();
