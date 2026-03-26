const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const Stripe = require('stripe');

dotenv.config();

const app = express();
app.use(cors());
app.use(morgan('combined'));

const port = process.env.PORT || 3000;
const paymentProvider = (process.env.PAYMENT_PROVIDER || 'SIMULATED').toUpperCase();
const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
const stripeEnabled = paymentProvider === 'STRIPE' && Boolean(stripeSecretKey);
const stripe = stripeEnabled ? new Stripe(stripeSecretKey) : null;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://ticket:ticket@postgres:5432/paymentdb'
});

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'payment-service' }));

app.get('/api/v1/payments/webhook', (_req, res) => {
  return res.status(405).json({
    code: 'METHOD_NOT_ALLOWED',
    message: 'Utilisez POST pour le webhook Stripe (pas GET).'
  });
});

app.post('/api/v1/payments/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripeEnabled || !stripeWebhookSecret) {
    return res.status(503).json({ code: 'WEBHOOK_DISABLED', message: 'Webhook Stripe desactive.' });
  }

  const signature = req.headers['stripe-signature'];
  if (!signature) {
    return res.status(400).json({ code: 'MISSING_SIGNATURE', message: 'Signature Stripe manquante.' });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, stripeWebhookSecret);
  } catch (error) {
    return res.status(400).json({ code: 'INVALID_SIGNATURE', message: error.message });
  }

  const persistAudit = async (status, intent, scenario) => {
    const orderId = intent?.metadata?.orderId || null;
    if (!orderId) return;
    await pool.query(
      'INSERT INTO payment_audit (id, order_id, amount_cents, currency, scenario, status) VALUES ($1, $2, $3, $4, $5, $6)',
      [uuidv4(), orderId, intent.amount || 0, String(intent.currency || 'eur').toUpperCase(), scenario, status]
    );
  };

  try {
    if (event.type === 'payment_intent.succeeded') {
      await persistAudit('AUTHORIZED', event.data.object, 'webhook.succeeded');
    }
    if (event.type === 'payment_intent.payment_failed') {
      await persistAudit('DECLINED', event.data.object, 'webhook.failed');
    }
  } catch (error) {
    return res.status(500).json({ code: 'WEBHOOK_PERSIST_ERROR', message: error.message });
  }

  return res.json({ received: true });
});

app.use(express.json());

async function processSimulatedCharge(req, res) {
  const { orderId, amountCents, currency, scenario = 'success' } = req.body;
  if (!orderId || amountCents == null || !currency) {
    return res.status(422).json({ code: 'VALIDATION_ERROR', message: 'orderId, amountCents et currency sont requis.' });
  }

  const paymentId = uuidv4();

  const persistAudit = async (status) => {
    await pool.query(
      'INSERT INTO payment_audit (id, order_id, amount_cents, currency, scenario, status) VALUES ($1, $2, $3, $4, $5, $6)',
      [paymentId, orderId, amountCents, currency, scenario, status]
    );
  };

  if (scenario === 'declined') {
    persistAudit('DECLINED').catch(() => {});
    return res.status(402).json({ paymentId, status: 'DECLINED', provider: 'SIMULATED', message: 'Paiement refuse (simulation).' });
  }

  if (scenario === 'timeout') {
    persistAudit('TIMEOUT').catch(() => {});
    return res.status(504).json({ paymentId, status: 'TIMEOUT', provider: 'SIMULATED', message: 'Timeout paiement (simulation).' });
  }

  persistAudit('AUTHORIZED').catch(() => {});
  return res.json({ paymentId, status: 'AUTHORIZED', provider: 'SIMULATED', message: 'Paiement autorise (simulation).' });
}

app.post('/api/v1/payments/simulate/charge', (req, res) => processSimulatedCharge(req, res));

app.post('/api/v1/payments/charge', async (req, res) => {
  if (!stripeEnabled) {
    return processSimulatedCharge(req, res);
  }

  const { orderId, amountCents, currency, scenario = 'success', idempotencyKey } = req.body;
  if (!orderId || amountCents == null || !currency) {
    return res.status(422).json({ code: 'VALIDATION_ERROR', message: 'orderId, amountCents et currency sont requis.' });
  }

  if (scenario === 'timeout') {
    const paymentId = uuidv4();
    await pool.query(
      'INSERT INTO payment_audit (id, order_id, amount_cents, currency, scenario, status) VALUES ($1, $2, $3, $4, $5, $6)',
      [paymentId, orderId, amountCents, String(currency).toUpperCase(), 'timeout', 'TIMEOUT']
    );
    return res.status(504).json({
      paymentId,
      status: 'TIMEOUT',
      provider: 'STRIPE',
      message: 'Timeout paiement (simulation controlee en mode Stripe).'
    });
  }

  const paymentMethod = scenario === 'declined' ? 'pm_card_chargeDeclined' : 'pm_card_visa';

  try {
    const intent = await stripe.paymentIntents.create(
      {
        amount: amountCents,
        currency: String(currency).toLowerCase(),
        payment_method_types: ['card'],
        payment_method: paymentMethod,
        confirm: true,
        automatic_payment_methods: { enabled: false },
        metadata: { orderId }
      },
      idempotencyKey ? { idempotencyKey } : undefined
    );

    if (intent.status === 'succeeded') {
      await pool.query(
        'INSERT INTO payment_audit (id, order_id, amount_cents, currency, scenario, status) VALUES ($1, $2, $3, $4, $5, $6)',
        [uuidv4(), orderId, amountCents, String(currency).toUpperCase(), scenario, 'AUTHORIZED']
      );
      return res.json({
        paymentId: intent.id,
        paymentIntentId: intent.id,
        status: 'AUTHORIZED',
        provider: 'STRIPE',
        message: 'Paiement autorise via Stripe.'
      });
    }

    await pool.query(
      'INSERT INTO payment_audit (id, order_id, amount_cents, currency, scenario, status) VALUES ($1, $2, $3, $4, $5, $6)',
      [uuidv4(), orderId, amountCents, String(currency).toUpperCase(), scenario, 'DECLINED']
    );
    return res.status(402).json({
      paymentId: intent.id,
      paymentIntentId: intent.id,
      status: 'DECLINED',
      provider: 'STRIPE',
      message: 'Paiement refuse via Stripe.'
    });
  } catch (error) {
    const paymentId = uuidv4();
    await pool.query(
      'INSERT INTO payment_audit (id, order_id, amount_cents, currency, scenario, status) VALUES ($1, $2, $3, $4, $5, $6)',
      [paymentId, orderId, amountCents, String(currency).toUpperCase(), scenario, 'DECLINED']
    );
    return res.status(402).json({
      paymentId,
      status: 'DECLINED',
      provider: 'STRIPE',
      message: error.message || 'Paiement refuse via Stripe.'
    });
  }
});

app.listen(port, () => {
  console.log(`payment-service listening on ${port}`);
});
