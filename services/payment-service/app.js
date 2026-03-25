const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan('combined'));

const port = process.env.PORT || 3000;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://ticket:ticket@postgres:5432/paymentdb'
});

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'payment-service' }));

app.post('/api/v1/payments/simulate/charge', (req, res) => {
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
    return res.status(402).json({ paymentId, status: 'DECLINED', message: 'Paiement refuse (simulation).' });
  }

  if (scenario === 'timeout') {
    persistAudit('TIMEOUT').catch(() => {});
    return res.status(504).json({ paymentId, status: 'TIMEOUT', message: 'Timeout paiement (simulation).' });
  }

  persistAudit('AUTHORIZED').catch(() => {});
  return res.json({ paymentId, status: 'AUTHORIZED', message: 'Paiement autorise (simulation).' });
});

app.listen(port, () => {
  console.log(`payment-service listening on ${port}`);
});
