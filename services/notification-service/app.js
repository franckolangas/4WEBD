const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const amqp = require('amqplib');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan('combined'));

const port = process.env.PORT || 3000;
const rabbitUrl = process.env.RABBITMQ_URL || 'amqp://rabbitmq:5672';
const queueName = process.env.NOTIFICATION_QUEUE || 'notification_queue';

const sent = [];

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'notification-service' }));

app.get('/api/v1/notifications', (_req, res) => {
  return res.json(sent.slice(-100));
});

app.post('/api/v1/notifications/simulate/send', (req, res) => {
  const { channel = 'email', to, templateKey, locale = 'fr', payload = {} } = req.body;
  const item = {
    notificationId: uuidv4(),
    channel,
    to,
    templateKey,
    locale,
    payload,
    sentAt: new Date().toISOString()
  };
  sent.push(item);
  return res.status(202).json(item);
});

async function consumeQueue() {
  try {
    const connection = await amqp.connect(rabbitUrl);
    const channel = await connection.createChannel();
    await channel.assertQueue(queueName, { durable: true });

    channel.consume(queueName, (message) => {
      if (!message) return;
      try {
        const payload = JSON.parse(message.content.toString());
        sent.push({
          notificationId: uuidv4(),
          channel: payload.channel || 'email',
          to: payload.to,
          templateKey: payload.templateKey || 'purchase-confirmation',
          locale: payload.locale || 'fr',
          payload,
          sentAt: new Date().toISOString()
        });
        channel.ack(message);
      } catch (_error) {
        channel.nack(message, false, false);
      }
    });

    console.log('notification-service consumer connected');
  } catch (error) {
    console.error('notification-service queue connection error', error.message);
    setTimeout(consumeQueue, 4000);
  }
}

consumeQueue();

app.listen(port, () => {
  console.log(`notification-service listening on ${port}`);
});
