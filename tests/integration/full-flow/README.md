# Test integration flow complet

Ce test valide le scenario bout en bout:

1. creation admin + user
2. login admin + user
3. creation evenement
4. reservation de place
5. creation commande
6. paiement simule
7. billet genere

## Execution

1. Demarrer la stack:

./scripts/dev-up.sh

2. Lancer le test:

node tests/integration/full-flow/run-full-flow.js

## Variables utiles

- BASE_URL (defaut: http://localhost:8080)
- ADMIN_BOOTSTRAP_TOKEN (defaut: bootstrap-admin)
