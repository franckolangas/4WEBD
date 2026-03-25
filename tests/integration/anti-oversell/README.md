# Test d'integration anti-survente

Ce test valide qu'un evenement ne depasse jamais sa capacite meme en pic de charge.

## Principe

- Plusieurs utilisateurs tentent de reserver 1 place simultanement.
- L'API doit retourner:
  - 201 lorsque la reservation est acceptee.
  - 409 lorsque le stock est epuise.
- On ne doit jamais observer de stock negatif.

## Prerequis

1. Service inventory operationnel.
2. Evenement de test cree avec une capacite connue (ex: 100 places).
3. Token utilisateur valide pour les appels API.

## Variables d'environnement

- BASE_URL: URL API gateway, ex: http://localhost:8080
- EVENT_ID: UUID evenement de test
- USER_TOKEN: JWT de test

## Execution

k6 run tests/integration/anti-oversell/k6-booking-spike.js

## Validation attendue

1. Nombre de reservations 201 <= capacite evenement.
2. Reponses excedentaires en 409 uniquement.
3. Aucune incoherence de stock en base.

## Verification SQL recommandee

Apres test:

SELECT id, total_capacity, available_capacity
FROM events
WHERE id = '<EVENT_ID>';

Le resultat doit respecter:

available_capacity = total_capacity - (nombre de reservations confirmees ou pending valides)
