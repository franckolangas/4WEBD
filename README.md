# 🎟️ Ticketing SaaS – Architecture Microservices

Plateforme de billetterie conçue en architecture microservices, capable de gérer des scénarios réels de forte concurrence (anti-survente).

## 🚀 Points clés

- Architecture microservices complète (auth, user, event, inventory, order, payment, notification)
- Gestion de la concurrence avec **anti-survente validée en conditions réelles**
- Communication asynchrone avec **RabbitMQ**
- API Gateway avec **Nginx**
- Tests d’intégration et tests de charge (k6)
- Déploiement via **Docker Compose**

## 📊 Résultats

- ✔️ Flux complet validé : inscription → achat → paiement → ticket
- ✔️ Test de concurrence :  
  - 30 tentatives  
  - 5 succès  
  - 25 conflits  
  - ❌ aucune survente

## 🧠 Ce que j’ai appris

- conception d’architectures distribuées
- gestion de la concurrence et des transactions
- design d’API REST robustes
- communication asynchrone (event-driven)
- mise en place de tests réalistes

## 🛠️ Stack

Node.js, PostgreSQL, RabbitMQ, Docker, Nginx, OpenAPI, k6

## 🏗️ Architecture

Client → Gateway (Nginx) → Microservices → PostgreSQL + RabbitMQ
