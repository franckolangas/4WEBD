const express = require('express');
const morgan = require('morgan');
const path = require('path');
const swaggerUi = require('swagger-ui-express');

const app = express();
app.use(morgan('combined'));

const port = process.env.PORT || 3000;
const specsDir = path.join(__dirname, 'openapi');

const docs = [
  { name: 'Auth Service', url: '/openapi/auth-service.openapi.yaml' },
  { name: 'User Service', url: '/openapi/user-service.openapi.yaml' },
  { name: 'Event Service', url: '/openapi/event-service.openapi.yaml' },
  { name: 'Inventory Service', url: '/openapi/inventory-service.openapi.yaml' },
  { name: 'Order Service', url: '/openapi/order-service.openapi.yaml' },
  { name: 'Payment Service', url: '/openapi/payment-service.openapi.yaml' },
  { name: 'Notification Service', url: '/openapi/notification-service.openapi.yaml' }
];

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'docs-service' });
});

app.use('/openapi', express.static(specsDir));
app.get('/openapi', (_req, res) => {
  res.json({
    specs: docs,
    message: 'Consultez /docs pour l interface Swagger UI.'
  });
});

app.get('/openapi/', (_req, res) => {
  res.json({
    specs: docs,
    message: 'Consultez /docs pour l interface Swagger UI.'
  });
});

const swaggerOptions = {
  explorer: true,
  swaggerOptions: {
    urls: docs,
    urlsPrimaryName: 'Auth Service',
    docExpansion: 'none'
  }
};

app.use('/docs', swaggerUi.serveFiles(null, swaggerOptions), swaggerUi.setup(null, swaggerOptions));

app.listen(port, () => {
  console.log(`docs-service listening on ${port}`);
});
