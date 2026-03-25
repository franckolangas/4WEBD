# Architecture microservices ticketing SaaS

## 1. Vue d'ensemble

Le systeme est compose de services independants deployables separement:

- API Gateway
- Auth Service
- User Service
- Event Service
- Inventory Service
- Order Service
- Payment Service (simulation)
- Notification Service (simulation)

Flux principal achat:

1. L'utilisateur s'authentifie (JWT).
2. Il cree une reservation temporaire de places via Inventory Service.
3. Il cree une commande via Order Service.
4. Payment Service simule le paiement.
5. Si paiement OK, reservation confirmee et billets emis.
6. Notification Service envoie un email/SMS simule de facon asynchrone.

## 2. Separation des responsabilites

### API Gateway

- Point d'entree unique
- Terminaison TLS
- Verification JWT (selon politique)
- Rate limiting
- Routage vers services internes

### Auth Service

- Login/register/refresh/logout
- Gestion hash mot de passe
- Emission JWT + refresh token

### User Service

- CRUD utilisateurs
- Profils, roles, langues (fr/en)

### Event Service

- CRUD evenements
- Publication/fermeture evenement
- Capacite declarative

### Inventory Service (coeur anti-survente)

- Verite du stock
- Reservation atomique avec TTL
- Confirmation/liberation reservation

### Order Service

- Creation et suivi commandes
- Lien commande <-> reservation
- Emission billets lies a user_id

### Payment Service (simule)

- Simulation resultat paiement (success/declined/timeout)
- Journalisation technique

### Notification Service (asynchrone)

- Consommation events metier
- Simulation envoi email/SMS
- Retry + dead letter queue

## 3. Persistance et messaging

- PostgreSQL: donnees metier relationnelles
- Redis: cache, TTL, locks courts
- RabbitMQ: evenements asynchrones metier

Chaque service possede son schema ou sa base dediee.

## 4. Anti-survente

Mecanisme recommande:

1. Inventory Service ouvre transaction SQL.
2. `SELECT ... FOR UPDATE` sur l'evenement.
3. Verification `available_capacity >= quantity`.
4. Decrementation atomique stock.
5. Creation reservation PENDING avec `expires_at`.
6. Commit.

Un job periodique expire les reservations depassees et restitue le stock.

## 5. Scalabilite

- Horizontal scaling des services stateless
- HPA sur Gateway, Inventory, Order
- Cache lecture du catalogue evenement
- Files d'attente asynchrones pour notifications
- Circuit breaker/timeout/retry pour services sensibles

## 6. Securite

- Hash mot de passe Argon2id
- JWT court + refresh token
- RBAC: ADMIN, EVENT_CREATOR, USER
- Validation stricte input API
- Journal audit des actions sensibles
- Chiffrement au repos et en transit

## 7. Observabilite

- Logs JSON structures (trace_id, user_id, order_id)
- Metrics Prometheus (latence p95, erreurs, debit)
- Traces distribuees OpenTelemetry
- Alerting sur saturation, erreurs, timeout paiement

## 8. SLA cible

- Latence cible p95 <= 300 ms sur endpoints critiques
- Zero survente
- Degradation controlee en cas de pic
