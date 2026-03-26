const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const amqp = require('amqplib');

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan('combined'));

const port = process.env.PORT || 3000;
const jwtSecret = process.env.JWT_SECRET || 'dev-secret';
const paymentServiceUrl = process.env.PAYMENT_SERVICE_URL || 'http://payment-service:3000';
const inventoryServiceUrl = process.env.INVENTORY_SERVICE_URL || 'http://inventory-service:3000';
const rabbitUrl = process.env.RABBITMQ_URL || 'amqp://rabbitmq:5672';
const queueName = process.env.NOTIFICATION_QUEUE || 'notification_queue';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://ticket:ticket@postgres:5432/ticketing'
});

let mqChannel;

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Token manquant.' });

  try {
    req.user = jwt.verify(token, jwtSecret);
    return next();
  } catch (_error) {
    return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Token invalide.' });
  }
}

async function connectMq() {
  try {
    const connection = await amqp.connect(rabbitUrl);
    mqChannel = await connection.createChannel();
    await mqChannel.assertQueue(queueName, { durable: true });
  } catch (error) {
    console.error('order-service MQ error', error.message);
    setTimeout(connectMq, 4000);
  }
}

async function publishNotification(payload) {
  if (!mqChannel) return;
  mqChannel.sendToQueue(queueName, Buffer.from(JSON.stringify(payload)), { persistent: true });
}

function serviceToken() {
  return jwt.sign({ sub: 'order-service', role: 'ADMIN' }, jwtSecret, { expiresIn: 300 });
}

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'order-service' }));

app.post('/api/v1/orders', auth, async (req, res) => {
  const { reservationId, userId, eventId, amountCents, currency = 'EUR' } = req.body;
  const idempotencyKey = req.headers['idempotency-key'];

  if (!reservationId || !userId || !eventId || amountCents == null || !idempotencyKey) {
    return res.status(422).json({ code: 'VALIDATION_ERROR', message: 'Donnees invalides.' });
  }

  if (req.user.role !== 'ADMIN' && req.user.sub !== userId) {
    return res.status(403).json({ code: 'FORBIDDEN', message: 'Acces refuse.' });
  }

  const reservationRes = await fetch(`${inventoryServiceUrl}/api/v1/inventory/reservations/${reservationId}`, {
    headers: {
      Authorization: `Bearer ${serviceToken()}`
    }
  });

  if (!reservationRes.ok) {
    return res.status(409).json({ code: 'INVALID_RESERVATION', message: 'Reservation introuvable.' });
  }

  const reservation = await reservationRes.json();
  if (reservation.status !== 'PENDING' && reservation.status !== 'CONFIRMED') {
    return res.status(409).json({ code: 'INVALID_RESERVATION', message: 'Reservation non valide.' });
  }

  const existing = await pool.query('SELECT * FROM orders WHERE reservation_id = $1', [reservationId]);
  if (existing.rowCount > 0) {
    return res.status(200).json({
      orderId: existing.rows[0].id,
      reservationId: existing.rows[0].reservation_id,
      userId: existing.rows[0].user_id,
      eventId: existing.rows[0].event_id,
      status: existing.rows[0].status,
      amountCents: existing.rows[0].total_amount_cents,
      currency: existing.rows[0].currency
    });
  }

  const orderId = uuidv4();
  const insert = await pool.query(
    `INSERT INTO orders (id, user_id, event_id, reservation_id, total_amount_cents, currency, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'PENDING')
     RETURNING *`,
    [orderId, userId, eventId, reservationId, amountCents, currency]
  );

  const row = insert.rows[0];
  return res.status(201).json({
    orderId: row.id,
    reservationId: row.reservation_id,
    userId: row.user_id,
    eventId: row.event_id,
    status: row.status,
    amountCents: row.total_amount_cents,
    currency: row.currency
  });
});

app.get('/api/v1/orders/:orderId', auth, async (req, res) => {
  const result = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.orderId]);
  if (result.rowCount === 0) return res.status(404).json({ code: 'NOT_FOUND', message: 'Commande introuvable.' });

  const order = result.rows[0];
  if (req.user.role !== 'ADMIN' && req.user.sub !== order.user_id) {
    return res.status(403).json({ code: 'FORBIDDEN', message: 'Acces refuse.' });
  }

  return res.json({
    orderId: order.id,
    reservationId: order.reservation_id,
    userId: order.user_id,
    eventId: order.event_id,
    status: order.status,
    amountCents: order.total_amount_cents,
    currency: order.currency
  });
});

app.post('/api/v1/orders/:orderId/pay', auth, async (req, res) => {
  const { scenario = 'success' } = req.body;

  const orderResult = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.orderId]);
  if (orderResult.rowCount === 0) return res.status(404).json({ code: 'NOT_FOUND', message: 'Commande introuvable.' });

  const order = orderResult.rows[0];
  if (req.user.role !== 'ADMIN' && req.user.sub !== order.user_id) {
    return res.status(403).json({ code: 'FORBIDDEN', message: 'Acces refuse.' });
  }

  if (order.status !== 'PENDING') {
    return res.status(409).json({ code: 'INVALID_STATUS', message: 'Commande deja traitee.' });
  }

  const paymentRes = await fetch(`${paymentServiceUrl}/api/v1/payments/charge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      orderId: order.id,
      amountCents: order.total_amount_cents,
      currency: order.currency,
      scenario,
      idempotencyKey: req.headers['idempotency-key'] || undefined
    })
  });

  const paymentPayload = await paymentRes.json();

  let paymentStatus = 'AUTHORIZED';
  let orderStatus = 'PAID';
  if (paymentRes.status === 402) {
    paymentStatus = 'DECLINED';
    orderStatus = 'FAILED';
  }
  if (paymentRes.status === 504) {
    paymentStatus = 'TIMEOUT';
    orderStatus = 'EXPIRED';
  }

  const provider = paymentPayload.provider === 'STRIPE' ? 'STRIPE' : 'SIMULATED';

  await pool.query(
    `INSERT INTO payment_transactions (id, order_id, provider, amount_cents, currency, status, failure_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [uuidv4(), order.id, provider, order.total_amount_cents, order.currency, paymentStatus, paymentPayload.message || null]
  );

  if (orderStatus === 'PAID') {
    const confirmRes = await fetch(`${inventoryServiceUrl}/api/v1/inventory/reservations/${order.reservation_id}/confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${serviceToken()}`
      }
    });

    if (!confirmRes.ok) {
      await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['EXPIRED', order.id]);
      return res.status(410).json({ code: 'RESERVATION_EXPIRED', message: 'Reservation non confirmable apres paiement.' });
    }

    const reservationRes = await fetch(`${inventoryServiceUrl}/api/v1/inventory/reservations/${order.reservation_id}`, {
      headers: {
        Authorization: `Bearer ${serviceToken()}`
      }
    });

    if (!reservationRes.ok) {
      await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['EXPIRED', order.id]);
      return res.status(410).json({ code: 'RESERVATION_EXPIRED', message: 'Reservation introuvable apres confirmation.' });
    }

    const reservation = await reservationRes.json();
    const quantity = reservation.quantity;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE orders SET status = $1 WHERE id = $2', ['PAID', order.id]);

      for (let i = 0; i < quantity; i += 1) {
        await client.query(
          `INSERT INTO tickets (id, order_id, event_id, user_id, ticket_code, status)
           VALUES ($1, $2, $3, $4, $5, 'VALID')`,
          [uuidv4(), order.id, order.event_id, order.user_id, `TK-${uuidv4().slice(0, 8).toUpperCase()}`]
        );
      }

      await client.query(
        `INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload)
         VALUES ($1, 'ORDER', $2, 'PURCHASE_COMPLETED', $3::jsonb)`,
        [uuidv4(), order.id, JSON.stringify({ orderId: order.id, userId: order.user_id, eventId: order.event_id })]
      );

      await client.query('COMMIT');
    } catch (_error) {
      await client.query('ROLLBACK');
      return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erreur interne.' });
    } finally {
      client.release();
    }

    await publishNotification({
      channel: 'email',
      to: order.user_id,
      locale: 'fr',
      templateKey: 'purchase-confirmation',
      orderId: order.id,
      eventId: order.event_id
    });

    return res.json({ orderId: order.id, paymentStatus, orderStatus: 'PAID' });
  }

  await fetch(`${inventoryServiceUrl}/api/v1/inventory/reservations/${order.reservation_id}/release`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${serviceToken()}`
    }
  });

  await pool.query('UPDATE orders SET status = $1 WHERE id = $2', [orderStatus, order.id]);

  if (paymentStatus === 'DECLINED') {
    return res.status(402).json({ code: 'PAYMENT_DECLINED', message: 'Paiement refuse.', orderId: order.id, paymentStatus, orderStatus });
  }

  return res.status(504).json({ code: 'PAYMENT_TIMEOUT', message: 'Paiement en timeout.', orderId: order.id, paymentStatus, orderStatus });
});

app.get('/api/v1/tickets/my', auth, async (req, res) => {
  const result = await pool.query('SELECT * FROM tickets WHERE user_id = $1 ORDER BY issued_at DESC', [req.user.sub]);
  return res.json(result.rows.map((row) => ({
    ticketId: row.id,
    orderId: row.order_id,
    eventId: row.event_id,
    userId: row.user_id,
    ticketCode: row.ticket_code,
    status: row.status
  })));
});

app.get('/api/v1/tickets/:ticketId', auth, async (req, res) => {
  const result = await pool.query('SELECT * FROM tickets WHERE id = $1', [req.params.ticketId]);
  if (result.rowCount === 0) return res.status(404).json({ code: 'NOT_FOUND', message: 'Billet introuvable.' });

  const ticket = result.rows[0];
  if (req.user.role !== 'ADMIN' && req.user.sub !== ticket.user_id) {
    return res.status(403).json({ code: 'FORBIDDEN', message: 'Acces refuse.' });
  }

  return res.json({
    ticketId: ticket.id,
    orderId: ticket.order_id,
    eventId: ticket.event_id,
    userId: ticket.user_id,
    ticketCode: ticket.ticket_code,
    status: ticket.status
  });
});

connectMq();

app.listen(port, () => {
  console.log(`order-service listening on ${port}`);
});
