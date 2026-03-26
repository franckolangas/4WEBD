# Ticketing SaaS Microservices Project

Plateforme de billetterie en architecture microservices, concue pour un usage SaaS.

## Etat actuel du projet (25/03/2026)

- MVP fonctionnel valide en execution reelle.
- Flux principal d'achat valide de bout en bout.
- Anti-survente valide sous concurrence.

Resultats verifies:

- Full flow: SUCCESS (register -> login -> create event -> reserve -> order -> pay -> ticket).
- Anti-survente: 30 tentatives, 5 succes, 25 conflits, stock final 0, aucune survente.

## Microservices inclus

- auth-service: inscription, login, refresh, logout (JWT + hash mot de passe)
- user-service: CRUD utilisateurs + profil courant
- event-service: CRUD evenements
- inventory-service: reservations atomiques + anti-survente + expiration TTL
- order-service: commande, paiement simule, emission billets
- payment-service: simulation carte bancaire
- notification-service: envoi email/SMS simule asynchrone (RabbitMQ)
- docs-service: portail Swagger UI consolide
- gateway (Nginx): point d'entree unique et routage API

## Architecture et contrats

- Architecture logique: docs/architecture.md
- OpenAPI inventory: openapi/inventory-service.openapi.yaml
- OpenAPI order: openapi/order-service.openapi.yaml
- OpenAPI auth: openapi/auth-service.openapi.yaml
- OpenAPI user: openapi/user-service.openapi.yaml
- OpenAPI event: openapi/event-service.openapi.yaml
- OpenAPI payment: openapi/payment-service.openapi.yaml
- OpenAPI notification: openapi/notification-service.openapi.yaml
- Schema SQL: db/init/001_schema.sql

## Structure du repository

- docs/
- gateway/
- db/init/
- openapi/
- services/
- tests/integration/anti-oversell/
- tests/integration/full-flow/
- scripts/

## Prerequis

- Docker
- Docker Compose
- Node.js 20+
- k6 (optionnel, pour test de charge)

## Demarrage rapide

1. Copier la configuration locale:

```bash
cp .env.example .env
```

2. Lancer la plateforme:

```bash
./scripts/dev-up.sh
```

3. Verifier la gateway:

```bash
curl -s http://localhost:8080/health
```

4. Ouvrir Swagger UI:

```bash
open http://localhost:8080/docs
```

5. Arreter la plateforme:

```bash
./scripts/dev-down.sh
```

## Tests

### 1) Test bout en bout

```bash
node tests/integration/full-flow/run-full-flow.js
```

### 2) Test anti-survente (Node)

```bash
node tests/integration/anti-oversell/node-concurrency-check.js
```

### 3) Test de charge anti-survente (k6)

```bash
k6 run tests/integration/anti-oversell/k6-booking-spike.js
```

### 4) Validation formelle FR/EN + role OPERATOR

```bash
node tests/integration/i18n/run-locale-validation.js
```

## Endpoints principaux (via gateway)

- POST /api/v1/auth/register
- POST /api/v1/auth/login
- POST /api/v1/auth/refresh
- POST /api/v1/auth/logout
- GET /api/v1/users/me
- GET /api/v1/events
- POST /api/v1/events
- POST /api/v1/inventory/reservations
- POST /api/v1/orders
- POST /api/v1/orders/{orderId}/pay
- GET /api/v1/tickets/my

## Ports locaux

- gateway (serveur): 8080
- auth-service: 8081
- user-service: 8082
- event-service (catalog instance 1): 8083
- event-service-2 (catalog instance 2): 8093
- inventory-service (instance 1): 8084
- inventory-service-2 (instance 2): 8094
- order-service: 8085
- payment-service: 8086
- notification-service: 8087
- docs-service: 8088

PostgreSQL n'est pas expose sur un port hote: il est accessible uniquement depuis le reseau Docker interne.

## Scalabilite actuelle

- event-service: x2 (load balance par Nginx)
- inventory-service: x2 (load balance par Nginx)
- autres services: x1

## Schema rapide de l architecture

```text
Client
	|
	v
Nginx Gateway :8080
	|
	+-- /api/v1/auth ----------> auth-service :8081
	+-- /api/v1/users ---------> user-service :8082
	+-- /api/v1/events --------> event-service :8083
	|                            event-service-2 :8093
	+-- /api/v1/inventory -----> inventory-service :8084
	|                            inventory-service-2 :8094
	+-- /api/v1/orders --------> order-service :8085
	+-- /api/v1/payments ------> payment-service :8086
	+-- /api/v1/notifications -> notification-service :8087
	+-- /docs ------------------> docs-service :8088

order-service -> RabbitMQ :5672 -> notification-service
Tous les services metier -> PostgreSQL :5432
```

## Roles

- ADMIN
- EVENT_CREATOR
- OPERATOR
- USER

## Identifiants et creation d'utilisateurs

Il n'y a pas de credentials pre-definis. Tous les utilisateurs se creent via l'API.

### Creation simple (role USER par defaut)

```bash
curl -X POST http://localhost:8080/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -H "Accept-Language: fr" \
  -d '{
    "email": "user@example.com",
    "password": "Password123!",
    "fullName": "User Name",
    "locale": "fr"
  }'
```

### Creation avec role (ADMIN, EVENT_CREATOR, OPERATOR)

Ajouter le header `x-admin-bootstrap: bootstrap-admin` et le champ `role`:

```bash
curl -X POST http://localhost:8080/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -H "x-admin-bootstrap: bootstrap-admin" \
  -d '{
    "email": "admin@test.local",
    "password": "Password123!",
    "fullName": "Admin User",
    "role": "ADMIN"
  }'
```
### Connexion

```bash
curl -X POST http://localhost:8080/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@test.local",
    "password": "Password123!"
  }'
```

Retour: `accessToken` a utiliser dans `Authorization: Bearer <token>`

## Backup base paiement

- Backup periodique automatique via le service `payment-db-backup` dans Docker Compose.
- Intervalle configurable avec `PAYMENT_BACKUP_INTERVAL_MIN`.
- Fichiers de backup ecrits dans `backups/payment/`.
- Les donnees PostgreSQL sont persistees localement dans le volume Docker `pgdata`.

Commandes utiles:

```bash
# backup manuel
./scripts/backup-payment-db.sh

# restauration depuis un dump
./scripts/restore-payment-db.sh backups/payment/paymentdb_YYYYMMDD_HHMMSS.dump

# migration role OPERATOR pour une base deja initialisee
./scripts/migrate-add-operator-role.sh
```

## Stripe (optionnel)

Par defaut, le `payment-service` fonctionne en mode `SIMULATED`.

Pour activer Stripe (mode test):

```bash
PAYMENT_PROVIDER=STRIPE
STRIPE_SECRET_KEY=sk_test_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
```

Endpoints utiles:

- `POST /api/v1/payments/charge`
- `POST /api/v1/payments/webhook`

## Securite (version actuelle)

- Mot de passe stocke sous forme hachee (bcryptjs dans cette version)
- JWT signe pour authentification et autorisation
- Controle RBAC sur les routes sensibles
- Aucune donnee bancaire reelle stockee (paiement simule)

## CI

Workflow: .github/workflows/ci.yml

Verifications executees en CI:

- validation de la syntaxe Docker Compose
- presence des specs OpenAPI principales
- presence du schema SQL

## Reste a faire pour un niveau production complet

- observabilite complete (Prometheus, Grafana, traces distribuees)
- durcissement securite (rate limiting, gestion centralisee des secrets, TLS/mTLS)
- tests auto supplementaires (non-regression, charge continue en CI)
- deploiement K8s/Helm et strategie canary/rollback
